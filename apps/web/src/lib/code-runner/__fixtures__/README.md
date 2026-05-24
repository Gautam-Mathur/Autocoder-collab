# Auto-fix engine fixtures — index

These fixture packs are real, minimized LLM outputs captured by the
self-capture pipeline (`POST /api/diagnostics/capture-failure`, wired
from the verify-gate abort path in `auto-runner.ts`). Each pack feeds a
regression suite in `auto-fix-engine.test.ts` / `auto-runner.test.ts`.

## Captured packs

| Pack | Files | Source shape | Pinned in |
|------|-------|--------------|-----------|
| `failing-run-2026-04-18/` | 5 | `(e) = />` mangled-arrow inside JSX attribute braces (Gemma 2:9b) | engine + runner suites |
| `failing-run-2026-04-18-bucket-2/` | 10 | Vitest config corruption + JSX attr-paren shapes (project-detail / task-detail flavor) | runner suite |
| `failing-run-2026-04-18-bucket-3/` | 6 | Toaster + setup + vitest workspace shapes | runner suite |

## Current test stats

- `auto-fix-engine.test.ts`: **51** tests
- `auto-runner.test.ts`: **94** tests
- **Combined: 145** tests, all green as of the S1+S2 changes

## Latest rules touching these packs

- **P7 ambiguous-mismatch (S1)** — drainKnownTypos no longer bails on
  ambiguous JSX mismatches. After one ambiguous case it continues
  scanning so later, independent void-element promotions (`<input ...>`
  → `<input ... />` plus orphan-closer drop) still apply. Negative-guard
  tests confirm it never invents renames where none are warranted.
- **vite-defineconfig-call-block (S2)** — `vite-tailwind-doctor.ts`
  matches `vite.config.*` AND `vitest.config.*` / `vitest.workspace.*`
  (extensions `ts|js|mjs|cjs|mts|cts`) AND callee allowlist
  `defineConfig|defineProject|defineWorkspaceProject`.

## Adding a new pack

1. Run a generation that fails the verify gate.
2. The runner POSTs `/api/diagnostics/capture-failure` (detached, 5s
   AbortController). Look for `📦 Captured failure to <path>` in the
   API server console.
3. The pack lands here automatically as
   `failing-run-<timestamp>/`. Commit the directory; do NOT hand-edit
   the captured files (they must mirror the LLM-emitted shape exactly).
4. Add fixture-driven tests against the pack and link them in this
   index.
