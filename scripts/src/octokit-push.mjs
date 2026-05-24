#!/usr/bin/env node
// One-shot push of the working tree to GitHub via Octokit Git Data API.
// Reads GITHUB_TOKEN from env. Uses tracked files from `git ls-files`.
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
const ThrottledOctokit = Octokit.plugin(throttling);

const OWNER = "Gautam-Mathur";
const REPO = "AutoCoder";
const BRANCH = "main";
const COMMIT_MSG =
  "Sync pipeline-hardening fixes (preservation guard, regex drain, relative URLs)";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN env var required");
  process.exit(1);
}
const octokit = new ThrottledOctokit({
  auth: token,
  throttle: {
    onRateLimit: (retryAfter, options, _o, retryCount) => {
      console.warn(`  rate-limit: waiting ${retryAfter}s (retry ${retryCount})`);
      return retryCount < 5;
    },
    onSecondaryRateLimit: (retryAfter, options, _o, retryCount) => {
      console.warn(`  secondary-limit: waiting ${retryAfter}s (retry ${retryCount})`);
      return retryCount < 5;
    },
  },
});

process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED:", e?.status, e?.message);
  console.error(e?.stack);
  process.exit(2);
});
process.on("uncaughtException", (e) => {
  console.error("UNCAUGHT:", e?.status, e?.message);
  console.error(e?.stack);
  process.exit(3);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.status;
      const retryAfter = Number(e?.response?.headers?.["retry-after"]) || 0;
      if ((status === 403 || status === 429 || status >= 500) && attempt < 6) {
        const wait = Math.max(retryAfter * 1000, 2000 * 2 ** attempt);
        console.warn(`  ${label}: ${status}, sleep ${wait}ms (attempt ${attempt + 1})`);
        await sleep(wait);
        attempt++;
        continue;
      }
      throw e;
    }
  }
}

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

console.log("Listing tracked files…");
const files = sh("git ls-files").split("\n").filter(Boolean);
console.log(`  ${files.length} files`);

console.log(`Reading remote ${BRANCH} ref…`);
const ref = await octokit.git.getRef({
  owner: OWNER,
  repo: REPO,
  ref: `heads/${BRANCH}`,
});
const parentSha = ref.data.object.sha;
console.log(`  parent commit ${parentSha}`);

console.log("Uploading blobs…");
const tree = [];
const CONCURRENCY = 3;
let done = 0;
let lastLogged = 0;

async function uploadOne(path) {
  const buf = readFileSync(path);
  // Skip huge files (GitHub blob API limit is 100MB; we cap at 50MB)
  if (statSync(path).size > 50 * 1024 * 1024) {
    console.warn(`  SKIP (too large): ${path}`);
    return null;
  }
  const isText =
    buf.length === 0 ||
    !buf.includes(0); // crude: null byte = binary
  const resp = await withRetry(
    () =>
      octokit.git.createBlob({
        owner: OWNER,
        repo: REPO,
        content: isText ? buf.toString("utf8") : buf.toString("base64"),
        encoding: isText ? "utf-8" : "base64",
      }),
    `blob ${path}`,
  );
  return { path, mode: "100644", type: "blob", sha: resp.data.sha };
}

// Simple concurrency pool
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        const r = await fn(items[idx]);
        if (r) out.push(r);
      } catch (e) {
        console.error(`  FAIL ${items[idx]}: ${e.message}`);
        throw e;
      }
      done++;
      if (done - lastLogged >= 50 || done === items.length) {
        console.log(`  ${done}/${items.length}`);
        lastLogged = done;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

const blobs = await pool(files, CONCURRENCY, uploadOne);
tree.push(...blobs);

console.log(`Creating tree (${tree.length} entries)…`);
const treeResp = await octokit.git.createTree({
  owner: OWNER,
  repo: REPO,
  tree,
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
