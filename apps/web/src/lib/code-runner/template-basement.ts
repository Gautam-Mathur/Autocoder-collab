// template-basement.ts — last-resort minimal substitution.
//
// Layer 3 of the three-layer cascade. When the parser-gate still
// reports an error after the SLM-repair budget is exhausted, replace
// the broken file with a tiny, syntactically-valid stub of the right
// shape so the dev server can boot. The stub carries a banner the
// caller surfaces in the chat UI, telling the user the file was
// reset.
//
// Goal: "the debugger MUST work without a model". This layer is the
// floor — it has no LLM dependency and never fails.

export interface TemplateSubstitution {
  /** True iff a stub was generated. */
  substituted: boolean;
  /** Stub file body (with banner comment) when substituted=true. */
  content: string;
  /** Human-readable reason surfaced in the UI banner / chat thread. */
  banner: string;
  /** Stub kind chosen for the file. */
  kind: "react-component" | "react-hook" | "react-page" | "ts-module" | "js-module";
}

const TSX = /\.tsx$/i;
const JSX = /\.jsx$/i;
const TS = /\.(?:ts|mts|cts)$/i;
const JS = /\.(?:js|mjs|cjs)$/i;

function basenameNoExt(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

function pascalCase(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  if (!cleaned) return "Stub";
  const joined = cleaned
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  // Identifiers must not start with a digit; prefix with `Stub` and keep the rest.
  if (/^[0-9]/.test(joined)) return `Stub${joined}`;
  return joined;
}

/**
 * Make a hook-shaped identifier from a raw filename basename. Hooks must
 * start with `use` followed by an uppercase letter; anything that breaks
 * that invariant gets normalized.
 */
function hookIdent(rawBase: string): string {
  // Strip any non-identifier chars (e.g. `useAuth-v2` → `useAuthv2`).
  const cleaned = rawBase.replace(/[^a-zA-Z0-9]/g, "");
  if (/^use[A-Z]/.test(cleaned)) return cleaned;
  if (/^use/.test(cleaned)) {
    // useauth → useAuth
    return "use" + cleaned.charAt(3).toUpperCase() + cleaned.slice(4);
  }
  return "useStub";
}

function bannerLines(reason: string): string[] {
  return [
    "// ────────────────────────────────────────────────────────────────",
    "// 🛟 AutoCoder template-basement — file reset to a minimal stub.",
    `// Reason: ${reason}`,
    "// The original file produced syntax errors that neither the parser-",
    "// gate's mechanical fixers nor the SLM-repair pass could resolve",
    "// within their budgets. This stub keeps the dev server running so",
    "// you can fix or regenerate the real component.",
    "// ────────────────────────────────────────────────────────────────",
    "",
  ];
}

export function generateStub(
  path: string,
  reason: string,
): TemplateSubstitution {
  const rawBase = basenameNoExt(path);
  const name = pascalCase(rawBase);
  const banner = bannerLines(reason).join("\n");
  const isHook = /^use[A-Z]/.test(rawBase);

  // Hook stubs apply to .ts AND .tsx because hooks may live in either.
  if (isHook && (TSX.test(path) || JSX.test(path) || TS.test(path))) {
    const hk = hookIdent(rawBase);
    return {
      substituted: true,
      kind: "react-hook",
      banner: reason,
      content:
        banner +
        `export function ${hk}() {\n` +
        `  return { ready: false } as const;\n` +
        `}\n` +
        `export default ${hk};\n`,
    };
  }

  // Prefer concrete React stubs for tsx/jsx — anything imported as a
  // component will at least render an empty fragment and not crash the
  // app. Pages get a visible banner.
  if (TSX.test(path) || JSX.test(path)) {
    const isPage = /\/(?:pages?|routes?)\//i.test(path);
    if (isPage) {
      return {
        substituted: true,
        kind: "react-page",
        banner: reason,
        content:
          banner +
          `export default function ${name}() {\n` +
          `  return (\n` +
          `    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>\n` +
          `      <h2>${name} — temporarily unavailable</h2>\n` +
          `      <p style={{ opacity: 0.7 }}>This page was reset by AutoCoder's template-basement after repeated syntax errors. Regenerate or hand-edit the file to restore it.</p>\n` +
          `    </div>\n` +
          `  );\n` +
          `}\n`,
      };
    }
    return {
      substituted: true,
      kind: "react-component",
      banner: reason,
      content:
        banner +
        `export function ${name}() {\n` +
        `  return null;\n` +
        `}\n` +
        `export default ${name};\n`,
    };
  }

  if (TS.test(path)) {
    return {
      substituted: true,
      kind: "ts-module",
      banner: reason,
      content: banner + `export {};\n`,
    };
  }
  if (JS.test(path)) {
    return {
      substituted: true,
      kind: "js-module",
      banner: reason,
      content: banner + `module.exports = {};\n`,
    };
  }
  return {
    substituted: false,
    kind: "ts-module",
    banner: reason,
    content: "",
  };
}
