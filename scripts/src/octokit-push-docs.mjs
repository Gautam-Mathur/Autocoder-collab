#!/usr/bin/env node
import { readFileSync, statSync, existsSync } from "node:fs";
import { Octokit } from "@octokit/rest";

const OWNER = "Gautam-Mathur";
const REPO = "AutoCoder";
const BRANCH = "main";
const COMMIT_MSG = [
  "docs: RuFlo-only pipeline truth + per-agent dossiers",
  "",
  "- replit.md: API server port corrected 5000 -> 3001 (shared proxy /api/*)",
  "- DOCS.md §7: new 'Per-agent dossiers' section covering all 10 RuFlo",
  "  agents (file, wrapped legacy modules, prev-step inputs, mechanical",
  "  behavior, ExecutiveMemory output, ctx.* mutations, contract gates,",
  "  hand-off). Stage 15 row corrected to reflect the single auto-invoked",
  "  validateAndFix(ctx.files, 1) pass inside runPostRuFloEnhancements.",
  "  Auto-fix endpoint errorType union corrected to",
  "  'build'|'runtime'|'graph'|'unresolved-import' (no semantic branch).",
  "- README.md / DEVELOPMENT.md: same Stage 15 + errorType corrections;",
  "  Designer 'consumes' contract clarified as singular string per",
  "  component (validator checks coverage across the set).",
  "- docs/generation-workflow-reference.md: stages 14.5/14.6 retitled as",
  "  legacy reference (NOT auto-invoked in active RuFlo path); stage 15",
  "  marked partially auto-invoked with active-path callouts; pointer to",
  "  the new dossier section.",
  "",
  "Verified by architect rounds 5-10 against ruflo/agents/*.ts,",
  "executive-memory.ts, contract-validator.ts, sequential-controller.ts,",
  "pipeline-orchestrator.ts, and routes/autocoder.ts.",
].join("\n");

const FILES = [
  "AutoCoder/replit.md",
  "AutoCoder/README.md",
  "AutoCoder/DEVELOPMENT.md",
  "AutoCoder/DOCS.md",
  "AutoCoder/docs/generation-workflow-reference.md",
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

const ref = await octokit.git.getRef({
  owner: OWNER,
  repo: REPO,
  ref: `heads/${BRANCH}`,
});
const parentSha = ref.data.object.sha;
console.log(`  parent commit ${parentSha}`);

const parentCommit = await octokit.git.getCommit({
  owner: OWNER,
  repo: REPO,
  commit_sha: parentSha,
});
const baseTreeSha = parentCommit.data.tree.sha;
console.log(`  base tree   ${baseTreeSha}`);

const treeEntries = [];
for (const src of FILES) {
  const dst = stripPrefix(src);
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

const treeResp = await octokit.git.createTree({
  owner: OWNER,
  repo: REPO,
  base_tree: baseTreeSha,
  tree: treeEntries,
});
console.log(`  tree ${treeResp.data.sha}`);

const commitResp = await octokit.git.createCommit({
  owner: OWNER,
  repo: REPO,
  message: COMMIT_MSG,
  tree: treeResp.data.sha,
  parents: [parentSha],
});
console.log(`  commit ${commitResp.data.sha}`);

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
