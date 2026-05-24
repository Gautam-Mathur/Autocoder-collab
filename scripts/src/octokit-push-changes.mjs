#!/usr/bin/env node
// Focused Octokit push: only the files we actually changed, with the
// `AutoCoder/` workspace prefix STRIPPED so paths line up with the
// remote repo (whose root == our `AutoCoder/` subdir).
import { readFileSync, statSync, existsSync } from "node:fs";
import { Octokit } from "@octokit/rest";

const OWNER = "Gautam-Mathur";
const REPO = "AutoCoder";
const BRANCH = "main";
const COMMIT_MSG = [
  "Pipeline hardening: preservation guard, regex drain, relative URLs",
  "",
  "Implements 5 of 6 fixes from PLAN-pipeline-hardening-2026-05-16.md:",
  "1. PreservationGuard — refuse to overwrite >1 KB files with <50% stubs",
  "2. slm-repair / capture-failure use relative URLs (browser-safe)",
  "3. /api/repair/syntax regex-drain first-pass (no LLM required)",
  "4. drainKnownTypos in pre-mount sanitize + PreFlight 3-pass audit",
  "5. Sanitize logs name specific rules + audit residuals",
  "",
  "262/262 code-runner tests pass. See REPORT-pipeline-failure-2026-05-16.md",
  "for the failure analysis this addresses.",
].join("\n");

// (workspace-relative path, target-repo path).
// `null` target = use the same path with `AutoCoder/` prefix dropped.
const FILES = [
  ["AutoCoder/PLAN-pipeline-hardening-2026-05-16.md", null],
  ["AutoCoder/REPORT-pipeline-failure-2026-05-16.md", null],
  ["AutoCoder/replit.md", null],
  ["AutoCoder/artifacts/api-server/src/routes/repair.ts", null],
  ["AutoCoder/artifacts/api-server/src/src/routes/autocoder.ts", null],
  ["AutoCoder/artifacts/autocoder/src/lib/code-runner/auto-runner.ts", null],
  ["AutoCoder/artifacts/autocoder/src/lib/code-runner/slm-repair.ts", null],
  [
    "AutoCoder/artifacts/autocoder/src/lib/code-runner/template-basement-guard.ts",
    null,
  ],
  [
    "AutoCoder/artifacts/autocoder/src/lib/code-runner/template-basement-guard.test.ts",
    null,
  ],
  [
    "AutoCoder/artifacts/autocoder/src/lib/code-runner/three-layer-cascade.ts",
    null,
  ],
  // Captured-failure test fixture (the run that exposed the corruption).
  [
    "AutoCoder/artifacts/autocoder/src/lib/code-runner/__fixtures__/captured-2026-05-16T12-06-46-741Z-verify-gate-abort/manifest.json",
    null,
  ],
  [
    "AutoCoder/artifacts/autocoder/src/lib/code-runner/__fixtures__/captured-2026-05-16T12-06-46-741Z-verify-gate-abort/src/__tests__/components.test.ts",
    null,
  ],
  [
    "AutoCoder/artifacts/autocoder/src/lib/code-runner/__fixtures__/captured-2026-05-16T12-06-46-741Z-verify-gate-abort/src/__tests__/setup.ts",
    null,
  ],
  [
    "AutoCoder/artifacts/autocoder/src/lib/code-runner/__fixtures__/captured-2026-05-16T12-06-46-741Z-verify-gate-abort/src/components/data-table.tsx",
    null,
  ],
  [
    "AutoCoder/artifacts/autocoder/src/lib/code-runner/__fixtures__/captured-2026-05-16T12-06-46-741Z-verify-gate-abort/src/pages/project-detail-page.tsx",
    null,
  ],
  [
    "AutoCoder/artifacts/autocoder/src/lib/code-runner/__fixtures__/captured-2026-05-16T12-06-46-741Z-verify-gate-abort/src/pages/task-detail-page.tsx",
    null,
  ],
];

const stripPrefix = (p) =>
  p.startsWith("AutoCoder/") ? p.slice("AutoCoder/".length) : p;

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN env var required");
  process.exit(1);
}

process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED:", e?.status, e?.message);
  process.exit(2);
});

const octokit = new Octokit({ auth: token });

console.log(`Target: ${OWNER}/${REPO}@${BRANCH}`);
console.log(`Files to push: ${FILES.length}`);

console.log("Reading remote ref…");
const ref = await octokit.git.getRef({
  owner: OWNER,
  repo: REPO,
  ref: `heads/${BRANCH}`,
});
const parentSha = ref.data.object.sha;
console.log(`  parent commit ${parentSha}`);

// Read base tree from parent so unchanged files stay unchanged.
const parentCommit = await octokit.git.getCommit({
  owner: OWNER,
  repo: REPO,
  commit_sha: parentSha,
});
const baseTreeSha = parentCommit.data.tree.sha;
console.log(`  base tree   ${baseTreeSha}`);

console.log("Uploading blobs…");
const treeEntries = [];
for (const [src, dstOverride] of FILES) {
  const dst = dstOverride ?? stripPrefix(src);
  if (!existsSync(src)) {
    console.warn(`  SKIP missing: ${src}`);
    continue;
  }
  const buf = readFileSync(src);
  const isText = buf.length === 0 || !buf.includes(0);
  const resp = await octokit.git.createBlob({
    owner: OWNER,
    repo: REPO,
    content: isText ? buf.toString("utf8") : buf.toString("base64"),
    encoding: isText ? "utf-8" : "base64",
  });
  treeEntries.push({ path: dst, mode: "100644", type: "blob", sha: resp.data.sha });
  console.log(`  ✓ ${dst}  (${statSync(src).size}B → ${resp.data.sha.slice(0, 8)})`);
}

console.log(`Creating tree (${treeEntries.length} entries on top of base)…`);
const treeResp = await octokit.git.createTree({
  owner: OWNER,
  repo: REPO,
  base_tree: baseTreeSha,
  tree: treeEntries,
});
console.log(`  tree ${treeResp.data.sha}`);

console.log("Creating commit…");
const commitResp = await octokit.git.createCommit({
  owner: OWNER,
  repo: REPO,
  message: COMMIT_MSG,
  tree: treeResp.data.sha,
  parents: [parentSha],
});
console.log(`  commit ${commitResp.data.sha}`);

console.log(`Updating ref heads/${BRANCH}…`);
await octokit.git.updateRef({
  owner: OWNER,
  repo: REPO,
  ref: `heads/${BRANCH}`,
  sha: commitResp.data.sha,
  force: false,
});
console.log("Done.");
console.log(
  `https://github.com/${OWNER}/${REPO}/commit/${commitResp.data.sha}`,
);
