// repair.ts — bridge endpoint between the browser-side three-layer cascade
// and the local LLM (Ollama / Gemma / qwen2.5-coder). Receives a single
// file + parse-error + bounded code window; returns a corrected file body.
//
// Hard rules:
//   • Single file in, single file out — no batch creep.
//   • Strict JSON contract; never echoes raw model output without
//     stripping markdown fences.
//   • Bounded prompt: we send only what the cascade gave us.
//   • Soft fail: if no model is available, return 503 so the cascade
//     falls through to template-basement instead of crashing.

import { Router, type Request, type Response } from "express";
import {
  generateWithLocalLLM,
  isLocalLLMAvailable,
  getDefaultGemmaModel,
} from "../src/modules/local-llm-client";

const router = Router();

interface RepairRequestBody {
  path?: string;
  error?: {
    line?: number;
    column?: number;
    message?: string;
    reasonCode?: string | null;
  };
  window?: {
    text?: string;
    start?: number;
    end?: number;
  };
}

const SYSTEM_PROMPT = [
  "You are a precise JavaScript/TypeScript syntax repair tool.",
  "You receive ONE bounded code window (a slice of a larger file) plus the parser error inside it.",
  "Output ONLY the corrected window — same line range, no surrounding file content.",
  "Strip the '> 17| ' line-number prefix from your output; emit raw code lines only.",
  "Preserve indentation, imports/exports inside the window, and logic.",
  "If you cannot fix it confidently, output exactly: NO_FIX",
].join("\n");

function stripFences(s: string): string {
  // Tolerate models that wrap output despite instructions.
  const fenced = s.match(/```(?:tsx?|jsx?|ts|js)?\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1];
  return s;
}

// ── First-pass regex drain ────────────────────────────────────────────────
// Mirrors the browser-side `drainKnownTypos` ruleset. Runs BEFORE the LLM
// path so high-confidence mechanical typos repair instantly without needing
// a local model. This is what makes the cascade survive an Ollama-less
// environment — without it, the route 503's and the cascade falls through
// to template-basement, which is the failure documented in
// REPORT-pipeline-failure-2026-05-16.md.
//
// TODO: extract into a shared @workspace/code-drain lib so this never
// diverges from the browser-side drain in auto-fix-engine.ts.
function tryRegexDrain(
  path: string,
  windowText: string,
): { fixed: string; rules: string[] } | null {
  // Strip line-number prefixes slm-repair adds when building the window
  // block (e.g. `  74 | <code>` or `> 76 | <code>`). The client's
  // spliceWindow strips them again on the way back, so emitting raw lines
  // is correct and necessary for the regex drain to operate.
  const rawLines = windowText
    .split("\n")
    .map((l) => l.replace(/^[> ]\s*\d+\|\s?/, ""));
  let raw = rawLines.join("\n");

  const fixes: string[] = [];
  const isJsx = /\.(?:jsx|tsx)$/.test(path);

  // Mangled arrow `(...)= />` → `(...) =>`. Loosened (vs the browser's
  // P1 rule) to allow newlines between `)` and `=` and between `=` and `/>`.
  const before1 = raw;
  raw = raw.replace(/\)\s*=\s*\/>/g, ") =>");
  if (raw !== before1) fixes.push("mangled-arrow");

  // Bare-identifier arrow inside JSX attribute brace — `={ident = />`.
  if (isJsx) {
    const before2 = raw;
    raw = raw.replace(
      /(=\{\s*[A-Za-z_$][\w$]*)(\s*)=(\s*)\/>/g,
      (_m, head: string, s1: string) => `${head}${s1}=>`,
    );
    if (raw !== before2) fixes.push("mangled-arrow-attr");
  }

  // `=> ) {` → `=> {` (stray paren before arrow body brace).
  const before3 = raw;
  raw = raw.replace(/=>(\s*)\)(\s*)\{/g, "=>$1$2{");
  if (raw !== before3) fixes.push("empty-arrow-stray-paren-brace");

  // `= > foo` → `=> foo` (broken arrow with stray space).
  const before4 = raw;
  raw = raw.replace(/=\s+>\s*/g, "=> ");
  if (raw !== before4) fixes.push("split-arrow");

  if (fixes.length === 0) return null;
  return { fixed: raw, rules: fixes };
}

router.post("/repair/syntax", async (req: Request, res: Response) => {
  const body = req.body as RepairRequestBody;
  const path = body?.path;
  const win = body?.window ?? {};
  if (!path || typeof win.text !== "string") {
    return res.status(400).json({ error: "path and window.text are required" });
  }
  const err = body.error ?? {};

  // ── 1. Pure-regex drain (no model required) ────────────────────────────
  // High-confidence LLM typo shapes are repaired here in microseconds.
  // Only when no rule matches do we consider the LLM path.
  try {
    const drained = tryRegexDrain(path, win.text);
    if (drained) {
      return res.json({
        window: drained.fixed,
        reason: `drained: ${drained.rules.join(", ")}`,
      });
    }
  } catch {
    // Drain failures are non-fatal — fall through to the LLM path.
  }

  // ── 2. Local LLM path (only for shapes the regex drain can't handle) ──
  let modelAvailable = false;
  try {
    modelAvailable = await isLocalLLMAvailable();
  } catch {
    modelAvailable = false;
  }
  if (!modelAvailable) {
    return res.status(503).json({
      window: null,
      reason: "no rule matched and no local model available — falling through to template-basement",
    });
  }

  const userPrompt = [
    `File path: ${path}`,
    `Parser error at line ${err.line ?? "?"}, column ${err.column ?? "?"}: ${err.message ?? "(no message)"}`,
    err.reasonCode ? `Reason code: ${err.reasonCode}` : "",
    "",
    `Code window (lines ${win.start ?? "?"}–${win.end ?? "?"}, > marks the offending line):`,
    win.text,
    "",
    "Output the corrected window only. Strip the '> 17| ' prefix; emit raw code lines.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const baseUrl =
      process.env.LOCAL_LLM_URL ||
      process.env.OPENAI_BASE_URL ||
      "http://localhost:11434";
    const model =
      process.env.LOCAL_LLM_MODEL ||
      process.env.OPENAI_MODEL ||
      getDefaultGemmaModel();
    const raw = await generateWithLocalLLM(userPrompt, SYSTEM_PROMPT, {
      baseUrl,
      model,
      timeout: 25_000,
    });
    const trimmed = stripFences(raw).trim();
    if (!trimmed || trimmed === "NO_FIX") {
      return res.json({ window: null, reason: "model returned NO_FIX or empty" });
    }
    return res.json({ window: trimmed, reason: "" });
  } catch (e) {
    return res.status(502).json({
      window: null,
      reason: `LLM call failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
});

export default router;
