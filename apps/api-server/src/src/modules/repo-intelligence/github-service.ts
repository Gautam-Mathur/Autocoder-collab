/**
 * GitHub Service — fetches repository contents via the GitHub REST API
 *
 * Supports:
 *   - Parsing github.com URLs (owner/repo, branch, subdirectory)
 *   - Fetching directory trees (up to 1000 files via recursive tree API)
 *   - Fetching individual file contents (base64 decoded)
 *   - Rate-limit awareness (returns headers)
 *
 * Uses GITHUB_TOKEN env var if set (rate limit: 5000 req/hr vs 60 unauthenticated).
 */

export interface GitHubFile {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  sha: string;
  url?: string;
}

export interface GitHubRepoInfo {
  owner: string;
  repo: string;
  branch: string;
  subpath?: string;
  defaultBranch?: string;
  description?: string;
  language?: string;
  stars?: number;
}

export interface FetchedFile {
  path: string;
  content: string;
  size: number;
  language: string;
  isBinary: boolean;
}

const GITHUB_API = 'https://api.github.com';

// Max file size to fetch (300 KB) — skip binaries and large generated files
const MAX_FILE_BYTES = 300_000;

// File extensions to skip entirely
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.lock',
  '.pdf', '.docx', '.xlsx',
]);

function langFromPath(path: string): string {
  const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python', '.go': 'go', '.java': 'java', '.cs': 'csharp',
    '.rs': 'rust', '.rb': 'ruby', '.php': 'php',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
    '.md': 'markdown', '.txt': 'text', '.sh': 'shell',
    '.css': 'css', '.scss': 'scss', '.html': 'html',
    '.sql': 'sql', '.toml': 'toml', '.env': 'env',
  };
  return map[ext] ?? 'text';
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'AutoCoder-RepoIntelligence/1.0',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

// ── URL parser ─────────────────────────────────────────────────────────────

export function parseGitHubUrl(url: string): GitHubRepoInfo | null {
  // Handles:
  //   https://github.com/owner/repo
  //   https://github.com/owner/repo/tree/main/subpath
  //   https://github.com/owner/repo/blob/main/file.ts
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?/
  );
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, ''),
    branch: match[3] ?? 'HEAD',
    subpath: match[4],
  };
}

// ── Repo metadata ──────────────────────────────────────────────────────────

export async function fetchRepoInfo(owner: string, repo: string): Promise<GitHubRepoInfo> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: buildHeaders(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;

  return {
    owner,
    repo,
    branch: data.default_branch ?? 'main',
    defaultBranch: data.default_branch,
    description: data.description,
    language: data.language,
    stars: data.stargazers_count,
  };
}

// ── File tree ──────────────────────────────────────────────────────────────

export async function fetchFileTree(
  owner: string,
  repo: string,
  branch: string
): Promise<GitHubFile[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: buildHeaders(), signal: AbortSignal.timeout(15_000) }
  );

  if (!res.ok) throw new Error(`GitHub tree API error ${res.status}`);
  const data = await res.json() as any;

  return (data.tree ?? []) as GitHubFile[];
}

// ── File content ───────────────────────────────────────────────────────────

export async function fetchFileContent(
  owner: string,
  repo: string,
  path: string,
  branch: string
): Promise<FetchedFile | null> {
  const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return null;

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
    { headers: buildHeaders(), signal: AbortSignal.timeout(10_000) }
  );

  if (!res.ok) return null;
  const data = await res.json() as any;

  if (data.type !== 'file') return null;
  if ((data.size ?? 0) > MAX_FILE_BYTES) return null;

  const raw = data.content
    ? Buffer.from(data.content, 'base64').toString('utf8')
    : '';

  return {
    path: data.path,
    content: raw,
    size: data.size ?? 0,
    language: langFromPath(data.path),
    isBinary: false,
  };
}

// ── Batch fetch ────────────────────────────────────────────────────────────

const IMPORTANT_FILES = [
  'package.json', 'pom.xml', 'requirements.txt', 'go.mod',
  'README.md', 'Dockerfile', 'docker-compose.yml', '.env.example',
  'tsconfig.json', 'pyproject.toml',
];

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.cs',
  '.rb', '.php', '.rs', '.swift', '.kt',
]);

export async function fetchCriticalFiles(
  owner: string,
  repo: string,
  branch: string,
  tree: GitHubFile[],
  maxFiles = 50
): Promise<FetchedFile[]> {
  const blobFiles = tree.filter(f => f.type === 'blob' && f.path);

  // Prioritise: important root files → source files → others
  const prioritised = [
    ...blobFiles.filter(f => IMPORTANT_FILES.includes(f.path)),
    ...blobFiles.filter(f => {
      const ext = f.path.substring(f.path.lastIndexOf('.')).toLowerCase();
      return SOURCE_EXTS.has(ext) && !IMPORTANT_FILES.includes(f.path);
    }),
  ].slice(0, maxFiles);

  const results: FetchedFile[] = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < prioritised.length; i += CONCURRENCY) {
    const batch = prioritised.slice(i, i + CONCURRENCY);
    const fetched = await Promise.allSettled(
      batch.map(f => fetchFileContent(owner, repo, f.path, branch))
    );
    for (const r of fetched) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value);
    }
  }

  return results;
}
