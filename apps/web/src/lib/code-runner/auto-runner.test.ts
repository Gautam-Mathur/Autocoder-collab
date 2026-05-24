import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isParseErrorOutput,
  recordRecurrenceAndShouldWarn,
  runWholeProjectDrain,
  sanitizeLLMOutput,
} from "./auto-runner";
import {
  drainKnownTypos,
  auditResidualBrokenPatterns,
  parseCheckOnce,
  runVerifyThenStartGate,
} from "./auto-fix-engine";

describe("isParseErrorOutput — post-start auto-fix gate", () => {
  it("matches Vite Pre-transform 'Missing semicolon' (Babel wording)", () => {
    const out =
      "[vite] Pre-transform error: /home/x/src/pages/auth-page.tsx: Missing semicolon. (19:37)";
    expect(isParseErrorOutput(out)).toBe(true);
  });

  it("matches Vite Pre-transform 'Unexpected token' (Babel wording)", () => {
    const out =
      "[vite] Pre-transform error: /home/x/src/pages/projects-page.tsx: Unexpected token (60:51)";
    expect(isParseErrorOutput(out)).toBe(true);
  });

  it("matches esbuild dep-scan 'Expected \";\" but found \"{\"'", () => {
    const out = '✘ [ERROR] Expected ";" but found "{"\n    src/hooks/use-auth.ts:5:47:';
    expect(isParseErrorOutput(out)).toBe(true);
  });

  it("matches esbuild dep-scan 'Unexpected \")\"'", () => {
    const out = '✘ [ERROR] Unexpected ")"\n    src/pages/my-tasks-page.tsx:61:51:';
    expect(isParseErrorOutput(out)).toBe(true);
  });

  it("matches vite:react-babel plugin output", () => {
    const out = "[plugin:vite:react-babel] /home/x/src/foo.tsx: Unexpected token";
    expect(isParseErrorOutput(out)).toBe(true);
  });

  it("matches generic Pre-transform error line WITH (line:col) even with novel wording", () => {
    const out = "[vite] Pre-transform error: /home/x/src/foo.tsx: Some new parser message (1:1)";
    expect(isParseErrorOutput(out)).toBe(true);
  });

  it("does NOT match Pre-transform error WITHOUT (line:col) — likely import/resolve failure", () => {
    const out = "[vite] Pre-transform error: Failed to resolve import \"./missing\" from \"src/foo.tsx\"";
    expect(isParseErrorOutput(out)).toBe(false);
  });

  it("does NOT match unrelated logs", () => {
    expect(isParseErrorOutput("VITE v5.4.21 ready in 2615 ms")).toBe(false);
    expect(isParseErrorOutput("npm WARN deprecated foo@1.0.0")).toBe(false);
    expect(isParseErrorOutput("✓ Server ready at http://localhost:5173/")).toBe(false);
  });
});

describe("recordRecurrenceAndShouldWarn — Part C convergence guard", () => {
  it("does not warn before reaching the threshold", () => {
    const counts = new Map<string, number>();
    const warned = new Set<string>();
    const r1 = recordRecurrenceAndShouldWarn(counts, warned, "src/foo.tsx", 3);
    const r2 = recordRecurrenceAndShouldWarn(counts, warned, "src/foo.tsx", 3);
    expect(r1.shouldWarn).toBe(false);
    expect(r2.shouldWarn).toBe(false);
    expect(counts.get("src/foo.tsx")).toBe(2);
  });

  it("warns exactly once when the threshold is crossed", () => {
    const counts = new Map<string, number>();
    const warned = new Set<string>();
    recordRecurrenceAndShouldWarn(counts, warned, "src/foo.tsx", 3);
    recordRecurrenceAndShouldWarn(counts, warned, "src/foo.tsx", 3);
    const r3 = recordRecurrenceAndShouldWarn(counts, warned, "src/foo.tsx", 3);
    const r4 = recordRecurrenceAndShouldWarn(counts, warned, "src/foo.tsx", 3);
    const r5 = recordRecurrenceAndShouldWarn(counts, warned, "src/foo.tsx", 3);
    expect(r3.shouldWarn).toBe(true);
    expect(r4.shouldWarn).toBe(false);
    expect(r5.shouldWarn).toBe(false);
    expect(counts.get("src/foo.tsx")).toBe(5);
    expect(warned.has("src/foo.tsx")).toBe(true);
  });

  it("tracks each file independently — one warning per file", () => {
    const counts = new Map<string, number>();
    const warned = new Set<string>();
    for (let i = 0; i < 3; i++) recordRecurrenceAndShouldWarn(counts, warned, "src/a.tsx", 3);
    for (let i = 0; i < 3; i++) recordRecurrenceAndShouldWarn(counts, warned, "src/b.tsx", 3);
    expect(warned.has("src/a.tsx")).toBe(true);
    expect(warned.has("src/b.tsx")).toBe(true);
    expect(warned.size).toBe(2);
  });

  it("a successful repair clears the counter so a new typo gets a fresh budget", () => {
    const counts = new Map<string, number>();
    const warned = new Set<string>();
    for (let i = 0; i < 3; i++) recordRecurrenceAndShouldWarn(counts, warned, "src/foo.tsx", 3);
    expect(warned.has("src/foo.tsx")).toBe(true);
    // Simulate the post-fix reset done in runPostStartAutoFix
    counts.delete("src/foo.tsx");
    warned.delete("src/foo.tsx");
    const r1 = recordRecurrenceAndShouldWarn(counts, warned, "src/foo.tsx", 3);
    const r2 = recordRecurrenceAndShouldWarn(counts, warned, "src/foo.tsx", 3);
    expect(r1.shouldWarn).toBe(false);
    expect(r2.shouldWarn).toBe(false);
    expect(counts.get("src/foo.tsx")).toBe(2);
  });
});

describe("runWholeProjectDrain — final post-success / retry-path sweep", () => {
  it("drains typos from files that had no scan-time error, skips clean files, and skips non-code paths", async () => {
    const projectFiles = [
      // dirty .jsx file — not in any error list, but contains the mangled-arrow typo
      { path: "src/Form.jsx", content: 'const x = <input onChange={(e) = /> setX(e.target.value)} />' },
      // clean .ts file — must not be touched
      { path: "src/util.ts", content: "export const add = (a: number, b: number) => a + b;" },
      // non-code file — must be skipped (.json)
      { path: "package.json", content: '{"name":"x"}' },
      // node_modules path — must be skipped even if dirty
      { path: "node_modules/lib/index.js", content: 'const f = (e) = /> e;' },
      // vite.config.ts — must be skipped (excluded path)
      { path: "vite.config.ts", content: 'export default { /* (e) = /> noop */ }' },
    ];

    const writes: Record<string, string> = {};
    const reads: string[] = [];

    const result = await runWholeProjectDrain({
      files: projectFiles,
      read: async (p) => {
        reads.push(p);
        return projectFiles.find(f => f.path === p)?.content ?? null;
      },
      write: async (p, c) => { writes[p] = c; },
      drain: drainKnownTypos,
    });

    // Only Form.jsx should be touched
    expect(result.touched.length).toBe(1);
    expect(result.touched[0].path).toBe("src/Form.jsx");
    expect(result.touched[0].content).not.toContain("= />");
    expect(result.touched[0].content).toContain("=>");

    // Aggregate counts include the mangled-arrow fix
    expect(Object.keys(result.aggregate).length).toBeGreaterThan(0);

    // writeFile was called exactly once, for Form.jsx
    expect(Object.keys(writes)).toEqual(["src/Form.jsx"]);

    // node_modules and vite.config.ts and package.json were never read
    expect(reads).not.toContain("node_modules/lib/index.js");
    expect(reads).not.toContain("vite.config.ts");
    expect(reads).not.toContain("package.json");
  });

  it("returns an empty result when every code file is already clean (no writes, no aggregate)", async () => {
    const projectFiles = [
      { path: "src/a.tsx", content: "export const A = () => <div>ok</div>;" },
      { path: "src/b.ts", content: "export const x = 1;" },
    ];
    const writes: Record<string, string> = {};
    const result = await runWholeProjectDrain({
      files: projectFiles,
      read: async (p) => projectFiles.find(f => f.path === p)?.content ?? null,
      write: async (p, c) => { writes[p] = c; },
      drain: drainKnownTypos,
    });
    expect(result.touched).toEqual([]);
    expect(result.aggregate).toEqual({});
    expect(Object.keys(writes)).toEqual([]);
  });

  it("runs BEFORE startDevServer in the orchestrator (source-order regression guard)", () => {
    // Issue B: when the whole-project drain ran AFTER startDevServer, Vite
    // had already cached broken transforms and rewrites on disk did not
    // invalidate that cache. Moving the drain to BEFORE startDevServer is
    // the structural fix. This test pins that ordering so a future edit
    // can't silently regress it without a CI failure.
    const src = readFileSync(resolve(__dirname, "auto-runner.ts"), "utf8");
    const drainIdx = src.indexOf("runWholeProjectDrain({");
    const startIdx = src.indexOf("await startDevServer(");
    expect(drainIdx).toBeGreaterThan(0);
    expect(startIdx).toBeGreaterThan(0);
    expect(drainIdx).toBeLessThan(startIdx);
    // And the comment marker explains why.
    expect(src).toContain("Pre-start whole-project drain");
  });

  it("does not have a final whole-project drain marker after startDevServer", () => {
    // The post-success final drain (which used to taint Vite's cache) was
    // removed and replaced by the pre-start drain. The retry-path drain at
    // the bottom of the catch-block is still allowed (it precedes the NEXT
    // startDevServer iteration), so we pin only the removed marker.
    const src = readFileSync(resolve(__dirname, "auto-runner.ts"), "utf8");
    const startIdx = src.indexOf("await startDevServer(");
    const after = src.slice(startIdx);
    expect(after.includes("Final whole-project drain pass")).toBe(false);
    expect(after.includes("Final whole-project drain:")).toBe(false);
  });

  it("drains the exact failing-run-2026-04-18 mangled-arrow shapes (auth-page / tasks-page)", async () => {
    // Five real broken file shapes from the failing log. Drain MUST report
    // mangled-arrow >= 1 for every JSX file that contains `(e) = />`,
    // never silent zero again.
    const projectFiles = [
      {
        path: "src/pages/auth-page.tsx",
        content: `import React, { useState } from "react";
export default function AuthPage() {
  const [email, setEmail] = useState("");
  return (
    <form>
      <input onChange={(e) = /> setEmail(e.target.value)} value={email} />
      <button type="submit">Sign in</button>
    </form>
  );
}
`,
      },
      {
        path: "src/pages/tasks-page.tsx",
        content: `import { useState } from "react";
export default function TasksPage() {
  const [filter, setFilter] = useState("all");
  return (
    <select onChange={(e) = /> setFilter(e.target.value)}>
      <option value="all">All</option>
    </select>
  );
}
`,
      },
      {
        path: "src/pages/projects-page.tsx",
        content: `import { useState } from "react";
export default function Projects() {
  const [q, setQ] = useState("");
  return <input onChange={(e) = /> setQ(e.target.value)} value={q} />;
}
`,
      },
      {
        path: "src/components/SearchBox.tsx",
        content: `export function SearchBox({ onChange }: { onChange: (v: string) => void }) {
  return <input onInput={(e) = /> onChange((e.target as HTMLInputElement).value)} />;
}
`,
      },
      {
        path: "src/components/Filter.tsx",
        content: `export function Filter() {
  const handle = (e: any) = /> console.log(e);
  return <button onClick={handle}>x</button>;
}
`,
      },
    ];

    const writes: Record<string, string> = {};
    const result = await runWholeProjectDrain({
      files: projectFiles,
      read: async (p) => projectFiles.find(f => f.path === p)?.content ?? null,
      write: async (p, c) => { writes[p] = c; },
      drain: drainKnownTypos,
    });

    // Every file must be touched and report mangled-arrow at least once.
    expect(result.touched.length).toBe(5);
    expect(result.aggregate["mangled-arrow"]).toBeGreaterThanOrEqual(5);
    for (const t of result.touched) {
      expect(t.content).not.toMatch(/\)\s*=\s*\/>/);
      expect(t.content).toContain("=>");
    }
  });

  it("falls back to the in-memory content when read() returns null (file vanished from disk)", async () => {
    const projectFiles = [
      { path: "src/Stale.jsx", content: 'const f = (e) = /> e.value;' },
    ];
    const writes: Record<string, string> = {};
    const result = await runWholeProjectDrain({
      files: projectFiles,
      read: async () => null,
      write: async (p, c) => { writes[p] = c; },
      drain: drainKnownTypos,
    });
    expect(result.touched.length).toBe(1);
    expect(writes["src/Stale.jsx"]).toBeDefined();
    expect(writes["src/Stale.jsx"]).not.toContain("= />");
  });
});

describe("auditResidualBrokenPatterns — silent-miss detector", () => {
  it("reports residual mangled-arrow when a JSX file slipped past drain", () => {
    const findings = auditResidualBrokenPatterns([
      { path: "src/pages/auth-page.tsx", content: '<input onChange={(e) = /> setX(e)} />' },
      { path: "src/clean.tsx", content: 'export const A = () => <div />;' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].pattern).toBe("mangled-arrow");
    expect(findings[0].file).toBe("src/pages/auth-page.tsx");
    expect(findings[0].line).toBe(1);
  });

  it("skips node_modules and non-code files but DOES audit vite/tailwind/postcss configs", () => {
    const findings = auditResidualBrokenPatterns([
      { path: "node_modules/x/y.js", content: 'const f = (e) = /> e;' },
      { path: "package.json", content: '{ "x": "(e) = />" }' },
      { path: "src/notes.md", content: '(e) = />' },
      { path: "vite.config.ts", content: '// (e) = />' },
    ]);
    // Configs must surface so doctor/runner can see them; non-code skipped.
    expect(findings.map(f => f.file)).toEqual(["vite.config.ts"]);
  });

  it("reports stray-paren-jsx-tag only in JSX files (not plain .ts)", () => {
    const findings = auditResidualBrokenPatterns([
      { path: "src/Bad.tsx", content: '<Button) onClick={x} />' },
      { path: "src/util.ts",  content: 'const ok = "<Button) "; // string, ignore' },
    ]);
    const tagFindings = findings.filter(f => f.pattern === "stray-paren-jsx-tag");
    expect(tagFindings).toHaveLength(1);
    expect(tagFindings[0].file).toBe("src/Bad.tsx");
  });

  it("detects bare-identifier attr arrow `onClick={e = /> ...}` as mangled-arrow-attr", () => {
    const findings = auditResidualBrokenPatterns([
      { path: "src/Btn.tsx", content: 'export const Btn = () => <button onClick={e = /> doX(e)} />;' },
    ]);
    const attr = findings.filter(f => f.pattern === "mangled-arrow-attr");
    expect(attr).toHaveLength(1);
    expect(attr[0].file).toBe("src/Btn.tsx");
  });

  it("drainKnownTypos repairs the bare-identifier attr arrow shape", () => {
    const before = `export const Btn = () => <button onClick={e = /> doX(e)} />;`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/Btn.tsx");
    expect(content).not.toMatch(/=\s*\/>/);
    expect(content).toContain("onClick={e => doX(e)}");
    expect(fixesApplied.find(f => f.id === "mangled-arrow-attr")?.count).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for a clean project (audit must not false-positive)", () => {
    const findings = auditResidualBrokenPatterns([
      { path: "src/A.tsx", content: 'export const A = () => <div />;' },
      { path: "src/b.ts",  content: 'export const x = (a: number) => a + 1;' },
    ]);
    expect(findings).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Verify-then-start gate (Step 2) — uses a mock esbuild transform so the
// suite stays hermetic and fast. The mock implements the contract the
// real esbuild-wasm exposes: throw an object with `errors[]` on failure.
// ────────────────────────────────────────────────────────────────────────
function makeMockTransform() {
  // Mock parser: rejects content containing `(e) = />` or `= />` or
  // `<Tag)` or `=> )` or `[)`. Matches what auto-fix-engine drains.
  const brokenRe = /(?:\)\s*=\s*\/>|=\{\s*[A-Za-z_$][\w$]*\s*=\s*\/>|=>\s*\)\s*\{|<[A-Za-z][\w$.]*\)\s|=>\s*\[\)|\)\s+\)\s*=>)/;
  return async (src: string, opts: { sourcefile?: string }) => {
    const m = src.match(brokenRe);
    if (m) {
      const before = src.slice(0, m.index ?? 0);
      const line = (before.match(/\n/g) || []).length + 1;
      const lastNl = before.lastIndexOf("\n");
      const column = (m.index ?? 0) - (lastNl + 1);
      const err = Object.assign(new Error("Syntax error"), {
        errors: [{
          text: `Mock parse error near "${m[0]}"`,
          location: { line, column, file: opts.sourcefile },
        }],
      });
      throw err;
    }
    return { code: src, map: "", warnings: [] };
  };
}

describe("parseCheckOnce — cascade-suppressed parse check", () => {
  it("returns no errors when all files are clean", async () => {
    const transform = makeMockTransform();
    const errors = await parseCheckOnce(
      [
        { path: "src/A.tsx", content: "export const A = () => <div />;" },
        { path: "src/b.ts",  content: "export const x = (n: number) => n + 1;" },
      ],
      transform,
    );
    expect(errors).toEqual([]);
  });

  it("returns ONE error per broken file (cascade suppressor)", async () => {
    const transform = makeMockTransform();
    const errors = await parseCheckOnce(
      [
        { path: "src/A.tsx", content: "const A = () => <X onClick={(e) = /> doX(e)} />;" },
        { path: "src/B.tsx", content: "const B = () => <Y onClick={(e) = /> doY(e)} />;" },
      ],
      transform,
    );
    expect(errors).toHaveLength(2);
    expect(errors.map(e => e.file).sort()).toEqual(["src/A.tsx", "src/B.tsx"]);
  });

  it("skips node_modules, vite/tailwind/postcss configs, and .d.ts", async () => {
    const transform = makeMockTransform();
    const errors = await parseCheckOnce(
      [
        { path: "node_modules/x/index.ts", content: "(e) = />" },
        { path: "vite.config.ts",          content: "(e) = />" },
        { path: "tailwind.config.js",      content: "(e) = />" },
        { path: "postcss.config.js",       content: "(e) = />" },
        { path: "src/types.d.ts",          content: "(e) = />" },
      ],
      transform,
    );
    expect(errors).toEqual([]);
  });
});

describe("runVerifyThenStartGate — Step 2 verify-repair loop", () => {
  it("returns ok=true on a clean project in 1 iteration", async () => {
    const transform = makeMockTransform();
    const files = [{ path: "src/A.tsx", content: "export const A = () => <div />;" }];
    const disk = new Map(files.map(f => [f.path, f.content]));
    const result = await runVerifyThenStartGate({
      files,
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: drainKnownTypos,
    });
    expect(result.ok).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.repairedFiles).toEqual([]);
  });

  it("repairs the failing-run-2026-04-18 mangled-arrow shapes and starts clean", async () => {
    const transform = makeMockTransform();
    const broken = [
      { path: "src/pages/auth-page.tsx",     content: "export const A = () => <button onClick={(e) = /> handle(e)} />;" },
      { path: "src/pages/tasks-page.tsx",    content: "export const T = () => <input onChange={(e) = /> set(e.target.value)} />;" },
      { path: "src/pages/projects-page.tsx", content: "export const P = () => <Btn onClick={(e) = /> run(e)} />;" },
      { path: "src/components/SearchBox.tsx", content: "export const S = () => <input onInput={(e) = /> q(e)} />;" },
      { path: "src/components/Filter.tsx",   content: "export const F = () => <select onChange={(e) = /> set(e)} />;" },
    ];
    const disk = new Map(broken.map(f => [f.path, f.content]));
    const result = await runVerifyThenStartGate({
      files: broken,
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: drainKnownTypos,
      maxIterations: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.repairedFiles.sort()).toEqual(broken.map(b => b.path).sort());
    // All files should now parse clean
    for (const c of disk.values()) {
      expect(c).not.toMatch(/=\s*\/>/);
    }
  });

  it("loops up to maxIterations when first pass repairs uncover further issues", async () => {
    // File needs 2 passes: first drain pass turns a multi-typo shape into
    // a still-broken intermediate. Use mock-controlled drain.
    let callCount = 0;
    const customDrain = (content: string, _path: string) => {
      callCount++;
      if (callCount === 1) {
        // First pass: fix outer typo, leave inner one
        return { content: content.replace("(e) = />", "(e) =>").replace("(x) = />", "(x) = / >XX"), fixesApplied: [] };
      }
      // Second pass: fix inner
      return { content: content.replace(/= \/ >XX/, "=>"), fixesApplied: [] };
    };
    const transform = async (src: string) => {
      if (/(?:\)\s*=\s*\/>|= \/ >XX)/.test(src)) {
        const e = Object.assign(new Error("syntax"), {
          errors: [{ text: "broken", location: { line: 1, column: 0 } }],
        });
        throw e;
      }
      return { code: src };
    };
    const file = { path: "src/X.tsx", content: "const X = () => <div onClick={(e) = />} onHover={(x) = />} />;" };
    const disk = new Map([[file.path, file.content]]);
    const result = await runVerifyThenStartGate({
      files: [file],
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: customDrain,
      maxIterations: 3,
    });
    expect(result.iterations).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(true);
  });

  it("reports still-broken files explicitly when no repair makes progress", async () => {
    const transform = async () => {
      const e = Object.assign(new Error("syntax"), {
        errors: [{ text: "Novel typo not in fix engine", location: { line: 5, column: 12 } }],
      });
      throw e;
    };
    // Drain returns content unchanged → no progress → bail
    const noopDrain = (c: string) => ({ content: c, fixesApplied: [] });
    const file = { path: "src/Z.tsx", content: "const Z = () => <weird>>>>;" };
    const disk = new Map([[file.path, file.content]]);
    const result = await runVerifyThenStartGate({
      files: [file],
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: noopDrain,
      maxIterations: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.stillBroken).toHaveLength(1);
    expect(result.stillBroken[0].file).toBe("src/Z.tsx");
    expect(result.stillBroken[0].message).toContain("Novel typo");
    // Bailed early — only 1 iteration since no progress was made.
    expect(result.iterations).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Step 7: __fixtures__/failing-run-2026-04-18 — exact files captured from
// the failing generation run. Asserts the full pipeline (audit → drain →
// re-audit → verify-gate) lands clean on the real broken bytes.
// ────────────────────────────────────────────────────────────────────────
describe("failing-run-2026-04-18 fixture pack — full pipeline", () => {
  const FIXTURE_DIR = resolve(__dirname, "__fixtures__/failing-run-2026-04-18");
  const FILES = [
    "auth-page.tsx",
    "tasks-page.tsx",
    "projects-page.tsx",
    "SearchBox.tsx",
    "Filter.tsx",
  ];

  const loadFixtures = () =>
    FILES.map(name => ({
      path: `src/${name}`,
      content: readFileSync(resolve(FIXTURE_DIR, name), "utf8"),
    }));

  it("audit flags every fixture file BEFORE drain runs", () => {
    const files = loadFixtures();
    const findings = auditResidualBrokenPatterns(files);
    const flaggedPaths = new Set(findings.map(f => f.file));
    expect(flaggedPaths.size).toBe(FILES.length);
    for (const name of FILES) expect(flaggedPaths.has(`src/${name}`)).toBe(true);
  });

  it("drainKnownTypos repairs every fixture file (no `= />` survives)", () => {
    for (const f of loadFixtures()) {
      const { content } = drainKnownTypos(f.content, f.path);
      expect(content, `${f.path} still has mangled arrow`).not.toMatch(/=\s*\/>/);
    }
  });

  it("after drain, auditResidualBrokenPatterns returns []", () => {
    const drained = loadFixtures().map(f => ({
      path: f.path,
      content: drainKnownTypos(f.content, f.path).content,
    }));
    expect(auditResidualBrokenPatterns(drained)).toEqual([]);
  });

  it("verify-then-start gate (mock parser) lands ok=true and repairs all 5 files", async () => {
    const files = loadFixtures();
    const disk = new Map(files.map(f => [f.path, f.content]));
    const transform = makeMockTransform();
    const result = await runVerifyThenStartGate({
      files,
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: drainKnownTypos,
      maxIterations: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.repairedFiles.sort()).toEqual(files.map(f => f.path).sort());
    for (const c of disk.values()) expect(c).not.toMatch(/=\s*\/>/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Step 4 remainder: jsx-stray-fragment-close + jsx-close-tag-name-mismatch
// ────────────────────────────────────────────────────────────────────────
describe("jsx-stray-fragment-close handler (P6)", () => {
  it("removes a trailing orphan </> after a closing tag", () => {
    const before = `export const A = () => <div>hi</div></>;`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/A.tsx");
    expect(content).toBe(`export const A = () => <div>hi</div>;`);
    expect(fixesApplied.find(f => f.id === "jsx-stray-fragment-close")?.count).toBe(1);
  });

  it("LEAVES a matched <>...</> fragment alone", () => {
    const src = `export const A = () => <><span>hi</span></>;`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/A.tsx");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "jsx-stray-fragment-close")).toBeUndefined();
  });

  it("removes only the orphan when a valid fragment also exists", () => {
    const before  = `export const A = () => <><span>hi</span></></>;`;
    const after   = `export const A = () => <><span>hi</span></>;`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/A.tsx");
    expect(content).toBe(after);
    expect(fixesApplied.find(f => f.id === "jsx-stray-fragment-close")?.count).toBe(1);
  });

  it("does not touch .ts files (JSX-only)", () => {
    const src = `const x: string[] = []; // </> is meaningless in TS`;
    const { content } = drainKnownTypos(src, "src/x.ts");
    expect(content).toBe(src);
  });
});

describe("jsx-close-tag-name-mismatch handler (P7)", () => {
  it("rewrites </Wrong> to </Right> when stack ownership is unambiguous", () => {
    const before = `export const A = () => <Container>hello</Wrong>;`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/A.tsx");
    expect(content).toContain("</Container>");
    expect(content).not.toContain("</Wrong>");
    expect(fixesApplied.find(f => f.id === "jsx-close-tag-name-mismatch")?.count).toBe(1);
  });

  it("LEAVES correctly-paired tags alone", () => {
    const src = `export const A = () => <div><span>hi</span></div>;`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/A.tsx");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "jsx-close-tag-name-mismatch")).toBeUndefined();
  });

  it("does NOT auto-fix ambiguous cases (nested elements between)", () => {
    // <A><B>x</B></WrongA> — even though A is on the stack, there's a
    // nested element between, so the stack-ownership rule says "ambiguous".
    const src = `export const A = () => <A><B>x</B></WrongA>;`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/A.tsx");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "jsx-close-tag-name-mismatch")).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Task #23 — verify-gate cascade gap closure
//
//  S1: Smarter JSX close-tag handler (void-element promotion)
//  S2: Extend defineConfig doctor (vitest + define{Project,WorkspaceProject})
//  S3: One-off shapes — un-repairable but cleanly surfaced
//  S4: Per-iteration cascade diagnostics (perFileActions)
//  S5: bucket-2 regression suite
// ────────────────────────────────────────────────────────────────────────
describe("S1 — JSX void-element promotion (P7 extension)", () => {
  it("drops an orphan </Input> closer with no matching opener on stack", () => {
    // Real shape: <div><Input ... /></Input></div> — the </Input> is
    // an orphan because <Input ... /> already self-closed.
    const before = `export const A = () => (
  <div>
    <Input value="x" />
    </Input>
  </div>
);`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/A.tsx");
    expect(content).not.toMatch(/<\/Input>/);
    expect(content).toContain("<Input value=\"x\" />");
    expect(content).toContain("</div>");
    expect(fixesApplied.find(f => f.id === "jsx-void-element-promotion")?.count).toBeGreaterThanOrEqual(1);
  });

  it("promotes a non-self-closing <input> opener when </form> arrives instead of </input>", () => {
    // Stack: [form, input], next closer is </form> — input is void, so
    // promote opener to <input ... /> and pop, then </form> matches.
    const before = `export const F = () => (
  <form>
    <input type="text">
  </form>
);`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/F.tsx");
    // The <input> opener must be self-closing now.
    expect(content).toMatch(/<input type="text"\s*\/>/);
    // And </form> must remain closing the form.
    expect(content).toContain("</form>");
    expect(fixesApplied.find(f => f.id === "jsx-void-element-promotion")?.count).toBeGreaterThanOrEqual(1);
  });

  it("walks down through multiple stacked void elements (br + hr + p)", () => {
    const before = `export const D = () => (
  <section>
    <br>
    <hr>
    <p>x</p>
  </section>
);`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/D.tsx");
    expect(content).toMatch(/<br\s*\/>/);
    expect(content).toMatch(/<hr\s*\/>/);
    expect(content).toContain("</section>");
    expect(fixesApplied.find(f => f.id === "jsx-void-element-promotion")?.count).toBeGreaterThanOrEqual(2);
  });

  it("drops an orphan void closer even when it appears with empty stack at top level", () => {
    const before = `export const A = () => <span>hi</span>;\n</br>\n`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/A.tsx");
    expect(content).not.toMatch(/<\/br>/);
    expect(fixesApplied.find(f => f.id === "jsx-void-element-promotion")?.count).toBeGreaterThanOrEqual(1);
  });

  it("LEAVES non-void mismatches with nested opens alone (still ambiguous)", () => {
    // <A><B>x</B></WrongA> — the original safety branch must survive.
    const src = `export const X = () => <A><B>x</B></WrongA>;`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/X.tsx");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "jsx-close-tag-name-mismatch")).toBeUndefined();
    expect(fixesApplied.find(f => f.id === "jsx-void-element-promotion")).toBeUndefined();
  });

  it("does NOT promote a non-void mismatch (e.g. </CustomComponent> stays put)", () => {
    const src = `export const X = () => <Container>hi</CustomComponent>;`;
    const { content } = drainKnownTypos(src, "src/X.tsx");
    // Branch (a) renames </CustomComponent> to </Container> (no nested opens).
    expect(content).toContain("</Container>");
    expect(content).not.toContain("</CustomComponent>");
  });
});

describe("S2 — defineConfig doctor extends to vitest + helper callees", () => {
  // Import doctor module lazily; it's not in the test file's existing imports.
  it("rewrites defineConfig() { → defineConfig({ in vitest.config.ts", async () => {
    const { runViteTailwindDoctor } = await import("./vite-tailwind-doctor");
    const ctx = {
      files: [
        {
          path: "vitest.config.ts",
          content: `import { defineConfig } from 'vitest/config';\nexport default defineConfig() {\n  test: { environment: 'jsdom' },\n}\n`,
        },
      ],
    };
    const report = runViteTailwindDoctor(ctx, "preflight");
    const callBlockChange = report.codeChanges.find(c => c.file === "vitest.config.ts");
    expect(callBlockChange).toBeDefined();
    expect(callBlockChange!.fixed).toContain("defineConfig({");
    expect(callBlockChange!.fixed).toMatch(/\}\);\s*$/);
  });

  it("rewrites defineWorkspaceProject() { in vitest.workspace.ts shape (file-name match: vitest.config)", async () => {
    const { runViteTailwindDoctor } = await import("./vite-tailwind-doctor");
    const ctx = {
      files: [
        {
          path: "vitest.config.mts",
          content: `import { defineWorkspaceProject } from 'vitest/config';\nexport default defineWorkspaceProject() {\n  test: { name: 'unit' },\n}\n`,
        },
      ],
    };
    const report = runViteTailwindDoctor(ctx, "preflight");
    const change = report.codeChanges.find(c => c.file === "vitest.config.mts");
    expect(change).toBeDefined();
    expect(change!.fixed).toContain("defineWorkspaceProject({");
  });

  it("LEAVES vite/vitest config alone when the call-block shape is absent", async () => {
    const { runViteTailwindDoctor } = await import("./vite-tailwind-doctor");
    const clean = `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n`;
    const ctx = { files: [{ path: "vitest.config.ts", content: clean }] };
    const report = runViteTailwindDoctor(ctx, "preflight");
    const change = report.codeChanges.find(c => c.file === "vitest.config.ts");
    // Either no change or the file content equals input.
    if (change) expect(change.fixed).toBe(clean);
  });

  it("does NOT touch a non-config file even if it contains defineConfig() {", async () => {
    const { runViteTailwindDoctor } = await import("./vite-tailwind-doctor");
    const ctx = {
      files: [
        {
          path: "src/random-helper.ts",
          content: `export const x = () => defineConfig() {\n  return 1;\n}\n`,
        },
      ],
    };
    const report = runViteTailwindDoctor(ctx, "preflight");
    expect(report.codeChanges.find(c => c.file === "src/random-helper.ts")).toBeUndefined();
  });
});

describe("S4 — verify-gate per-iteration perFileActions diagnostics", () => {
  it("includes perFileActions on every iteration entry", async () => {
    const transform = makeMockTransform();
    const broken = [
      { path: "src/A.tsx", content: `const A = () => <X onClick={(e) = /> doX(e)} />;` },
    ];
    const disk = new Map(broken.map(f => [f.path, f.content]));
    const result = await runVerifyThenStartGate({
      files: broken,
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: drainKnownTypos,
    });
    expect(result.ok).toBe(true);
    for (const it of result.perIteration) {
      expect(it.perFileActions).toBeDefined();
      expect(typeof it.perFileActions).toBe("object");
    }
    // The first iteration must mark src/A.tsx as 'fixed'
    expect(result.perIteration[0].perFileActions["src/A.tsx"]).toBe("fixed");
  });

  it("marks an unrepairable file as 'unchanged' (drain made no progress)", async () => {
    const transform = async () => {
      const e = Object.assign(new Error("syntax"), {
        errors: [{ text: "Novel error", location: { line: 1, column: 0 } }],
      });
      throw e;
    };
    const noopDrain = (c: string) => ({ content: c, fixesApplied: [] });
    const file = { path: "src/Z.tsx", content: "broken" };
    const disk = new Map([[file.path, file.content]]);
    const result = await runVerifyThenStartGate({
      files: [file],
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: noopDrain,
    });
    expect(result.ok).toBe(false);
    expect(result.perIteration[0].perFileActions["src/Z.tsx"]).toBe("unchanged");
  });
});

describe("S5 — bucket-2 fixture pack (failing-run-2026-04-18-bucket-2)", () => {
  const FIXTURE_DIR = resolve(__dirname, "__fixtures__/failing-run-2026-04-18-bucket-2");
  const VOID_FIXTURES = [
    "sign-in-form.tsx",
    "profile-card.tsx",
    "divider-list.tsx",
    "nav-links.tsx",
    "search-bar.tsx",
  ];
  const ONE_OFF_FIXTURES = [
    "confirm-dialog.tsx",
    "data-table.tsx",
    "components.test.fixture.ts",
  ];

  const loadFile = (name: string) => readFileSync(resolve(FIXTURE_DIR, name), "utf8");

  it("drainKnownTypos repairs every void-promotion fixture", () => {
    for (const name of VOID_FIXTURES) {
      const src = loadFile(name);
      const { content, fixesApplied } = drainKnownTypos(src, `src/${name}`);
      // After repair: no orphan void closers should remain immediately
      // following a self-closing or non-self-closing void opener pair.
      // Concrete check: the count of void promotions must be >= 1.
      const promo = fixesApplied.find(f => f.id === "jsx-void-element-promotion")?.count ?? 0;
      expect(promo, `${name} should trigger a void promotion/drop`).toBeGreaterThanOrEqual(1);
      // And the file must not be obviously the same as input.
      expect(content).not.toBe(src);
    }
  });

  it("vitest config fixtures get the call-block rewrite from the doctor", async () => {
    const { runViteTailwindDoctor } = await import("./vite-tailwind-doctor");
    const files = [
      { path: "vitest.config.ts",    content: loadFile("vitest.config.ts") },
      { path: "vitest.workspace.ts", content: loadFile("vitest.workspace.ts") },
    ];
    const report = runViteTailwindDoctor({ files }, "preflight");
    const c1 = report.codeChanges.find(c => c.file === "vitest.config.ts");
    const c2 = report.codeChanges.find(c => c.file === "vitest.workspace.ts");
    expect(c1?.fixed).toContain("defineConfig({");
    expect(c2?.fixed).toContain("defineWorkspaceProject({");
  });

  it("one-off shapes are now REPAIRED by Task #27 drain rules (P8/P9/P10)", async () => {
    // Updated by Task #27: the three shapes that bucket-2 documented as
    // un-repairable noise are now handled by the new drain rules:
    //   confirm-dialog.tsx          → P8 void-typed-initializer
    //   data-table.tsx              → P9 eof-extra-close-brace
    //   components.test.fixture.ts  → P10 generic-self-close-typo
    // The mock parser must therefore accept every fixture after drain
    // and the verify gate must land ok=true.
    const transform = async (src: string, opts: { sourcefile?: string }) => {
      if (/(?:const|let|var)\s+\w+\s*:\s*void\s*=/.test(src)) {
        throw Object.assign(new Error("syntax"), {
          errors: [{ text: "Unexpected \":\"", location: { line: 1, column: 0, file: opts.sourcefile } }],
        });
      }
      if (/\}\}\s*$/.test(src)) {
        throw Object.assign(new Error("syntax"), {
          errors: [{ text: "Unexpected \"}\"", location: { line: 1, column: 0, file: opts.sourcefile } }],
        });
      }
      if (/<[A-Z]\w*,\s*\/>/.test(src)) {
        throw Object.assign(new Error("syntax"), {
          errors: [{ text: "Expected \">\" but found \"/\"", location: { line: 1, column: 0, file: opts.sourcefile } }],
        });
      }
      return { code: src, map: "", warnings: [] };
    };
    const files = ONE_OFF_FIXTURES.map(name => ({
      path: `src/${name}`,
      content: loadFile(name),
    }));
    const disk = new Map(files.map(f => [f.path, f.content]));
    const result = await runVerifyThenStartGate({
      files,
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: drainKnownTypos,
      maxIterations: 4,
    });
    expect(result.ok).toBe(true);
    // Every one-off must have been repaired by the drain.
    const repaired = new Set(result.repairedFiles);
    for (const name of ONE_OFF_FIXTURES) {
      expect(repaired.has(`src/${name}`)).toBe(true);
    }
  });

  it("end-to-end: the void-promotion fixtures land ok=true through the verify gate", async () => {
    // Mock parser flags any orphan void closer or unclosed void opener.
    // Counts: total tag-opens minus self-closes vs explicit closes.
    const transform = async (src: string, opts: { sourcefile?: string }) => {
      const VOIDS = ['Input','input','br','hr','img','link','meta','area','base','col','embed','source','track','wbr'];
      for (const v of VOIDS) {
        // Total opens (greedy non-> match, includes self-closing form).
        const totalOpens = (src.match(new RegExp(`<${v}\\b[^>]*?>`, 'g')) || []).length;
        const selfCloses = (src.match(new RegExp(`<${v}\\b[^>]*?/>`, 'g')) || []).length;
        const realOpens = totalOpens - selfCloses;
        const closes = (src.match(new RegExp(`<\\/${v}>`, 'g')) || []).length;
        if (closes !== realOpens) {
          const e = Object.assign(new Error('syntax'), {
            errors: [{ text: `Mismatched <${v}> opens=${realOpens} closes=${closes}`, location: { line: 1, column: 0, file: opts.sourcefile } }],
          });
          throw e;
        }
      }
      return { code: src, map: '', warnings: [] };
    };
    const files = VOID_FIXTURES.map(name => ({
      path: `src/${name}`,
      content: loadFile(name),
    }));
    const disk = new Map(files.map(f => [f.path, f.content]));
    const result = await runVerifyThenStartGate({
      files,
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: drainKnownTypos,
      maxIterations: 3,
    });
    expect(result.ok).toBe(true);
    // At least one fixture must have been repaired by the verify-gate
    // drain loop; some shapes may be accepted as-is by the mock parser.
    expect(result.repairedFiles.length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Task #27 — Fix the six remaining frontend stalls
//
//  P8  void-typed-initializer       (`const x: void = expr`)
//  P9  eof-extra-close-brace        (stray trailing `}` at EOF)
//  P10 generic-self-close-typo      (`<T,/>` → `<T,>`)
//  P11 jsx-attr-extra-close-paren   (`onClick={() => fn(x))}` → `…fn(x)}`)
//  Doctor-in-gate                   (verify-gate calls doctor each iter)
//  bucket-3 fixture pack            (real failing-run shapes, end-to-end)
// ────────────────────────────────────────────────────────────────────────
describe("Task #27 — drain rule P8: void-typed-initializer", () => {
  it("strips `: void` from a `const x: void = expr` declaration", () => {
    const before = `export const handle: void = doStuff();\n`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/x.ts");
    expect(content).toBe(`export const handle = doStuff();\n`);
    expect(fixesApplied.find(f => f.id === "void-typed-initializer")?.count).toBe(1);
  });

  it("works for `let` and `var` and counts every site", () => {
    const before = `let a: void = f();\nvar b: void = g();\nconst c: void = h();\n`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/x.ts");
    expect(content).toBe(`let a = f();\nvar b = g();\nconst c = h();\n`);
    expect(fixesApplied.find(f => f.id === "void-typed-initializer")?.count).toBe(3);
  });

  it("LEAVES legitimate function return-type `: void` alone", () => {
    const src = `export function side(): void { console.log("ok"); }\n`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/x.ts");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "void-typed-initializer")).toBeUndefined();
  });

  it("LEAVES `Promise<void>` and other type uses of void alone", () => {
    const src = `const p: Promise<void> = Promise.resolve();\n`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/x.ts");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "void-typed-initializer")).toBeUndefined();
  });
});

describe("Task #27 — drain rule P9: eof-extra-close-brace", () => {
  it("drops a single stray trailing `}` when the file is over-closed by 1", () => {
    const before = `export const A = () => <div />;\n}\n`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/A.tsx");
    expect(content.trim()).toBe(`export const A = () => <div />;`);
    expect(fixesApplied.find(f => f.id === "eof-extra-close-brace")?.count).toBe(1);
  });

  it("drops MULTIPLE stray trailing `}}` when over-closed by 2", () => {
    const before = `export const A = () => {\n  return <div />;\n}}}\n`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/A.tsx");
    // Should land at exactly balanced — the function has 1 open brace, so
    // exactly 1 closing `}` should remain.
    const opens = (content.match(/\{/g) || []).length;
    const closes = (content.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(fixesApplied.find(f => f.id === "eof-extra-close-brace")?.count).toBe(2);
  });

  it("LEAVES a balanced file alone", () => {
    const src = `export const A = () => { return 1; };\n`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/A.tsx");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "eof-extra-close-brace")).toBeUndefined();
  });

  it("does NOT count braces inside string/template literals or comments", () => {
    // The literal `}` characters in strings/templates/comments must be
    // ignored by the brace counter; otherwise the file would look
    // over-closed and we'd wrongly trim trailing braces.
    const src = `const a = "}}}";\nconst b = \`\${x}}}\`;\n// stray } in a comment\n/* and } here */\nexport function f() { return a; }\n`;
    const { content } = drainKnownTypos(src, "src/x.ts");
    expect(content).toBe(src);
  });
});

describe("Task #27 — drain rule P10: generic-self-close-typo", () => {
  it("rewrites `<T,/>` to `<T,>` in a TS file", () => {
    const before = `const id = <T,/>(x: T) => x;\n`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/x.ts");
    expect(content).toBe(`const id = <T,>(x: T) => x;\n`);
    expect(fixesApplied.find(f => f.id === "generic-self-close-typo")?.count).toBe(1);
  });

  it("works for any uppercase identifier", () => {
    const before = `const id = <Foo,/>(x: Foo) => x;\nconst id2 = <Bar,/>(y: Bar) => y;\n`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/x.ts");
    expect(content).toContain("<Foo,>");
    expect(content).toContain("<Bar,>");
    expect(fixesApplied.find(f => f.id === "generic-self-close-typo")?.count).toBe(2);
  });

  it("LEAVES legitimate `<Component />` JSX self-close alone (no comma)", () => {
    const src = `const A = () => <Foo />;\n`;
    const { content } = drainKnownTypos(src, "src/A.tsx");
    expect(content).toBe(src);
  });

  it("LEAVES the canonical `<T,>` form alone", () => {
    const src = `const id = <T,>(x: T) => x;\n`;
    const { content } = drainKnownTypos(src, "src/x.ts");
    expect(content).toBe(src);
  });
});

describe("Task #27 — drain rule P11: jsx-attr-extra-close-paren", () => {
  it("drops the extra `)` in `onClick={() => fn(x))}`", () => {
    const before = `export const A = () => <button onClick={() => dismiss(toast.id))}>x</button>;`;
    const { content, fixesApplied } = drainKnownTypos(before, "src/A.tsx");
    expect(content).toBe(`export const A = () => <button onClick={() => dismiss(toast.id)}>x</button>;`);
    expect(fixesApplied.find(f => f.id === "jsx-attr-extra-close-paren")?.count).toBe(1);
  });

  it("LEAVES a balanced JSX attribute callback alone", () => {
    const src = `export const A = () => <button onClick={() => dismiss(toast.id)}>x</button>;`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/A.tsx");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "jsx-attr-extra-close-paren")).toBeUndefined();
  });

  it("does NOT touch `.ts` files (JSX-only)", () => {
    const src = `const x = "={() => f(1))}"; // string, ignore`;
    const { content } = drainKnownTypos(src, "src/x.ts");
    expect(content).toBe(src);
  });

  it("does NOT trim a paren that is balanced (no off-by-one)", () => {
    // The `()` here contributes opens=closes=1 — must be untouched.
    const src = `export const A = () => <Box style={{ color: "red" }} onMount={() => log()}/>;`;
    const { content } = drainKnownTypos(src, "src/A.tsx");
    expect(content).toBe(src);
  });

  it("HARDENING: ignores `)` characters inside a string literal in the attribute body", () => {
    // `fn(")")` has paren count opens=1, real-closes=1 — the `)` inside
    // the string must NOT be counted, otherwise the rule would falsely
    // detect off-by-one and corrupt valid code.
    const src = `export const A = () => <button onClick={() => fn(")")}>x</button>;`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/A.tsx");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "jsx-attr-extra-close-paren")).toBeUndefined();
  });

  it("HARDENING: ignores `)` characters inside a template literal in the attribute body", () => {
    const src = "export const A = () => <button onClick={() => log(`x)y`)}>x</button>;";
    const { content, fixesApplied } = drainKnownTypos(src, "src/A.tsx");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "jsx-attr-extra-close-paren")).toBeUndefined();
  });

  it("HARDENING: ignores `)` characters inside a `//` comment in the attribute body", () => {
    const src = `export const A = () => <button onClick={() => {\n  // closes the dialog )\n  fn();\n}}>x</button>;`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/A.tsx");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "jsx-attr-extra-close-paren")).toBeUndefined();
  });
});

describe("Task #27 — drain rule hardening (architect feedback 2026-04-18)", () => {
  it("P8: LEAVES `const x: void = undefined` alone (RHS is not a call)", () => {
    const src = `const x: void = undefined;\n`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/x.ts");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "void-typed-initializer")).toBeUndefined();
  });

  it("P8: LEAVES `const x: void = null` alone (RHS is not a call)", () => {
    const src = `const x: void = null as unknown as void;\n`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/x.ts");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "void-typed-initializer")).toBeUndefined();
  });

  it("P8: STILL repairs the LLM-typical `const x: void = fn()` shape", () => {
    const src = `const handleClick: void = onConfirm();\n`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/x.tsx");
    expect(content).toBe(`const handleClick = onConfirm();\n`);
    expect(fixesApplied.find(f => f.id === "void-typed-initializer")?.count).toBe(1);
  });

  it("P9: does NOT mis-count braces when `}` lives inside a `${...}` template-expression string", () => {
    // The `"}"` literal inside `${...}` must not be counted as a real
    // close-brace; the brace counter must recurse into ${...} and skip
    // strings/templates/comments inside it.
    const src = "export const t = `prefix ${fn(\"}\")} suffix`;\nexport const f = () => { return 1; };\n";
    const { content, fixesApplied } = drainKnownTypos(src, "src/x.ts");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "eof-extra-close-brace")).toBeUndefined();
  });

  it("P9: does NOT mis-count braces when `{`/`}` appear inside a regex literal near EOF", () => {
    // Regex literals can contain `{` (quantifiers like `\\d{1,3}`) and `}`.
    // If skipNonCodeAt does not recognise regex literals, P9 may see the
    // file as over-closed and trim a real trailing `}`.
    const src = `const tripleDigit = /^\\d{1,3}$/;\nexport const f = () => { return tripleDigit; };\n`;
    const { content, fixesApplied } = drainKnownTypos(src, "src/x.ts");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "eof-extra-close-brace")).toBeUndefined();
  });

  it("P9: does NOT mis-count braces when `}` appears inside a `//` comment within a template-expression", () => {
    const src = "export const t = `${(() => {\n  // close } here\n  return 1;\n})()}`;\n";
    const { content, fixesApplied } = drainKnownTypos(src, "src/x.ts");
    expect(content).toBe(src);
    expect(fixesApplied.find(f => f.id === "eof-extra-close-brace")).toBeUndefined();
  });
});

describe("Task #27 — runVerifyThenStartGate doctor callback", () => {
  it("invokes the doctor before parseCheck and applies its changes", async () => {
    const doctorCalls: number = 0;
    let calls = 0;
    const transform = async (src: string) => {
      // Mock parser: rejects any file containing `defineConfig() {`
      if (/defineConfig\(\)\s*\{/.test(src)) {
        const e = Object.assign(new Error("syntax"), {
          errors: [{ text: "Expected ';'", location: { line: 1, column: 0 } }],
        });
        throw e;
      }
      return { code: src };
    };
    const file = {
      path: "vitest.config.ts",
      content: `import { defineConfig } from 'vitest/config';\nexport default defineConfig() {\n  test: { environment: 'jsdom' },\n}\n`,
    };
    const disk = new Map([[file.path, file.content]]);
    const result = await runVerifyThenStartGate({
      files: [file],
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: drainKnownTypos,
      doctor: (files) => {
        calls++;
        // Naive mock doctor: rewrite `defineConfig() {` → `defineConfig({` and trail `})`
        return files
          .filter(f => f.content.includes("defineConfig() {"))
          .map(f => ({
            file: f.path,
            fixed: f.content
              .replace("defineConfig() {", "defineConfig({")
              .replace(/}\s*$/, "});\n"),
          }));
      },
      maxIterations: 3,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(result.repairedFiles).toContain("vitest.config.ts");
    expect(disk.get("vitest.config.ts")).toContain("defineConfig({");
    void doctorCalls;
  });

  it("does NOT throw when the doctor itself throws (defensive)", async () => {
    const transform = async () => ({ code: "" });
    const file = { path: "src/A.tsx", content: "export const A = () => <div />;" };
    const disk = new Map([[file.path, file.content]]);
    const result = await runVerifyThenStartGate({
      files: [file],
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: drainKnownTypos,
      doctor: () => { throw new Error("doctor exploded"); },
    });
    expect(result.ok).toBe(true);
  });
});

describe("Task #27 — bucket-3 fixture pack (failing-run-2026-04-18-bucket-3)", () => {
  const FIXTURE_DIR = resolve(__dirname, "__fixtures__/failing-run-2026-04-18-bucket-3");
  const loadFile = (name: string) => readFileSync(resolve(FIXTURE_DIR, name), "utf8");

  it("P8 fixture: confirm-dialog.tsx has its `: void =` annotation stripped", () => {
    const src = loadFile("confirm-dialog.tsx");
    const { content, fixesApplied } = drainKnownTypos(src, "src/confirm-dialog.tsx");
    expect(fixesApplied.find(f => f.id === "void-typed-initializer")?.count).toBeGreaterThanOrEqual(1);
    expect(content).not.toMatch(/:\s*void\s*=/);
  });

  it("P9 fixture: data-table.tsx loses its stray trailing `}`", () => {
    const src = loadFile("data-table.tsx");
    const { content, fixesApplied } = drainKnownTypos(src, "src/data-table.tsx");
    expect(fixesApplied.find(f => f.id === "eof-extra-close-brace")?.count).toBeGreaterThanOrEqual(1);
    const opens = (content.match(/\{/g) || []).length;
    const closes = (content.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });

  it("P10 fixture: components.test.fixture.ts rewrites `<T,/>` → `<T,>`", () => {
    const src = loadFile("components.test.fixture.ts");
    const { content, fixesApplied } = drainKnownTypos(src, "src/__tests__/components.test.ts");
    expect(fixesApplied.find(f => f.id === "generic-self-close-typo")?.count).toBeGreaterThanOrEqual(1);
    expect(content).not.toMatch(/<[A-Z]\w*,\s*\/>/);
    expect(content).toMatch(/<T,>/);
  });

  it("P11 fixture: toaster.tsx loses the extra `)` inside the onClick attr", () => {
    const src = loadFile("toaster.tsx");
    const { content, fixesApplied } = drainKnownTypos(src, "src/toaster.tsx");
    expect(fixesApplied.find(f => f.id === "jsx-attr-extra-close-paren")?.count).toBeGreaterThanOrEqual(1);
    expect(content).toContain("dismiss(toast.id)}");
    expect(content).not.toContain("dismiss(toast.id))}");
  });

  it("Phase 2 fixture: setup.ts call-block `vi.fn() {` → `vi.fn({` rewrite", () => {
    const src = loadFile("setup.ts");
    const { content, fixesApplied } = drainKnownTypos(src, "src/__tests__/setup.ts");
    // The Phase-2 call-options-block rule should have fired at least once
    // on the `fetchUser: vi.fn() {` line.
    expect(fixesApplied.find(f => f.id === "call-options-block")?.count).toBeGreaterThanOrEqual(1);
    expect(content).not.toMatch(/vi\.fn\(\)\s*\{/);
  });

  it("Doctor fixture: vitest.config.ts gets the call-block rewrite via doctor", async () => {
    const { runViteTailwindDoctor } = await import("./vite-tailwind-doctor");
    const src = loadFile("vitest.config.ts");
    const report = runViteTailwindDoctor(
      { files: [{ path: "vitest.config.ts", content: src }] },
      "preflight",
    );
    const change = report.codeChanges.find(c => c.file === "vitest.config.ts");
    expect(change).toBeDefined();
    expect(change!.fixed).toContain("defineConfig({");
    expect(change!.fixed).not.toMatch(/defineConfig\(\)\s*\{/);
  });

  it("end-to-end: verify-gate (with doctor) lands ok=true on bucket-3 across all 6 files", async () => {
    const { runViteTailwindDoctor } = await import("./vite-tailwind-doctor");
    const files = [
      { path: "src/confirm-dialog.tsx",                   content: loadFile("confirm-dialog.tsx") },
      { path: "src/data-table.tsx",                       content: loadFile("data-table.tsx") },
      { path: "src/__tests__/components.test.ts",         content: loadFile("components.test.fixture.ts") },
      { path: "src/toaster.tsx",                          content: loadFile("toaster.tsx") },
      { path: "src/__tests__/setup.ts",                   content: loadFile("setup.ts") },
      { path: "vitest.config.ts",                         content: loadFile("vitest.config.ts") },
    ];
    const disk = new Map(files.map(f => [f.path, f.content]));
    // Mock parser: rejects only the EXACT bucket-3 broken signatures.
    // Each regex must be precise enough not to false-positive on
    // legitimate JSX shapes (e.g. `{xs.map((x) => (...))}` which
    // naturally contains `))}`).
    const transform = async (src: string, opts: { sourcefile?: string }) => {
      const checks: { re: RegExp; text: string }[] = [
        // P8: `: void =` only on a value declaration (skip return-type).
        { re: /(?:const|let|var)\s+\w+\s*:\s*void\s*=/, text: 'Unexpected ":"' },
        // P9: stray double `}}` at EOF (legitimate code never ends `}}`
        // because the outermost block needs only one closing brace).
        { re: /\}\}\s*$/,                                text: 'Unexpected "}"' },
        // P10: malformed generic `<T,/>` (TSX-safe form is `<T,>`).
        { re: /<[A-Z]\w*,\s*\/>/,                       text: 'Expected ">" but found "/"' },
        // P11: extra paren in a JSX attribute callback — match only the
        // exact toaster shape (`dismiss(...)` followed by `))}`), not
        // the bare `))}` that legitimate map expressions produce.
        { re: /\bdismiss\([^()]*\)\)\s*\}/,             text: 'Expected "}" but found ")"' },
        // Phase 2: `vi.fn() {` call-block typo.
        { re: /vi\.fn\(\)\s*\{/,                         text: 'Expected ";" but found "{"' },
        // Doctor: `defineConfig() {` call-block typo.
        { re: /defineConfig\(\)\s*\{/,                  text: 'Expected ";" but found "{"' },
      ];
      for (const { re, text } of checks) {
        if (re.test(src)) {
          const e = Object.assign(new Error("syntax"), {
            errors: [{ text, location: { line: 1, column: 0, file: opts.sourcefile } }],
          });
          throw e;
        }
      }
      return { code: src, map: "", warnings: [] };
    };
    const result = await runVerifyThenStartGate({
      files,
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: drainKnownTypos,
      doctor: (live) => {
        const report = runViteTailwindDoctor({ files: live }, "runtime");
        return report.codeChanges.map(c => ({ file: c.file, fixed: c.fixed }));
      },
      maxIterations: 4,
    });
    expect(result.ok).toBe(true);
    // Every fixture must have been touched at least once.
    expect(result.repairedFiles.length).toBeGreaterThanOrEqual(6);
    // And the final disk content must be free of every broken shape.
    for (const c of disk.values()) {
      expect(c).not.toMatch(/(?:const|let|var)\s+\w+\s*:\s*void\s*=/);
      expect(c).not.toMatch(/\}\}\s*$/);
      expect(c).not.toMatch(/<[A-Z]\w*,\s*\/>/);
      expect(c).not.toMatch(/\bdismiss\([^()]*\)\)\s*\}/);
      expect(c).not.toMatch(/vi\.fn\(\)\s*\{/);
      expect(c).not.toMatch(/defineConfig\(\)\s*\{/);
    }
  });
});

describe("sanitizeLLMOutput — must NOT corrupt arrow-body open braces", () => {
  // Regression for the silent-miss reported in failing-run-2026-04-18:
  // sanitize was appending `)` before `{` on lines like
  //   describe('x', () => {
  // turning them into  describe('x', () => ) {  — which then required the
  // drain to clean up its own corruption, and 8 instances slipped through.
  it("leaves describe/test/it/setTimeout arrow bodies untouched", () => {
    const inputs: { path: string; content: string }[] = [
      { path: "src/__tests__/api.test.ts", content: `describe('API Route Tests', () => {\n  it('x', () => {});\n});\n` },
      { path: "src/__tests__/setup.ts",    content: `const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {\n  return new Response();\n});\n` },
      { path: "src/hooks/use-toast.ts",    content: `setTimeout(() => {\n  doStuff();\n}, 100);\n` },
    ];
    const out = sanitizeLLMOutput(inputs);
    for (const f of out) {
      expect(f.content).not.toMatch(/=>\s*\)\s*\{/);
    }
    expect(out[0].content).toContain("describe('API Route Tests', () => {");
    expect(out[1].content).toContain("=> {");
    expect(out[2].content).toContain("setTimeout(() => {");
  });

  it("still fixes legitimate unclosed-paren lines that are NOT arrow bodies", () => {
    // Line ending in `{` with depth=1 but no `=> {` shape — should still
    // get the `)` inserted (this is the original sanitize behavior).
    const input = [{ path: "src/x.ts", content: `if (foo && bar {\n  doStuff();\n}\n` }];
    const out = sanitizeLLMOutput(input);
    // Sanitize inserts `) ` (with trailing space) before the brace.
    expect(out[0].content).toMatch(/if \(foo && bar\s*\)\s*\{/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Task #13 — stub-on-stagnation in the verify-then-start gate
//
// When the repair loop can't converge on a non-critical file, the gate
// should escalate to template-basement (via the supplied stubGenerator)
// instead of aborting. Critical files keep the existing hard abort.
// ────────────────────────────────────────────────────────────────────────
describe("Task #13 — stub-on-stagnation escalation", () => {
  // A noop drain → guarantees stagnation: errors persist across iterations.
  const noopDrain = (c: string) => ({ content: c, fixesApplied: [] });

  // Mock parser: every input throws unless content matches a stub marker
  // we control, so we can exhaustively exercise the escalation path.
  const STUB_MARKER = "// __STUB_OK__";
  const transform = async (src: string, opts: { sourcefile?: string }) => {
    if (src.startsWith(STUB_MARKER)) return { code: src, map: "", warnings: [] };
    throw Object.assign(new Error("syntax"), {
      errors: [{ text: "Mock parse failure", location: { line: 1, column: 0, file: opts.sourcefile } }],
    });
  };

  const stubGen = (path: string, _reason: string) => ({
    substituted: true,
    content: `${STUB_MARKER}\nexport {};\n`,
  });

  it("stubs a still-broken non-critical file and returns ok=true with degradedMode", async () => {
    const file = { path: "src/__tests__/setup.ts", content: "broken broken broken" };
    const disk = new Map([[file.path, file.content]]);
    const result = await runVerifyThenStartGate({
      files: [file],
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: noopDrain,
      maxIterations: 2,
      criticalityClassifier: (p) => ({
        critical: !/__tests__/.test(p),
        reason: /__tests__/.test(p) ? "test directory" : "critical file",
      }),
      stubGenerator: stubGen,
    });
    expect(result.ok).toBe(true);
    expect(result.degradedMode).toBe(true);
    expect(result.stubbedFiles).toBeDefined();
    expect(result.stubbedFiles!.map(s => s.path)).toEqual(["src/__tests__/setup.ts"]);
    // Disk now holds the stub.
    expect(disk.get("src/__tests__/setup.ts")).toContain(STUB_MARKER);
  });

  it("does NOT stub a still-broken critical file — keeps abort path", async () => {
    const file = { path: "src/main.tsx", content: "broken broken broken" };
    const disk = new Map([[file.path, file.content]]);
    const result = await runVerifyThenStartGate({
      files: [file],
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: noopDrain,
      maxIterations: 2,
      criticalityClassifier: (p) => ({
        critical: /src\/main/.test(p),
        reason: "app entry",
      }),
      stubGenerator: stubGen,
    });
    expect(result.ok).toBe(false);
    expect(result.degradedMode).toBeFalsy();
    expect(result.stubbedFiles).toBeUndefined();
    expect(result.stillBroken.length).toBeGreaterThan(0);
    // Disk untouched — original broken bytes survive.
    expect(disk.get("src/main.tsx")).toBe("broken broken broken");
  });

  it("aborts when at least one critical file is broken even if non-critical files would stub", async () => {
    const files = [
      { path: "src/main.tsx", content: "broken" },             // critical
      { path: "src/__tests__/x.test.ts", content: "broken" },  // non-critical
    ];
    const disk = new Map(files.map(f => [f.path, f.content]));
    const result = await runVerifyThenStartGate({
      files,
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: noopDrain,
      maxIterations: 2,
      criticalityClassifier: (p) => ({
        critical: /src\/main/.test(p),
        reason: "app entry",
      }),
      stubGenerator: stubGen,
    });
    expect(result.ok).toBe(false);
    expect(result.stubbedFiles).toBeUndefined();
    // Critical file untouched. (Non-critical also untouched on abort.)
    expect(disk.get("src/main.tsx")).toBe("broken");
    expect(disk.get("src/__tests__/x.test.ts")).toBe("broken");
  });

  it("when classifier+stubGenerator are NOT supplied, behaviour is unchanged (existing tests still apply)", async () => {
    const file = { path: "src/__tests__/setup.ts", content: "broken" };
    const disk = new Map([[file.path, file.content]]);
    const result = await runVerifyThenStartGate({
      files: [file],
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: noopDrain,
      maxIterations: 2,
    });
    expect(result.ok).toBe(false);
    expect(result.stubbedFiles).toBeUndefined();
    expect(result.degradedMode).toBeFalsy();
  });

  it("does NOT escalate to stub when the normal drain repairs the file in the loop", async () => {
    // Drain that fixes the file by rewriting it to a parse-clean stub
    // marker. With this drain, the loop converges on iteration 1 and the
    // stub-on-stagnation block must NOT run.
    const drainFixes = (_c: string) => ({
      content: `${STUB_MARKER}\nexport const ok = true;\n`,
      fixesApplied: [{ pattern: 'mock', count: 1 }],
    });
    const file = { path: "src/__tests__/setup.ts", content: "broken" };
    const disk = new Map([[file.path, file.content]]);
    const result = await runVerifyThenStartGate({
      files: [file],
      transform,
      read: async (p) => disk.get(p) ?? null,
      write: async (p, c) => { disk.set(p, c); },
      drain: drainFixes,
      maxIterations: 3,
      criticalityClassifier: () => ({ critical: false, reason: "test" }),
      stubGenerator: stubGen,
    });
    expect(result.ok).toBe(true);
    // Repaired by drain — NOT by stub-on-stagnation.
    expect(result.stubbedFiles).toBeUndefined();
    expect(result.degradedMode).toBeFalsy();
    expect(result.repairedFiles).toContain("src/__tests__/setup.ts");
  });
});
