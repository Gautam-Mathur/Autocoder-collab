import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { spawn, execSync } from 'child_process';
import { AVAILABLE_DEPS, DEV_DEPS } from './dependency-registry.js';

const CACHE_DIR = './cache';
const inProgressBuilds = new Set<string>();

const KEEP_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.css', '.wasm']);
const BINARY_EXTENSIONS = new Set(['.wasm', '.node']);
const SKIP_EXTENSIONS = new Set(['.map', '.md', '.txt', '.html', '.png', '.jpg', '.svg', '.gif', '.ico', '.d.ts', '.d.mts', '.d.cts', '.flow', '.lock', '.log', '.yaml', '.yml', '.ts', '.tsx', '.jsx']);
const SKIP_DIRS = new Set([
  'test', 'tests', '__tests__', '__mocks__', '__fixtures__', 'fixture', 'fixtures',
  '.cache', 'example', 'examples', 'benchmark', 'benchmarks', 'docs', 'doc',
  'coverage', '.nyc_output', 'umd', 'esm5', 'cjs5',
  'demo', 'demos', 'samples', 'scripts',
  '.github', '.vscode', '.idea', 'typedoc', 'website', 'site',
  'locale', 'locales', 'i18n', 'lang', 'languages',
]);
const SKIP_FILES = new Set([
  'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md',
  'CHANGELOG.md', 'CHANGELOG', 'CHANGES.md', 'HISTORY.md',
  'README.md', 'README', 'readme.md', 'CONTRIBUTING.md',
  '.npmignore', '.eslintrc', '.eslintrc.js', '.eslintrc.json',
  '.prettierrc', '.prettierrc.js', 'tsconfig.json', 'tslint.json',
  '.babelrc', 'babel.config.js', 'jest.config.js', 'vitest.config.js',
  'rollup.config.js', 'rollup.config.mjs', 'webpack.config.js',
  'Makefile', 'Gruntfile.js', 'Gulpfile.js',
  'esbuild.wasm',
]);

const KNOWN_BAD_PACKAGES = new Set([
  'auto-animate',
  'cuid2',
  'react-image-lightbox',
  'liquid',
  'paypal-js',
  'better-sqlite3',
  'bcrypt',
  'argon2',
  'sharp',
  'flagsmith',
  'cuid',
  'react-beautiful-dnd',
  'lucia',
  'react-tsparticles',
  'tsparticles-slim',
  'plausible-tracker',
]);

const MAX_CHUNK_DECOMPRESSED = 200 * 1024 * 1024;

const PACKAGE_RENAMES: Record<string, string> = {
  'auto-animate': '@formkit/auto-animate',
  'cuid2': '@paralleldrive/cuid2',
  'react-image-lightbox': 'yet-another-react-lightbox',
  'liquid': 'liquidjs',
  'paypal-js': '@paypal/paypal-js',
  'better-sqlite3': 'sql.js',
  'bcrypt': 'bcryptjs',
  'argon2': 'bcryptjs',
  'sharp': 'jimp',
  'flagsmith': '@flagsmith/flagsmith',
  'cuid': '@paralleldrive/cuid2',
  'react-beautiful-dnd': '@hello-pangea/dnd',
  'react-tsparticles': '@tsparticles/react',
  'tsparticles-slim': '@tsparticles/slim',
};

function shouldSkipPath(relPath: string, fileName: string): boolean {
  const parts = relPath.split(path.sep);
  for (const part of parts) {
    if (SKIP_DIRS.has(part.toLowerCase())) return true;
  }
  if (SKIP_FILES.has(fileName)) return true;
  if (relPath.endsWith('.d.ts') || relPath.endsWith('.d.mts') || relPath.endsWith('.d.cts')) return true;
  const ext = path.extname(relPath).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return true;
  if (!KEEP_EXTENSIONS.has(ext) && ext !== '') return true;
  return false;
}

interface FileSystemTree {
  [key: string]: FileNode | DirectoryNode;
}
interface FileNode {
  file: { contents: string | Uint8Array };
}
interface DirectoryNode {
  directory: FileSystemTree;
}

function buildTree(baseDir: string): FileSystemTree {
  const tree: FileSystemTree = {};
  const resolvedBaseDir = fs.realpathSync(baseDir);
  const visitedDirs = new Set<string>();

  function isWithinBase(resolvedPath: string): boolean {
    return resolvedPath.startsWith(resolvedBaseDir + path.sep) || resolvedPath === resolvedBaseDir;
  }

  function walk(dir: string, node: FileSystemTree) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relFromBase = path.relative(baseDir, fullPath);

      if (entry.isSymbolicLink()) {
        try {
          const realPath = fs.realpathSync(fullPath);
          if (!isWithinBase(realPath)) continue;
          const realStat = fs.statSync(realPath);
          if (realStat.isDirectory()) {
            if (visitedDirs.has(realPath)) continue;
            if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
            visitedDirs.add(realPath);
            const child: FileSystemTree = {};
            node[entry.name] = { directory: child };
            walk(realPath, child);
            if (Object.keys(child).length === 0) {
              delete node[entry.name];
            }
          } else if (realStat.isFile()) {
            const realRel = path.relative(baseDir, fullPath);
            if (shouldSkipPath(realRel, entry.name)) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (BINARY_EXTENSIONS.has(ext)) {
              const contents = new Uint8Array(fs.readFileSync(realPath));
              node[entry.name] = { file: { contents } };
            } else {
              const contents = fs.readFileSync(realPath, 'utf-8');
              node[entry.name] = { file: { contents } };
            }
          }
        } catch {
        }
      } else if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        const child: FileSystemTree = {};
        node[entry.name] = { directory: child };
        walk(fullPath, child);
        if (Object.keys(child).length === 0) {
          delete node[entry.name];
        }
      } else if (entry.isFile()) {
        if (shouldSkipPath(relFromBase, entry.name)) continue;
        try {
          const ext = path.extname(entry.name).toLowerCase();
          if (BINARY_EXTENSIONS.has(ext)) {
            const contents = new Uint8Array(fs.readFileSync(fullPath));
            node[entry.name] = { file: { contents } };
          } else {
            const contents = fs.readFileSync(fullPath, 'utf-8');
            node[entry.name] = { file: { contents } };
          }
        } catch {
        }
      }
    }
  }

  walk(baseDir, tree);
  return tree;
}

export interface UpgradeResult {
  packageJson: any;
  removedPackages: string[];
  renamedPackages: Array<{ from: string; to: string }>;
  upgradedVersions: Array<{ pkg: string; from: string; to: string }>;
  warnings: string[];
}

export function upgradePackageJson(input: string | object): UpgradeResult {
  const pkgJson = typeof input === 'string' ? JSON.parse(input) : JSON.parse(JSON.stringify(input));
  const removedPackages: string[] = [];
  const renamedPackages: Array<{ from: string; to: string }> = [];
  const upgradedVersions: Array<{ pkg: string; from: string; to: string }> = [];
  const warnings: string[] = [];

  const registryLookup: Record<string, string> = { ...AVAILABLE_DEPS, ...DEV_DEPS };

  function processSection(section: Record<string, string> | undefined, sectionName: string): Record<string, string> | undefined {
    if (!section || typeof section !== 'object') return section;

    const cleaned: Record<string, string> = {};

    for (const [pkg, version] of Object.entries(section)) {
      if (KNOWN_BAD_PACKAGES.has(pkg)) {
        removedPackages.push(pkg);

        const renamed = PACKAGE_RENAMES[pkg];
        if (renamed && !section[renamed] && !cleaned[renamed]) {
          const canonicalVersion = registryLookup[renamed];
          if (canonicalVersion) {
            cleaned[renamed] = canonicalVersion;
            renamedPackages.push({ from: pkg, to: renamed });
          } else {
            warnings.push(`Rename target "${renamed}" not in registry — skipped rename from "${pkg}"`);
          }
        }
        continue;
      }

      const canonicalVersion = registryLookup[pkg];
      if (canonicalVersion && canonicalVersion !== version) {
        cleaned[pkg] = canonicalVersion;
        upgradedVersions.push({ pkg, from: version, to: canonicalVersion });
      } else {
        cleaned[pkg] = version;
        if (!canonicalVersion && !pkg.startsWith('@types/')) {
          const msg = `Package "${pkg}" not in registry — kept as-is with version "${version}"`;
          warnings.push(msg);
          console.warn(`[UpgradePackageJson] ${msg}`);
        }
      }
    }

    return cleaned;
  }

  pkgJson.dependencies = processSection(pkgJson.dependencies, 'dependencies');
  pkgJson.devDependencies = processSection(pkgJson.devDependencies, 'devDependencies');

  if (removedPackages.length > 0) {
    console.log(`[UpgradePackageJson] Removed ${removedPackages.length} bad packages: ${removedPackages.join(', ')}`);
  }
  if (renamedPackages.length > 0) {
    console.log(`[UpgradePackageJson] Renamed ${renamedPackages.length} packages: ${renamedPackages.map(r => `${r.from} → ${r.to}`).join(', ')}`);
  }
  if (upgradedVersions.length > 0) {
    console.log(`[UpgradePackageJson] Upgraded ${upgradedVersions.length} package versions`);
  }

  return {
    packageJson: pkgJson,
    removedPackages,
    renamedPackages,
    upgradedVersions,
    warnings,
  };
}

function parseFailedPackagesFromStderr(stderr: string): string[] {
  const failed = new Set<string>();

  const notFoundPatterns = [
    /npm ERR! 404\s+'((?:@[^/]+\/)?[^'@]+)@[^']*' is not in (?:this|the npm) registry/g,
    /npm ERR! 404\s+Not Found[^:]*:\s*((?:@[^/\s]+\/)?[^\s@]+)@/g,
    /npm ERR! code E404[^]*?npm ERR! 404\s+'?((?:@[^/\s]+\/)?[^'\s@]+)@/g,
    /npm ERR! notarget No matching version found for ((?:@[^/\s]+\/)?[^\s@]+)@/g,
    /npm ERR! peer dep missing: ((?:@[^/\s,]+\/)?[^\s@,]+)@/g,
    /Could not resolve dependency:.*\n.*npm ERR!\s+peer\s+((?:@[^/\s]+\/)?[^\s@]+)@/g,
    /ERESOLVE[^]*?While resolving:\s*((?:@[^/\s]+\/)?[^\s@]+)@/g,
  ];

  for (const pattern of notFoundPatterns) {
    let match;
    while ((match = pattern.exec(stderr)) !== null) {
      const pkg = match[1].trim();
      if (pkg && !pkg.startsWith('npm') && pkg.length < 100) {
        failed.add(pkg);
      }
    }
  }

  return Array.from(failed);
}

async function runNpmInstall(tmpDir: string, label: string, ignoreScripts = false, extraArgs: string[] = []): Promise<{ success: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const args = [
      'install',
      '--no-audit',
      '--no-fund',
      '--omit=optional',
      '--legacy-peer-deps',
      '--prefer-offline',
      '--loglevel=warn',
      '--maxsockets=3',
      ...extraArgs,
    ];
    if (ignoreScripts) args.push('--ignore-scripts');
    const { NODE_OPTIONS: _no, ...cleanEnv } = process.env;
    const proc = spawn('npm', args, {
      cwd: tmpDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...cleanEnv, NODE_OPTIONS: '--max-old-space-size=768' },
    });

    let stderr = '';
    let stdout = '';
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ success: false, stderr: stderr + '\nnpm install timed out after 10 minutes' });
    }, 600000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        console.error(`[SnapshotBuilder] [${label}] npm exited with code ${code}`);
        if (stdout) console.error(`[SnapshotBuilder] [${label}] npm stdout (last 1000):\n${stdout.slice(-1000)}`);
      }
      resolve({ success: code === 0, stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[SnapshotBuilder] [${label}] npm spawn error:`, err);
      resolve({ success: false, stderr: stderr + `\nSpawn error: ${err.message}` });
    });
  });
}

function streamTreeToGzip(node: FileSystemTree, gzipStream: zlib.Gzip): void {
  const keys = Object.keys(node);
  gzipStream.write('{');
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = node[key];
    if (i > 0) gzipStream.write(',');
    gzipStream.write(JSON.stringify(key) + ':');
    if ('file' in value) {
      const contents = value.file.contents;
      if (typeof contents === 'string') {
        gzipStream.write('{"file":{"contents":' + JSON.stringify(contents) + '}}');
      } else {
        const b64 = Buffer.from(contents as Uint8Array).toString('base64');
        gzipStream.write('{"file":{"contents":{"__binary__":' + JSON.stringify(b64) + '}}}');
      }
    } else if ('directory' in value) {
      gzipStream.write('{"directory":');
      streamTreeToGzip(value.directory, gzipStream);
      gzipStream.write('}');
    }
  }
  gzipStream.write('}');
}

async function streamJsonGzip(tree: FileSystemTree, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const gzipStream = zlib.createGzip({ level: 6 });
    const fileStream = fs.createWriteStream(outputPath);
    gzipStream.pipe(fileStream);

    gzipStream.on('error', reject);
    fileStream.on('error', reject);
    fileStream.on('finish', resolve);

    streamTreeToGzip(tree, gzipStream);
    gzipStream.end();
  });
}

async function runNpmInstallAndSnapshot(tmpDir: string, snapshotPath: string, packageJsonContent: string, label: string, ignoreScripts = false): Promise<void> {
  const startTime = Date.now();

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(tmpDir, { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'package.json'), packageJsonContent, 'utf-8');

    console.log(`[SnapshotBuilder] [${label}] Running npm install in ${tmpDir}...`);

    let result = await runNpmInstall(tmpDir, label, ignoreScripts);

    if (!result.success) {
      const failedPkgs = parseFailedPackagesFromStderr(result.stderr);

      if (failedPkgs.length > 0) {
        console.warn(`[SnapshotBuilder] [${label}] npm install failed. Retrying without ${failedPkgs.length} bad packages: ${failedPkgs.join(', ')}`);

        const pkgJson = JSON.parse(packageJsonContent);
        for (const pkg of failedPkgs) {
          if (pkgJson.dependencies) delete pkgJson.dependencies[pkg];
          if (pkgJson.devDependencies) delete pkgJson.devDependencies[pkg];
        }

        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf-8');

        console.log(`[SnapshotBuilder] [${label}] Retry npm install without bad packages...`);
        result = await runNpmInstall(tmpDir, label, ignoreScripts);

        if (!result.success) {
          throw new Error(`npm install retry failed: ${result.stderr.slice(-500)}`);
        }

        console.log(`[SnapshotBuilder] [${label}] Retry succeeded (dropped ${failedPkgs.length} packages)`);
      } else {
        throw new Error(`npm install failed with no parseable bad packages: ${result.stderr.slice(-500)}`);
      }
    }

    console.log(`[SnapshotBuilder] [${label}] npm install done in ${Date.now() - startTime}ms, building FileSystemTree...`);

    const nodeModulesDir = path.join(tmpDir, 'node_modules');
    if (!fs.existsSync(nodeModulesDir)) {
      throw new Error('node_modules not found after npm install');
    }

    patchRollupForWebContainer(nodeModulesDir);

    const tree = buildTree(nodeModulesDir);
    const fullTree: FileSystemTree = { node_modules: { directory: tree } };

    console.log(`[SnapshotBuilder] [${label}] Tree built, streaming to compressed snapshot...`);

    const tmpSnapshot = snapshotPath + '.tmp';
    await streamJsonGzip(fullTree, tmpSnapshot);
    fs.renameSync(tmpSnapshot, snapshotPath);

    const stat = fs.statSync(snapshotPath);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SnapshotBuilder] [${label}] Snapshot saved: ${snapshotPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB compressed) in ${elapsed}s`);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[SnapshotBuilder] [${label}] Build failed after ${elapsed}s:`, err);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

export function buildSnapshotAsync(hash: string, packageJsonContent: string): void {
  const snapshotPath = path.join(CACHE_DIR, `snapshot-${hash}.json.gz`);

  if (fs.existsSync(snapshotPath)) {
    console.log(`[SnapshotBuilder] Snapshot already exists for hash ${hash}, skipping`);
    return;
  }

  if (inProgressBuilds.has(hash)) {
    console.log(`[SnapshotBuilder] Already building snapshot for hash ${hash}, skipping`);
    return;
  }

  inProgressBuilds.add(hash);

  const tmpDir = path.join('/tmp', `snapshot-${hash}`);
  runNpmInstallAndSnapshot(tmpDir, snapshotPath, packageJsonContent, `project:${hash}`, true)
    .catch((err) => {
      console.error(`[SnapshotBuilder] Snapshot build failed for hash ${hash}:`, err);
    })
    .finally(() => { inProgressBuilds.delete(hash); });
}

export function getSnapshotStatus(hash: string): 'ready' | 'building' | 'not-found' {
  const snapshotPath = path.join(CACHE_DIR, `snapshot-${hash}.json.gz`);
  if (fs.existsSync(snapshotPath)) return 'ready';
  if (inProgressBuilds.has(hash)) return 'building';
  return 'not-found';
}

const PREWARM_SNAPSHOT_PATH = path.join(CACHE_DIR, 'snapshot-prewarm.json.gz');
const PREWARM_MANIFEST_PATH = path.join(CACHE_DIR, 'prewarm-manifest.json');
let prewarmBuildInProgress = false;
let prewarmBuildEverCalled = false;

function getPrewarmDeps(): { deps: Record<string, string>; devDeps: Record<string, string> } {
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {};

  for (const [pkg, version] of Object.entries(AVAILABLE_DEPS)) {
    if (!KNOWN_BAD_PACKAGES.has(pkg)) {
      deps[pkg] = version;
    }
  }

  for (const [pkg, version] of Object.entries(DEV_DEPS)) {
    devDeps[pkg] = version;
  }

  return { deps, devDeps };
}

function estimateTreeSize(tree: FileSystemTree): number {
  let size = 2;
  for (const [key, value] of Object.entries(tree)) {
    size += key.length + 10;
    if ('file' in value) {
      const c = value.file.contents;
      size += typeof c === 'string' ? c.length * 1.1 : (c as Uint8Array).length * 3;
    } else if ('directory' in value) {
      size += estimateTreeSize(value.directory);
    }
  }
  return size;
}

function splitTreeIntoChunks(tree: FileSystemTree): FileSystemTree[] {
  const chunks: FileSystemTree[] = [];
  let currentChunk: FileSystemTree = {};
  let currentSize = 0;

  const topLevelKeys = Object.keys(tree).sort();

  for (const key of topLevelKeys) {
    const entry = tree[key];
    const entrySize = 'directory' in entry ? estimateTreeSize(entry.directory) : ('file' in entry ? (typeof entry.file.contents === 'string' ? entry.file.contents.length : 100) : 100);

    if (currentSize > 0 && currentSize + entrySize > MAX_CHUNK_DECOMPRESSED) {
      chunks.push(currentChunk);
      currentChunk = {};
      currentSize = 0;
    }

    currentChunk[key] = entry;
    currentSize += entrySize;
  }

  if (Object.keys(currentChunk).length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function patchRollupForWebContainer(nodeModulesDir: string): void {
  const nativeJsPath = path.join(nodeModulesDir, 'rollup', 'dist', 'native.js');
  if (!fs.existsSync(nativeJsPath)) return;

  try {
    const original = fs.readFileSync(nativeJsPath, 'utf-8');
    if (original.includes('WEBCONTAINER_PATCHED')) return;

    const wasmNativePath = path.join(nodeModulesDir, '@rollup', 'wasm-node', 'dist', 'native.js');
    const hasWasmNative = fs.existsSync(wasmNativePath);

    const replacement = getRollupNativePatchContent(hasWasmNative);
    fs.writeFileSync(nativeJsPath, replacement, 'utf-8');
    console.log(`[SnapshotBuilder] Patched rollup/dist/native.js for WebContainer compatibility (wasmNative=${hasWasmNative})`);
  } catch (err) {
    console.warn(`[SnapshotBuilder] Failed to patch rollup native.js:`, err);
  }
}

function getRollupNativePatchContent(hasWasmNative: boolean): string {
  return `/* WEBCONTAINER_PATCHED */
'use strict';

var parse, parseAsync, xxhashBase64Url, xxhashBase36, xxhashBase16;
var _loaded = false;

${hasWasmNative ? `
// Strategy 1: Load @rollup/wasm-node's own native.js (WASM-based bindings)
if (!_loaded) {
  try {
    var _wasmNativePath = require('path').join(
      require('path').dirname(require.resolve('@rollup/wasm-node/package.json')),
      'dist', 'native.js'
    );
    var _wn = require(_wasmNativePath);
    parse = _wn.parse;
    parseAsync = _wn.parseAsync;
    xxhashBase64Url = _wn.xxhashBase64Url;
    xxhashBase36 = _wn.xxhashBase36;
    xxhashBase16 = _wn.xxhashBase16;
    _loaded = true;
  } catch (_e) {}
}
` : ''}

// Strategy 2: Try requiring @rollup/wasm-node as a package
if (!_loaded) {
  try {
    var _wn2 = require('@rollup/wasm-node');
    if (_wn2.parse) {
      parse = _wn2.parse;
      parseAsync = _wn2.parseAsync;
      xxhashBase64Url = _wn2.xxhashBase64Url;
      xxhashBase36 = _wn2.xxhashBase36;
      xxhashBase16 = _wn2.xxhashBase16;
      _loaded = true;
    }
  } catch (_e) {}
}

// Strategy 3: Pure JS fallback stubs (sufficient for Vite dev server)
if (!_loaded) {
  function _simpleHash(input) {
    if (typeof input === 'string') {
      var h = 5381;
      for (var i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
      return h;
    }
    if (input && input.length) {
      var h2 = 5381;
      for (var j = 0; j < input.length; j++) h2 = ((h2 << 5) + h2 + (input[j] || 0)) >>> 0;
      return h2;
    }
    return 0;
  }
  parse = function() { return { body: [], type: 'Module', start: 0, end: 0 }; };
  parseAsync = function(code, opts) { return Promise.resolve(parse(code, opts)); };
  xxhashBase64Url = function(input) { return _simpleHash(input).toString(36); };
  xxhashBase36 = function(input) { return _simpleHash(input).toString(36); };
  xxhashBase16 = function(input) { return _simpleHash(input).toString(16); };
}

module.exports = { parse: parse, parseAsync: parseAsync, xxhashBase64Url: xxhashBase64Url, xxhashBase36: xxhashBase36, xxhashBase16: xxhashBase16 };
`;
}

function getEsbuildBrowserShim(): string {
  return `/* WEBCONTAINER_PATCHED - esbuild browser-mode shim */
if (typeof self === 'undefined') globalThis.self = globalThis;
if (!globalThis.process) try { globalThis.process = require('process'); } catch(e) {}
try { Object.defineProperty(globalThis, 'crypto', { value: globalThis.crypto || require('crypto'), writable: true, configurable: true }); } catch(e) {}
var _esbuildWasmBrowser;
try { _esbuildWasmBrowser = require('esbuild-wasm/lib/browser'); } catch(e) {
  _esbuildWasmBrowser = require(require('path').join(
    require.resolve('esbuild-wasm/package.json'), '..', 'lib', 'browser.js'));
}
var _initPromise = null;
function _ensureInit() {
  if (!_initPromise) {
    _initPromise = (async () => {
      var fs = require('fs');
      var wasmPath = require('path').join(
        require.resolve('esbuild-wasm/package.json'), '..', 'esbuild.wasm');
      var wasmBytes = fs.readFileSync(wasmPath);
      var wasmModule = await WebAssembly.compile(wasmBytes);
      await _esbuildWasmBrowser.initialize({ wasmModule: wasmModule, worker: false });
    })();
  }
  return _initPromise;
}
function _wrap(fn) {
  return async function() { await _ensureInit(); return fn.apply(null, arguments); };
}
module.exports.build = _wrap(_esbuildWasmBrowser.build);
module.exports.context = _wrap(_esbuildWasmBrowser.context);
module.exports.transform = _wrap(_esbuildWasmBrowser.transform);
module.exports.formatMessages = _wrap(_esbuildWasmBrowser.formatMessages);
module.exports.analyzeMetafile = _wrap(_esbuildWasmBrowser.analyzeMetafile);
module.exports.buildSync = function() { throw new Error('buildSync not available in WebContainer WASM mode'); };
module.exports.transformSync = function() { throw new Error('transformSync not available in WebContainer WASM mode'); };
module.exports.formatMessagesSync = function() { throw new Error('formatMessagesSync not available in WebContainer WASM mode'); };
module.exports.analyzeMetafileSync = function() { throw new Error('analyzeMetafileSync not available in WebContainer WASM mode'); };
module.exports.initialize = function(opts) { return _ensureInit(); };
module.exports.stop = function() { _initPromise = null; try { _esbuildWasmBrowser.stop(); } catch(e) {} };
module.exports.version = _esbuildWasmBrowser.version;
`;
}

function patchEsbuildWasmBrowserJs(nodeModulesDir: string): void {
  const browserJsPaths = [
    path.join(nodeModulesDir, 'esbuild-wasm', 'lib', 'browser.js'),
    path.join(nodeModulesDir, 'vite', 'node_modules', 'esbuild-wasm', 'lib', 'browser.js'),
  ];

  for (const bjsPath of browserJsPaths) {
    if (!fs.existsSync(bjsPath)) {
      console.log(`[SnapshotBuilder] browser.js not found at: ${bjsPath}`);
      continue;
    }
    try {
      let code = fs.readFileSync(bjsPath, 'utf-8');
      if (code.includes('_oR=fs.read') && code.includes('_oRD=fs.readdir') && code.includes('_enoent')) continue;

      const elseBranch = code.indexOf('} else {\n    let onmessage = ((postMessage) =>');
      if (elseBranch === -1) {
        console.warn(`[SnapshotBuilder] Could not find else branch in ${bjsPath}`);
        continue;
      }

      let blobPart = code.substring(0, elseBranch);
      let inlinePart = code.substring(elseBranch);

      inlinePart = inlinePart.replace(
        'let fs = globalThis.fs;',
        'let fs = globalThis.fs; ' +
        'try{if(typeof require!=="undefined"){var _nfs=require("fs");' +
        'if(_nfs&&typeof _nfs.readdir==="function"){' +
        'Object.keys(_nfs).forEach(function(k){' +
        'if(typeof _nfs[k]==="function")fs[k]=_nfs[k].bind(_nfs);' +
        'else if(typeof _nfs[k]!=="undefined")fs[k]=_nfs[k];' +
        '});}}}catch(_e){} ' +
        'var _oR=fs.read,_oW=fs.write,_oWS=fs.writeSync;'
      );
      inlinePart = inlinePart.replace(
        'throw new Error("Bad write");',
        'return _oWS.call(fs,fd,buffer);'
      );
      inlinePart = inlinePart.replace(
        'throw new Error("Bad read");',
        'return _oR.call(fs,fd,buffer,offset,length,position,callback);'
      );
      const readdirPatch = 'var _oRD=fs.readdir;fs.readdir=function(p,cb){' +
        'try{_oRD.call(fs,p,function(e,r){' +
        'if(e){cb(null,[]);return;}cb(null,r);});}' +
        'catch(e){cb(null,[]);}' +
        '};\n        ';
      const writeIntercept = 'fs.write=function(fd,buf,off,len,pos,cb){' +
        'if(fd===1){postMessage(buf.slice(off,off+len));cb(null,len);return;}' +
        'if(fd===2){console.error(new TextDecoder().decode(buf.slice(off,off+len)));cb(null,len);return;}' +
        'return _oW.call(fs,fd,buf,off,len,pos,cb);' +
        '};\n        ';
      const enosysPatch =
        'function _enoent(){var e=new Error("ENOENT");e.code="ENOENT";return e;}\n        ' +
        'var _oOpen=fs.open;fs.open=function(p,flags,mode,cb){' +
        'if(typeof mode==="function"){cb=mode;mode=438;}' +
        'try{_oOpen.call(fs,p,flags,mode,function(e,fd){' +
        'if(e&&(e.code==="ENOSYS"||(e.message&&e.message.includes("not implemented")))){cb(_enoent());return;}' +
        'cb(e,fd);});}catch(e){cb(_enoent());}' +
        '};\n        ' +
        'var _oStat=fs.stat;fs.stat=function(p,cb){' +
        'try{_oStat.call(fs,p,function(e,r){' +
        'if(e&&(e.code==="ENOSYS"||(e.message&&e.message.includes("not implemented")))){cb(_enoent());return;}' +
        'cb(e,r);});}catch(e){cb(_enoent());}' +
        '};\n        ' +
        'var _oLstat=fs.lstat;fs.lstat=function(p,cb){' +
        'try{_oLstat.call(fs,p,function(e,r){' +
        'if(e&&(e.code==="ENOSYS"||(e.message&&e.message.includes("not implemented")))){cb(_enoent());return;}' +
        'cb(e,r);});}catch(e){cb(_enoent());}' +
        '};\n        ';
      inlinePart = inlinePart.replace(
        'let go = new globalThis.Go();',
        readdirPatch + writeIntercept + enosysPatch + 'let go = new globalThis.Go();'
      );

      fs.writeFileSync(bjsPath, blobPart + inlinePart, 'utf-8');
      const relPath = path.relative(nodeModulesDir, bjsPath);
      console.log(`[SnapshotBuilder] Patched ${relPath} with fs.read/write/writeSync fallbacks`);
    } catch (err) {
      console.warn(`[SnapshotBuilder] Failed to patch browser.js at ${bjsPath}:`, err);
    }
  }
}

function patchEsbuildForWebContainer(nodeModulesDir: string): void {
  const esbuildDirs = [
    path.join(nodeModulesDir, 'esbuild', 'lib'),
    path.join(nodeModulesDir, 'vite', 'node_modules', 'esbuild', 'lib'),
  ];

  const shimContent = getEsbuildBrowserShim();

  for (const libDir of esbuildDirs) {
    const mainJsPath = path.join(libDir, 'main.js');
    if (!fs.existsSync(mainJsPath)) continue;

    try {
      const original = fs.readFileSync(mainJsPath, 'utf-8');
      if (original.includes('WEBCONTAINER_PATCHED')) continue;

      fs.writeFileSync(mainJsPath, shimContent, 'utf-8');
      const relPath = path.relative(nodeModulesDir, mainJsPath);
      console.log(`[SnapshotBuilder] Replaced ${relPath} with browser-mode esbuild-wasm shim`);
    } catch (err) {
      console.warn(`[SnapshotBuilder] Failed to patch esbuild main.js at ${mainJsPath}:`, err);
    }
  }
}

async function buildPrewarmChunks(tmpDir: string, label: string, ignoreScripts: boolean): Promise<void> {
  const nodeModulesDir = path.join(tmpDir, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    throw new Error('node_modules not found after npm install');
  }

  patchRollupForWebContainer(nodeModulesDir);
  patchEsbuildForWebContainer(nodeModulesDir);
  patchEsbuildWasmBrowserJs(nodeModulesDir);

  const esbuildWasmSrc = path.join(nodeModulesDir, 'esbuild-wasm', 'esbuild.wasm');
  if (fs.existsSync(esbuildWasmSrc)) {
    const dest = path.join(CACHE_DIR, 'esbuild.wasm');
    fs.copyFileSync(esbuildWasmSrc, dest);
    console.log(`[SnapshotBuilder] Copied esbuild.wasm to cache (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
  }

  const tree = buildTree(nodeModulesDir);
  console.log(`[SnapshotBuilder] [${label}] Tree built, estimating chunk sizes...`);

  const chunks = splitTreeIntoChunks(tree);
  console.log(`[SnapshotBuilder] [${label}] Split into ${chunks.length} chunks`);

  const chunkFiles: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkPath = path.join(CACHE_DIR, `snapshot-prewarm-${i}.json.gz`);
    const fullTree: FileSystemTree = { node_modules: { directory: chunks[i] } };
    const tmpChunk = chunkPath + '.tmp';
    await streamJsonGzip(fullTree, tmpChunk);
    fs.renameSync(tmpChunk, chunkPath);
    const stat = fs.statSync(chunkPath);
    console.log(`[SnapshotBuilder] [${label}] Chunk ${i}: ${(stat.size / 1024 / 1024).toFixed(1)} MB compressed`);
    chunkFiles.push(`snapshot-prewarm-${i}.json.gz`);
  }

  const oldChunks = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith('snapshot-prewarm-') && f.endsWith('.json.gz'));
  for (const f of oldChunks) {
    if (!chunkFiles.includes(f)) {
      try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {}
    }
  }

  const manifest = { chunks: chunkFiles, timestamp: Date.now() };
  fs.writeFileSync(PREWARM_MANIFEST_PATH, JSON.stringify(manifest));

  const singleTree: FileSystemTree = { node_modules: { directory: tree } };
  const tmpSingle = PREWARM_SNAPSHOT_PATH + '.tmp';
  await streamJsonGzip(singleTree, tmpSingle);
  fs.renameSync(tmpSingle, PREWARM_SNAPSHOT_PATH);
  const singleStat = fs.statSync(PREWARM_SNAPSHOT_PATH);
  console.log(`[SnapshotBuilder] [${label}] Full snapshot: ${(singleStat.size / 1024 / 1024).toFixed(1)} MB compressed (for project builds)`);
}

export function buildPrewarmSnapshot(force = false): void {
  prewarmBuildEverCalled = true;
  if (!force && fs.existsSync(PREWARM_MANIFEST_PATH)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(PREWARM_MANIFEST_PATH, 'utf-8'));
      const allChunksExist = manifest.chunks?.every((f: string) => {
        const p = path.join(CACHE_DIR, f);
        return fs.existsSync(p) && isValidSnapshot(p);
      });
      if (allChunksExist) {
        const ageHours = (Date.now() - manifest.timestamp) / (1000 * 60 * 60);
        if (ageHours < 24) {
          const totalSize = manifest.chunks.reduce((sum: number, f: string) => {
            try { return sum + fs.statSync(path.join(CACHE_DIR, f)).size; } catch { return sum; }
          }, 0);
          console.log(`[SnapshotBuilder] Prewarm chunks exist (${manifest.chunks.length} chunks, ${(totalSize / 1024 / 1024).toFixed(1)} MB total, ${ageHours.toFixed(1)}h old), skipping rebuild`);
          prewarmBuildInProgress = false;
          return;
        }
        console.log(`[SnapshotBuilder] Prewarm chunks are ${ageHours.toFixed(1)}h old, rebuilding...`);
      }
    } catch {}
  }

  if (prewarmBuildInProgress) {
    console.log('[SnapshotBuilder] Prewarm snapshot build already in progress, skipping');
    return;
  }

  prewarmBuildInProgress = true;

  const { deps, devDeps } = getPrewarmDeps();
  const packageJson = JSON.stringify({
    name: 'prewarm-snapshot',
    private: true,
    dependencies: deps,
    devDependencies: devDeps,
  }, null, 2);

  const depCount = Object.keys(deps).length;
  const devDepCount = Object.keys(devDeps).length;
  console.log(`[SnapshotBuilder] Building prewarm snapshot with ${depCount} deps + ${devDepCount} devDeps...`);

  const tmpDir = path.join('/tmp', 'snapshot-prewarm');
  const startTime = Date.now();

  (async () => {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'package.json'), packageJson, 'utf-8');

      console.log(`[SnapshotBuilder] [prewarm] Running npm install in ${tmpDir}...`);
      let result = await runNpmInstall(tmpDir, 'prewarm', true);

      if (!result.success) {
        const failedPkgs = parseFailedPackagesFromStderr(result.stderr);
        if (failedPkgs.length > 0) {
          console.warn(`[SnapshotBuilder] [prewarm] npm install failed. Retrying without ${failedPkgs.length} bad packages: ${failedPkgs.join(', ')}`);
          const pkgJson = JSON.parse(packageJson);
          for (const pkg of failedPkgs) {
            if (pkgJson.dependencies) delete pkgJson.dependencies[pkg];
            if (pkgJson.devDependencies) delete pkgJson.devDependencies[pkg];
          }
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
          fs.mkdirSync(tmpDir, { recursive: true });
          fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf-8');
          result = await runNpmInstall(tmpDir, 'prewarm', true);
          if (!result.success) throw new Error(`npm install retry failed: ${result.stderr.slice(-500)}`);
        } else {
          console.error(`[SnapshotBuilder] [prewarm] npm stderr:\n${result.stderr.slice(-2000)}`);
          throw new Error(`npm install failed: ${result.stderr.slice(-500)}`);
        }
      }

      console.log(`[SnapshotBuilder] [prewarm] npm install done in ${Date.now() - startTime}ms`);

      // Install WASM fallback packages separately — avoids OOM from main install
      // For esbuild-wasm: install at Vite's nested esbuild version (if different from top-level),
      // since Vite is the primary consumer. The version-check in the patch ensures the top-level
      // esbuild won't use a mismatched esbuild-wasm.
      const topEsbuildPkgPath = path.join(tmpDir, 'node_modules/esbuild/package.json');
      const viteEsbuildPkgPath = path.join(tmpDir, 'node_modules/vite/node_modules/esbuild/package.json');
      let esbuildWasmVer = 'latest';
      try {
        const topVer = JSON.parse(fs.readFileSync(topEsbuildPkgPath, 'utf-8')).version;
        let viteVer: string | null = null;
        try { viteVer = JSON.parse(fs.readFileSync(viteEsbuildPkgPath, 'utf-8')).version; } catch {}
        esbuildWasmVer = viteVer || topVer || 'latest';
        if (viteVer && viteVer !== topVer) {
          console.log(`[SnapshotBuilder] [prewarm] Vite esbuild@${viteVer} differs from top-level@${topVer}, using Vite version for esbuild-wasm`);
        }
      } catch {}

      const wasmPackages: { name: string; version: string }[] = [
        { name: 'esbuild-wasm', version: esbuildWasmVer },
        { name: '@rollup/wasm-node', version: (() => { try { return JSON.parse(fs.readFileSync(path.join(tmpDir, 'node_modules/rollup/package.json'), 'utf-8')).version; } catch { return 'latest'; } })() },
      ];

      for (const { name, version } of wasmPackages) {
        try {
          console.log(`[SnapshotBuilder] [prewarm] Installing ${name}@${version}...`);
          const wasmResult = await runNpmInstall(tmpDir, `prewarm-${name}`, true, [`${name}@${version}`, '--no-save']);
          if (wasmResult.success) {
            const checkPath = path.join(tmpDir, 'node_modules', name, 'package.json');
            if (fs.existsSync(checkPath)) {
              console.log(`[SnapshotBuilder] [prewarm] ${name}@${version} installed successfully`);
            } else {
              console.warn(`[SnapshotBuilder] [prewarm] ${name}@${version} npm exited OK but package not found, retrying with save...`);
              const retryResult = await runNpmInstall(tmpDir, `prewarm-${name}-retry`, true, [`${name}@${version}`]);
              if (retryResult.success && fs.existsSync(checkPath)) {
                console.log(`[SnapshotBuilder] [prewarm] ${name}@${version} installed on retry with save`);
              } else {
                console.warn(`[SnapshotBuilder] [prewarm] ${name} retry also failed`);
              }
            }
          } else {
            console.warn(`[SnapshotBuilder] [prewarm] ${name} install failed (non-fatal): ${wasmResult.stderr.slice(-200)}`);
          }
        } catch (err) {
          console.warn(`[SnapshotBuilder] [prewarm] ${name} install skipped:`, err);
        }
      }

      const esbuildWasmBrowserJs = path.join(tmpDir, 'node_modules/esbuild-wasm/lib/browser.js');
      if (!fs.existsSync(esbuildWasmBrowserJs)) {
        console.log(`[SnapshotBuilder] [prewarm] browser.js missing after install, extracting via npm pack...`);
        try {
          const packOut = execSync(`npm pack esbuild-wasm@${esbuildWasmVer} --pack-destination /tmp`, { cwd: tmpDir, encoding: 'utf-8', timeout: 30000 }).trim();
          const tgzPath = packOut.split('\n').pop()!;
          const tgzFullPath = path.resolve('/tmp', tgzPath);
          const esbuildWasmDir = path.join(tmpDir, 'node_modules/esbuild-wasm');
          fs.mkdirSync(path.join(esbuildWasmDir, 'lib'), { recursive: true });
          fs.mkdirSync(path.join(esbuildWasmDir, 'esm'), { recursive: true });
          execSync(`tar xzf ${tgzFullPath} --strip-components=1 -C ${esbuildWasmDir}`, { timeout: 10000 });
          try { fs.unlinkSync(tgzFullPath); } catch {}
          if (fs.existsSync(esbuildWasmBrowserJs)) {
            console.log(`[SnapshotBuilder] [prewarm] browser.js extracted successfully`);
          } else {
            console.warn(`[SnapshotBuilder] [prewarm] browser.js still missing after extract`);
          }
        } catch (err) {
          console.warn(`[SnapshotBuilder] [prewarm] Failed to extract browser.js:`, err);
        }
      }

      console.log(`[SnapshotBuilder] [prewarm] Building FileSystemTree...`);
      await buildPrewarmChunks(tmpDir, 'prewarm', true);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[SnapshotBuilder] Prewarm snapshot build complete in ${elapsed}s`);

      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`[SnapshotBuilder] Prewarm snapshot build failed after ${elapsed}s:`, err);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    } finally {
      prewarmBuildInProgress = false;
    }
  })();
}

function isValidSnapshot(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 1024) return false;
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(2);
    fs.readSync(fd, header, 0, 2, 0);
    fs.closeSync(fd);
    return header[0] === 0x1f && header[1] === 0x8b;
  } catch {
    return false;
  }
}

export function getPrewarmSnapshotStatus(): 'ready' | 'building' | 'not-found' {
  if (prewarmBuildInProgress) return 'building';
  if (!prewarmBuildEverCalled) return 'building';
  if (fs.existsSync(PREWARM_MANIFEST_PATH)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(PREWARM_MANIFEST_PATH, 'utf-8'));
      if (manifest.chunks?.length > 0 && manifest.chunks.every((f: string) => {
        const p = path.join(CACHE_DIR, f);
        return fs.existsSync(p) && isValidSnapshot(p);
      })) {
        return 'ready';
      }
    } catch {}
  }
  if (fs.existsSync(PREWARM_SNAPSHOT_PATH) && isValidSnapshot(PREWARM_SNAPSHOT_PATH)) return 'ready';
  return 'not-found';
}

export function getPrewarmManifest(): { chunks: string[] } | null {
  if (!fs.existsSync(PREWARM_MANIFEST_PATH)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(PREWARM_MANIFEST_PATH, 'utf-8'));
    return manifest.chunks ? { chunks: manifest.chunks } : null;
  } catch {
    return null;
  }
}
