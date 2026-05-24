# Failing run fixtures — 2026-04-18

These are minimized, real-world LLM outputs captured from a failing
generation run on 2026-04-18. Every file contains at least one
`(e) = />` mangled-arrow typo inside a JSX attribute brace — the exact
shape that previously slipped past the pre-start drain and produced a
silent miss reported as "drain logged 0 mangled-arrow but Vite errored".

These files are used by the `failing-run-2026-04-18 fixture pack`
regression suite (see `auto-fix-engine.test.ts`) which asserts:

1. `auditResidualBrokenPatterns()` flags every file BEFORE drain runs.
2. `drainKnownTypos()` repairs every file (no `= />` remains).
3. After repair, `auditResidualBrokenPatterns()` returns `[]`.
4. `runVerifyThenStartGate()` (with mock parser) lands `ok: true` after
   ≤ 3 iterations and `repairedFiles` covers all five paths.
