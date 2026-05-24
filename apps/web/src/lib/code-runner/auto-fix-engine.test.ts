import { describe, it, expect } from "vitest";
import {
  applyParsedSyntaxFix,
  AUTO_FIX_HANDLERS,
  drainKnownTypos,
  type AutoFixContext,
} from "./auto-fix-engine";

function ctxFor(files: { path: string; content: string }[]): AutoFixContext {
  return {
    files,
    updateFile: async () => {},
    addTerminalLine: () => {},
    retryCount: 0,
  };
}

function fixedContentOf(
  result: ReturnType<typeof applyParsedSyntaxFix>,
  path: string,
): string | null {
  if (!result || !result.fixed || !result.codeChanges) return null;
  const change = result.codeChanges.find((c) => c.file === path);
  return change ? change.fixed : null;
}

describe("applyParsedSyntaxFix — recurring LLM typo patterns", () => {
  it("rewrites useQuery() { → useQuery({ (esbuild)", () => {
    const path = "src/hooks/use-auth.ts";
    const content = `import { useQuery } from "@tanstack/react-query";\nexport function useAuth() {\n  const { data: user, isLoading } = useQuery() {\n    queryKey: ["/api/me"],\n  });\n  return { user, isLoading };\n}\n`;
    const r = applyParsedSyntaxFix(
      "Expected \";\" but found \"{\"",
      ctxFor([{ path, content }]),
      path,
      3,
      47,
      'Expected ";" but found "{"',
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).not.toBeNull();
    expect(fixed).toContain("useQuery({");
    expect(fixed).not.toContain("useQuery() {");
  });

  it("rewrites useMutation() { → useMutation({ (Babel 'Missing semicolon')", () => {
    const path = "src/hooks/use-login.ts";
    const content = `import { useMutation } from "@tanstack/react-query";\nexport function useLogin() {\n  const loginMutation = useMutation() {\n    mutationFn: async () => {},\n  });\n  return loginMutation;\n}\n`;
    const r = applyParsedSyntaxFix(
      "Missing semicolon. (3:38)",
      ctxFor([{ path, content }]),
      path,
      3,
      38,
      "Missing semicolon.",
    );
    expect(fixedContentOf(r, path)).toContain("useMutation({");
  });

  it("rewrites useQuery<any>() { → useQuery<any>({ (preserves type args)", () => {
    const path = "src/hooks/use-item.ts";
    const content = `export function useItem() {\n  const { data: item } = useQuery<any>() {\n    queryKey: ["/api/item"],\n  });\n  return item;\n}\n`;
    const r = applyParsedSyntaxFix(
      'Expected ";" but found "{"',
      ctxFor([{ path, content }]),
      path,
      2,
      41,
      'Expected ";" but found "{"',
    );
    expect(fixedContentOf(r, path)).toContain("useQuery<any>({");
  });

  it("rewrites bare-call statement apiRequest(\"POST\", \"/x\", d) { → apiRequest(\"POST\", \"/x\", d, {", () => {
    const path = "src/lib/api.ts";
    const content = `export async function postIt(d: unknown) {\n  apiRequest("POST", "/x", d) {\n    headers: { "Content-Type": "application/json" },\n  });\n}\n`;
    const r = applyParsedSyntaxFix(
      'Expected ";" but found "{"',
      ctxFor([{ path, content }]),
      path,
      2,
      29,
      'Expected ";" but found "{"',
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).not.toBeNull();
    expect(fixed).toContain('apiRequest("POST", "/x", d, {');
    expect(fixed).not.toContain('apiRequest("POST", "/x", d) {');
  });

  it("rewrites bare-call statement with Babel 'Missing semicolon'", () => {
    const path = "src/lib/api.ts";
    const content = `export function init() {\n  trackEvent("page_view", page) {\n    timestamp: Date.now(),\n  });\n}\n`;
    const r = applyParsedSyntaxFix(
      "Missing semicolon. (2:30)",
      ctxFor([{ path, content }]),
      path,
      2,
      30,
      "Missing semicolon.",
    );
    expect(fixedContentOf(r, path)).toContain('trackEvent("page_view", page, {');
  });

  it("strips trailing comma so fetch(url, ) { → fetch(url, {", () => {
    const path = "src/lib/api.ts";
    const content = `export async function load(url: string) {\n  const res = await fetch(url, ) {\n    method: "GET",\n  });\n  return res.json();\n}\n`;
    const r = applyParsedSyntaxFix(
      'Expected ";" but found "{"',
      ctxFor([{ path, content }]),
      path,
      2,
      33,
      'Expected ";" but found "{"',
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).toContain("fetch(url, {");
    expect(fixed).not.toContain("fetch(url,, {");
  });

  it("drops stray ) in useMemo(() => [) (esbuild Unexpected ')')", () => {
    const path = "src/components/Table.tsx";
    const content = `import { useMemo } from "react";\nexport function Table() {\n  const tableColumns: ColumnDef[] = useMemo(() => [)\n  return null;\n}\n`;
    const r = applyParsedSyntaxFix(
      'Unexpected ")"',
      ctxFor([{ path, content }]),
      path,
      3,
      51,
      'Unexpected ")"',
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).not.toBeNull();
    expect(fixed).not.toContain("useMemo(() => [)");
  });

  it("drops stray ) in .map((s) => ) { (Babel 'Unexpected token', col probe)", () => {
    const path = "src/components/Status.tsx";
    const content = `export function Status() {\n  return (\n    <div>\n      {["active", "pending", "completed"].map((status) => ) {\n        return <span>{status}</span>;\n      })}\n    </div>\n  );\n}\n`;
    const r = applyParsedSyntaxFix(
      "Unexpected token (4:59)",
      ctxFor([{ path, content }]),
      path,
      4,
      59,
      "Unexpected token",
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).not.toBeNull();
    expect(fixed).not.toMatch(/=>\s*\)\s*\{/);
  });
});

describe("applyParsedSyntaxFix — false-positive guards", () => {
  it("does NOT rewrite plain method shorthand foo() {", () => {
    const path = "src/util/x.ts";
    const content = `export const obj = {\n  foo() {\n    return 1;\n  },\n};\n`;
    const r = applyParsedSyntaxFix(
      "Missing semicolon.",
      ctxFor([{ path, content }]),
      path,
      2,
      8,
      "Missing semicolon.",
    );
    expect(fixedContentOf(r, path)).toBeNull();
  });

  it("does NOT rewrite async method shorthand", () => {
    const path = "src/util/x.ts";
    const content = `export const obj = {\n  async foo() {\n    return 1;\n  },\n};\n`;
    const r = applyParsedSyntaxFix(
      "Missing semicolon.",
      ctxFor([{ path, content }]),
      path,
      2,
      14,
      "Missing semicolon.",
    );
    expect(fixedContentOf(r, path)).toBeNull();
  });

  it("does NOT rewrite getter shorthand", () => {
    const path = "src/util/x.ts";
    const content = `export class C {\n  get foo() {\n    return 1;\n  }\n}\n`;
    const r = applyParsedSyntaxFix(
      "Missing semicolon.",
      ctxFor([{ path, content }]),
      path,
      2,
      12,
      "Missing semicolon.",
    );
    expect(fixedContentOf(r, path)).toBeNull();
  });

  it("does NOT rewrite generator shorthand *foo() {", () => {
    const path = "src/util/x.ts";
    const content = `export class C {\n  *foo() {\n    yield 1;\n  }\n}\n`;
    const r = applyParsedSyntaxFix(
      "Missing semicolon.",
      ctxFor([{ path, content }]),
      path,
      2,
      10,
      "Missing semicolon.",
    );
    expect(fixedContentOf(r, path)).toBeNull();
  });
});

describe("applyParsedSyntaxFix — five new LLM typo patterns", () => {
  it("repairs mangled JSX arrow `(e) = />` → `(e) =>` (Babel: Unterminated regular expression)", () => {
    const path = "src/components/NameForm.tsx";
    const content = `export function NameForm() {\n  return (\n    <input onChange={(e) = /> setName(e.target.value)} />\n  );\n}\n`;
    const r = applyParsedSyntaxFix(
      "Unterminated regular expression. (3:25)",
      ctxFor([{ path, content }]),
      path,
      3,
      25,
      "Unterminated regular expression.",
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).not.toBeNull();
    expect(fixed).toContain("(e) =>");
    expect(fixed).not.toContain("= />");
  });

  it("repairs bare empty arrow `=> )` → `=> {}` directly (no following `{`)", () => {
    const path = "src/util/m.ts";
    const content = `export const a = items.map((x) => );\n`;
    const r = applyParsedSyntaxFix(
      'Unexpected ")" (1:34)',
      ctxFor([{ path, content }]),
      path,
      1,
      34,
      'Unexpected ")"',
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).not.toBeNull();
    expect(fixed).toContain("(x) => {}");
    expect(fixed).not.toMatch(/=>\s*\)\s*;/);
  });

  it("removes stray ) before { in empty arrow body `=> ) {` → `=> {`", () => {
    const path = "src/components/Filter.tsx";
    const content = `export function Filter(items: any[]) {\n  return items.filter((item: any) => ) {\n    return item.active;\n  });\n}\n`;
    const r = applyParsedSyntaxFix(
      "Unexpected token (2:36)",
      ctxFor([{ path, content }]),
      path,
      2,
      36,
      "Unexpected token",
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).not.toBeNull();
    expect(fixed).not.toMatch(/=>\s*\)\s*\{/);
    expect(fixed).toContain("=> {");
  });

  it("collapses duplicated `) ) =>` → `) =>` (Babel: Did not expect a type annotation here)", () => {
    const path = "src/util/sort.ts";
    const content = `export function sort(items: any[]) {\n  return items.filter((item: any) ) => item.active);\n}\n`;
    const r = applyParsedSyntaxFix(
      "Did not expect a type annotation here. (2:24)",
      ctxFor([{ path, content }]),
      path,
      2,
      24,
      "Did not expect a type annotation here.",
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).not.toBeNull();
    expect(fixed).not.toMatch(/\)\s+\)\s*=>/);
    expect(fixed).toContain("(item: any) =>");
  });

  it("removes stray ) after JSX tag name `<Tag) attr` → `<Tag attr`", () => {
    const path = "src/components/Card.tsx";
    const content = `export function Card() {\n  return (\n    <div) className="card">\n      <span>Hi</span>\n    </div>\n  );\n}\n`;
    const r = applyParsedSyntaxFix(
      "Expected corresponding JSX closing tag for <div>. (3:5)",
      ctxFor([{ path, content }]),
      path,
      3,
      5,
      "Expected corresponding JSX closing tag for <div>.",
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).not.toBeNull();
    expect(fixed).not.toMatch(/<div\)\s/);
    expect(fixed).toContain('<div className="card">');
  });

  it("does NOT touch valid `key={(e) =>` arrow handlers", () => {
    const path = "src/components/Btn.tsx";
    const content = `export function Btn() {\n  return <button onClick={(e) => e.preventDefault()}>X</button>;\n}\n`;
    const result = drainKnownTypos(content, path);
    expect(result.content).toBe(content);
    expect(result.fixesApplied).toEqual([]);
  });

  it("does NOT mangle valid `<recharts.Line>` JSX (no stray paren)", () => {
    const path = "src/components/Chart.tsx";
    const content = `import { LineChart, Line } from "recharts";\nexport function Chart() {\n  return (\n    <LineChart data={[]}>\n      <Line dataKey="value" />\n    </LineChart>\n  );\n}\n`;
    const result = drainKnownTypos(content, path);
    expect(result.content).toBe(content);
    expect(result.fixesApplied).toEqual([]);
  });
});

describe("drainKnownTypos — whole-file multi-typo sweep", () => {
  it("fixes mangled arrow + empty-arrow stray paren + jsx tag paren in one pass", () => {
    const path = "src/components/Multi.tsx";
    const content = [
      'export function Multi() {',
      '  const items = [1, 2, 3];',
      '  const filtered = items.filter((n: any) => ) {',
      '    return n > 0;',
      '  });',
      '  return (',
      '    <div) className="x">',
      '      <input onChange={(e) = /> console.log(e)} />',
      '      {filtered.map((x) => <span>{x}</span>)}',
      '    </div>',
      '  );',
      '}',
      '',
    ].join("\n");
    const result = drainKnownTypos(content, path);
    expect(result.content).not.toBe(content);
    expect(result.content).not.toMatch(/=>\s*\)\s*\{/);
    expect(result.content).not.toContain("= />");
    expect(result.content).not.toMatch(/<div\)\s/);
    const ids = result.fixesApplied.map((f) => f.id);
    expect(ids).toContain("mangled-arrow");
    expect(ids).toContain("empty-arrow-stray-paren-brace");
    expect(ids).toContain("stray-paren-jsx-tag");
  });

  it("fixes multiple call-options-block sites in one file", () => {
    const path = "src/hooks/use-multi.ts";
    const content = [
      'import { useQuery, useMutation } from "@tanstack/react-query";',
      'export function useMulti() {',
      '  const { data: u } = useQuery() {',
      '    queryKey: ["/api/me"],',
      '  });',
      '  const m = useMutation() {',
      '    mutationFn: async () => {},',
      '  });',
      '  return { u, m };',
      '}',
      '',
    ].join("\n");
    const result = drainKnownTypos(content, path);
    expect(result.content).toContain("useQuery({");
    expect(result.content).toContain("useMutation({");
    expect(result.content).not.toContain("useQuery() {");
    expect(result.content).not.toContain("useMutation() {");
    const callBlock = result.fixesApplied.find((f) => f.id === "call-options-block");
    expect(callBlock?.count).toBeGreaterThanOrEqual(2);
  });

  it("call-options-block: fires when a comment follows `{` on the same line (EOL-anchor drop)", () => {
    // Captured shape from setup.ts:53:59 — the `{` is followed by a
    // trailing comment on the SAME line, which the previous `\{(\s*)$`
    // anchor refused to match because it required end-of-line right after
    // the `{`. The body+matching `}` are still on subsequent lines, so
    // applyParsedSyntaxFix's brace tracking still works.
    const path = "src/__tests__/setup.ts";
    const content = [
      'import { vi } from "vitest";',
      'export const mocks = {',
      '  fetchUser: vi.fn() { // returns mock user',
      '    queryKey: ["/api/me"],',
      '  }),',
      '};',
      '',
    ].join("\n");
    const result = drainKnownTypos(content, path);
    const callBlock = result.fixesApplied.find((f) => f.id === "call-options-block");
    expect(callBlock?.count).toBeGreaterThanOrEqual(1);
    expect(result.content).toContain("vi.fn({");
  });

  it("call-options-block: refuses to rewrite when executable tokens follow `{` (no truncation)", () => {
    // Defense after EOL-anchor narrowing: the rewriter replaces the whole
    // line with `head + newArgs`, so a same-line body like
    //   `vi.fn() { return mockUser; },`
    // must NOT be rewritten — that would silently drop the body. Better
    // to leave it for a future rule than to corrupt the file.
    const path = "src/__tests__/inline-body.ts";
    const content = [
      'import { vi } from "vitest";',
      'export const mocks = {',
      '  fetchUser: vi.fn() { return mockUser; },',
      '};',
      '',
    ].join("\n");
    const before = content;
    const result = drainKnownTypos(content, path);
    const callBlock = result.fixesApplied.find((f) => f.id === "call-options-block");
    expect(callBlock).toBeUndefined();
    // Body content must be preserved exactly — no truncation.
    expect(result.content).toContain("return mockUser;");
    expect(result.content).toBe(before);
  });

  it("call-options-block: still skips function/method declaration shapes", () => {
    // Defense check after EOL-anchor drop: declaration-shaped lines must
    // not be rewritten just because they have content after `{`.
    const path = "src/util/decl.ts";
    const content = [
      'export function foo() { return 1; }',
      'class Bar { method() { return 2; } }',
      'const arrow = () => { return 3; };',
      '',
    ].join("\n");
    const result = drainKnownTypos(content, path);
    const callBlock = result.fixesApplied.find((f) => f.id === "call-options-block");
    expect(callBlock).toBeUndefined();
    expect(result.content).toContain("function foo()");
    expect(result.content).toContain("method()");
  });

  it("collapses `) ) =>` typed param duplicate parens across the file", () => {
    const path = "src/util/x.ts";
    const content = `export const a = (x: number) ) => x + 1;\nexport const b = (y: string) ) => y.length;\n`;
    const result = drainKnownTypos(content, path);
    expect(result.content).not.toMatch(/\)\s+\)\s*=>/);
    const dup = result.fixesApplied.find((f) => f.id === "duplicated-paren-type-annot");
    expect(dup?.count).toBe(2);
  });

  it("skips vite.config.ts (delegated to doctor)", () => {
    const path = "vite.config.ts";
    const content = `import { defineConfig } from "vite";\nexport default defineConfig() {\n  plugins: [],\n});\n`;
    const result = drainKnownTypos(content, path);
    expect(result.content).toBe(content);
    expect(result.fixesApplied).toEqual([]);
  });

  it("returns the file unchanged when there are no known typos (real recharts/react-hook-form)", () => {
    const path = "src/components/Form.tsx";
    const content = [
      'import { useForm } from "react-hook-form";',
      'import { LineChart, Line, XAxis } from "recharts";',
      '',
      'export function Form() {',
      '  const { register, handleSubmit } = useForm();',
      '  return (',
      '    <form onSubmit={handleSubmit((data) => console.log(data))}>',
      '      <input {...register("name")} />',
      '      <LineChart data={[]} width={400} height={200}>',
      '        <Line dataKey="v" stroke="#000" />',
      '        <XAxis dataKey="t" />',
      '      </LineChart>',
      '    </form>',
      '  );',
      '}',
      '',
    ].join("\n");
    const result = drainKnownTypos(content, path);
    expect(result.content).toBe(content);
    expect(result.fixesApplied).toEqual([]);
  });

  it("drains multi-site bare `=> )` empty-arrow stray parens (no `{` after)", () => {
    const path = "src/util/many.ts";
    const content = [
      'export const a = items.map((x) => );',
      'export const b = items.filter((y) => );',
      'export const c = items.reduce((z) => ), 0);',
      '',
    ].join("\n");
    const result = drainKnownTypos(content, path);
    expect(result.content).not.toMatch(/=>\s*\)\s*(?=[;,\)\n])/);
    expect(result.content).toContain("(x) => {}");
    expect(result.content).toContain("(y) => {}");
    expect(result.content).toContain("(z) => {}");
    const bare = result.fixesApplied.find((f) => f.id === "empty-arrow-stray-paren-bare");
    expect(bare?.count).toBe(3);
  });

  it("does NOT touch valid `() => fn()` arrows whose closing `)` is the call's, not a stray", () => {
    const path = "src/util/safe.ts";
    const content = `export const a = items.map((x) => fn(x));\nexport const b = items.filter((y) => y > 0);\n`;
    const result = drainKnownTypos(content, path);
    expect(result.content).toBe(content);
    expect(result.fixesApplied).toEqual([]);
  });

  it("converges within iteration cap (no infinite loop)", () => {
    const path = "src/util/dense.ts";
    // 30 mangled arrows in one buffer
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(`export const f${i} = (e) = /> e * ${i};`);
    }
    const content = lines.join("\n") + "\n";
    const result = drainKnownTypos(content, path);
    expect(result.content).not.toContain("= />");
    const mangled = result.fixesApplied.find((f) => f.id === "mangled-arrow");
    expect(mangled?.count).toBe(30);
  });
});

describe("applyParsedSyntaxFix — hook empty-array body & JSX tag mismatch", () => {
  it("repairs `useMemo(() => [)` to `useMemo(() => [], [])` (preserves deps)", () => {
    const path = "src/components/Table.tsx";
    const content = `import { useMemo } from "react";\nexport function Table() {\n  const cols = useMemo(() => [)\n  return null;\n}\n`;
    const r = applyParsedSyntaxFix(
      'Unexpected ")"',
      ctxFor([{ path, content }]),
      path,
      3,
      28,
      'Unexpected ")"',
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).not.toBeNull();
    expect(fixed).toContain("useMemo(() => [], [])");
    expect(fixed).not.toContain("useMemo(() => [)");
    expect(fixed).not.toContain("useMemo(() => [\n");
  });

  it("repairs `useCallback(() => [)` to `useCallback(() => [], [])`", () => {
    const path = "src/hooks/use-x.ts";
    const content = `import { useCallback } from "react";\nexport const f = useCallback(() => [)\n`;
    const r = applyParsedSyntaxFix(
      'Unexpected ")"',
      ctxFor([{ path, content }]),
      path,
      2,
      35,
      'Unexpected ")"',
    );
    expect(fixedContentOf(r, path)).toContain("useCallback(() => [], [])");
  });

  it("repairs `useEffect(() => [)` to `useEffect(() => [], [])`", () => {
    const path = "src/components/A.tsx";
    const content = `import { useEffect } from "react";\nexport function A() {\n  useEffect(() => [)\n  return null;\n}\n`;
    const r = applyParsedSyntaxFix(
      'Unexpected ")"',
      ctxFor([{ path, content }]),
      path,
      3,
      20,
      'Unexpected ")"',
    );
    expect(fixedContentOf(r, path)).toContain("useEffect(() => [], [])");
  });

  it("does NOT touch valid `useMemo(() => [a, b], [a, b])`", () => {
    const path = "src/components/Table.tsx";
    const content = `import { useMemo } from "react";\nexport function Table(a: any, b: any) {\n  const cols = useMemo(() => [a, b], [a, b]);\n  return cols;\n}\n`;
    const result = drainKnownTypos(content, path);
    expect(result.content).toBe(content);
    expect(result.fixesApplied).toEqual([]);
  });

  it("repairs generic `=> [)` (non-hook) by closing the array before the paren", () => {
    const path = "src/util/x.ts";
    const content = `export const a = items.map((x: any) => [)\n`;
    const r = applyParsedSyntaxFix(
      'Unexpected ")"',
      ctxFor([{ path, content }]),
      path,
      1,
      40,
      'Unexpected ")"',
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).not.toBeNull();
    expect(fixed).toContain("=> [])");
    expect(fixed).not.toContain("=> [)");
  });

  it("rewrites mismatched JSX closing tag </Link> → </div> when error names both", () => {
    const path = "src/components/Card.tsx";
    const content = `export function Card() {\n  return (\n    <div className="card">\n      Hello\n    </Link>\n  );\n}\n`;
    const r = applyParsedSyntaxFix(
      'Unexpected closing "Link" tag does not match opening "div" tag.',
      ctxFor([{ path, content }]),
      path,
      5,
      4,
      'Unexpected closing "Link" tag does not match opening "div" tag.',
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).not.toBeNull();
    expect(fixed).toContain("</div>");
    expect(fixed).not.toContain("</Link>");
  });

  it("does NOT touch a closing tag whose name legitimately matches", () => {
    const path = "src/components/Card.tsx";
    const content = `export function Card() {\n  return (\n    <div className="card">\n      <span>x</span>\n    </div>\n  );\n}\n`;
    // A closing-tag error with matching names shouldn't fire the rewrite
    // path (it would do nothing because wrong === right is guarded), and the
    // rest of the handler chain should also leave the file alone.
    const r = applyParsedSyntaxFix(
      'Some other error',
      ctxFor([{ path, content }]),
      path,
      4,
      6,
      'Some other error',
    );
    expect(fixedContentOf(r, path)).toBeNull();
  });
});

describe("drainKnownTypos — hook + JSX-attribute coverage", () => {
  it("repairs multiple `(e) = />` sites inside JSX attributes (real failing shape)", () => {
    const path = "src/pages/auth-page.tsx";
    const content = [
      'export function AuthPage() {',
      '  return (',
      '    <form>',
      '      <input',
      '        type="email"',
      '        onChange={(e) = /> setEmail(e.target.value)}',
      '      />',
      '      <input',
      '        type="password"',
      '        onChange={(e) = /> setPassword(e.target.value)}',
      '      />',
      '    </form>',
      '  );',
      '}',
      '',
    ].join("\n");
    const result = drainKnownTypos(content, path);
    expect(result.content).not.toBe(content);
    expect(result.content).not.toContain("= />");
    const mangled = result.fixesApplied.find((f) => f.id === "mangled-arrow");
    expect(mangled?.count).toBe(2);
  });

  it("drain repairs hook empty-array bodies without per-error trigger", () => {
    const path = "src/pages/dashboard.tsx";
    const content = [
      'import { useMemo, useCallback } from "react";',
      'export function Dashboard() {',
      '  const cols = useMemo(() => [)',
      '  const onChange = useCallback(() => [)',
      '  return null;',
      '}',
      '',
    ].join("\n");
    const result = drainKnownTypos(content, path);
    expect(result.content).toContain("useMemo(() => [], [])");
    expect(result.content).toContain("useCallback(() => [], [])");
    const hook = result.fixesApplied.find((f) => f.id === "hook-empty-array-body");
    expect(hook?.count).toBe(2);
  });

  it("repairs MULTI-LINE useMemo array body without orphaning entries (per-error path)", () => {
    const path = "src/pages/projects-page.tsx";
    const content = [
      'import { useMemo } from "react";',
      'export function ProjectsPage() {',
      '  const tableColumns: any[] = useMemo(() => [)',
      '    { key: "name", header: "Name" },',
      '    { key: "status", header: "Status" },',
      '  ], [])',
      '  return tableColumns;',
      '}',
      '',
    ].join("\n");
    const r = applyParsedSyntaxFix(
      'Unexpected ")"',
      ctxFor([{ path, content }]),
      path,
      3,
      51,
      'Unexpected ")"',
    );
    const fixed = fixedContentOf(r, path);
    expect(fixed).not.toBeNull();
    // The stray ")" must be gone; the existing "])" closes the array.
    expect(fixed).not.toContain("useMemo(() => [)");
    expect(fixed).toContain("useMemo(() => [");
    // Empty-array repair would have produced this — must NOT happen here.
    expect(fixed).not.toContain("useMemo(() => [], [])");
    // Entries are preserved intact.
    expect(fixed).toContain('{ key: "name", header: "Name" }');
    expect(fixed).toContain('{ key: "status", header: "Status" }');
    // Closing "], [])" line is still there.
    expect(fixed).toMatch(/\]\s*,\s*\[\]\s*\)/);
  });

  it("drain repairs MULTI-LINE useMemo array body without orphaning entries", () => {
    const path = "src/pages/team-page.tsx";
    const content = [
      'import { useMemo } from "react";',
      'export function Team() {',
      '  const cols = useMemo(() => [)',
      '    { key: "name" },',
      '    { key: "role" },',
      '  ], [])',
      '  return cols;',
      '}',
      '',
    ].join("\n");
    const result = drainKnownTypos(content, path);
    expect(result.content).not.toContain("useMemo(() => [)");
    expect(result.content).not.toContain("useMemo(() => [], [])");
    expect(result.content).toContain('useMemo(() => [');
    expect(result.content).toContain('{ key: "name" }');
    expect(result.content).toContain('{ key: "role" }');
    const multi = result.fixesApplied.find((f) => f.id === "hook-multiline-array-stray-paren");
    expect(multi?.count).toBe(1);
    const empty = result.fixesApplied.find((f) => f.id === "hook-empty-array-body");
    expect(empty).toBeUndefined();
  });

  it("drain still repairs GENUINELY EMPTY useMemo body to `[], []`", () => {
    const path = "src/components/Empty.tsx";
    const content = [
      'import { useMemo } from "react";',
      'export function Empty() {',
      '  const cols = useMemo(() => [)',
      '  return cols;',
      '}',
      '',
    ].join("\n");
    const result = drainKnownTypos(content, path);
    expect(result.content).toContain("useMemo(() => [], [])");
    expect(result.content).not.toContain("useMemo(() => [)");
    const empty = result.fixesApplied.find((f) => f.id === "hook-empty-array-body");
    expect(empty?.count).toBe(1);
    const multi = result.fixesApplied.find((f) => f.id === "hook-multiline-array-stray-paren");
    expect(multi).toBeUndefined();
  });

  it("drain handles a file with BOTH shapes — empty + multi-line — in one pass", () => {
    const path = "src/pages/mixed.tsx";
    const content = [
      'import { useMemo, useCallback } from "react";',
      'export function Mixed() {',
      '  const empty = useMemo(() => [)',
      '  const filled = useCallback(() => [)',
      '    { id: 1 },',
      '    { id: 2 },',
      '  ], [])',
      '  return { empty, filled };',
      '}',
      '',
    ].join("\n");
    const result = drainKnownTypos(content, path);
    expect(result.content).toContain("useMemo(() => [], [])");
    expect(result.content).toContain("useCallback(() => [");
    expect(result.content).not.toContain("useCallback(() => [], [])");
    expect(result.content).toContain('{ id: 1 }');
    const empty = result.fixesApplied.find((f) => f.id === "hook-empty-array-body");
    const multi = result.fixesApplied.find((f) => f.id === "hook-multiline-array-stray-paren");
    expect(empty?.count).toBe(1);
    expect(multi?.count).toBe(1);
  });

  it("drain leaves a hook with proper deps array untouched", () => {
    const path = "src/util/safe.ts";
    const content = `import { useMemo } from "react";\nexport const x = (a: any) => useMemo(() => [a], [a]);\n`;
    const result = drainKnownTypos(content, path);
    expect(result.content).toBe(content);
    expect(result.fixesApplied).toEqual([]);
  });

  it("drain finds mangled-arrow in a file even when no per-error report ever pointed at it (final-pass scenario)", () => {
    const path = "src/pages/projects-page.tsx";
    // 60 lines of normal code, then a mangled arrow at line 61 — esbuild
    // would have stopped reporting before reaching it.
    const filler = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join("\n");
    const content = `${filler}\n<input onChange={(e) = /> handler(e)} />\n`;
    const result = drainKnownTypos(content, path);
    expect(result.content).not.toContain("= />");
    const mangled = result.fixesApplied.find((f) => f.id === "mangled-arrow");
    expect(mangled?.count).toBe(1);
  });
});

describe("AUTO_FIX_HANDLERS — dispatcher ordering", () => {
  it("multi-line esbuild dep-scan dispatcher precedes Vite/Tailwind catch-all", () => {
    const handlers = AUTO_FIX_HANDLERS;
    const dispatcherIdx = handlers.findIndex((h) =>
      h.pattern.source.includes("\\u2718") ||
      h.pattern.source.includes("✘") ||
      (h.pattern.source.includes("ERROR") && h.pattern.source.includes("\\d+:\\d+")),
    );
    const catchAllIdx = handlers.findIndex((h) =>
      h.pattern.source.includes("vite") &&
      h.pattern.source.includes("tailwind") &&
      h.pattern.source.includes("postcss"),
    );
    expect(dispatcherIdx).toBeGreaterThanOrEqual(0);
    expect(catchAllIdx).toBeGreaterThanOrEqual(0);
    expect(dispatcherIdx).toBeLessThan(catchAllIdx);
  });

  it("Vite/Tailwind catch-all bails out on multi-line dep-scan blocks", () => {
    const handlers = AUTO_FIX_HANDLERS;
    const catchAll = handlers.find((h) =>
      h.pattern.source.includes("vite") &&
      h.pattern.source.includes("tailwind") &&
      h.pattern.source.includes("postcss"),
    );
    expect(catchAll).toBeDefined();
    const depScanBlock = `Error: Failed to scan for dependencies from entries:\n  /home/x/index.html\n\n✘ [ERROR] Expected ";" but found "{"\n\n    src/hooks/use-auth.ts:5:47:\n      5 │   const { data: user, isLoading } = useQuery() {\n        │                                                ^\n        ╵                                                ;\n\nat node_modules/esbuild-wasm/lib/main.js:1234`;
    const result = catchAll!.handler(depScanBlock, ctxFor([
      {
        path: "src/hooks/use-auth.ts",
        content: 'const { data: user, isLoading } = useQuery() {\n  queryKey: [],\n});\n',
      },
    ]));
    expect(result).toBeNull();
  });
});

describe("S1 — JSX P7 ambiguous-mismatch keeps scanning", () => {
  it("after one ambiguous mismatch, still promotes a later void-element opener", () => {
    // First mismatch is non-void with nested opens (ambiguous → previously
    // bailed with `break`). Second region has a stray `</Input>` after a
    // self-closing-shaped void opener which the engine should still promote
    // and clean up. Asserts the post-bail scanning continues.
    const path = "src/Form.tsx";
    const content =
      `export function Form() {\n` +
      `  return (\n` +
      `    <Section>\n` +
      `      <Wrong>\n` +
      `        <Inner />\n` +
      `      </Different>\n` +
      `      <input type="text" placeholder="x">\n` +
      `      </Input>\n` +
      `    </Section>\n` +
      `  );\n` +
      `}\n`;
    const result = drainKnownTypos(content, path);
    expect(result.content).not.toBe(content);
    // Branch (b) should promote the void opener to self-closing and drop
    // the orphan </Input> closer, even though the earlier </Different>
    // mismatch was ambiguous and could only be safely skipped.
    expect(result.content).toContain('<input type="text" placeholder="x" />');
    expect(result.content).not.toContain("</Input>");
  });

  it("after ambiguous mismatch, does NOT incorrectly rename a later well-formed close", () => {
    // A balanced <Card>...</Card> appearing after an ambiguous mismatch
    // must remain untouched — the continue-on-ambiguous behavior should
    // only enable LATER fixes, never invent renames where none are needed.
    const path = "src/Page.tsx";
    const content =
      `export function Page() {\n` +
      `  return (\n` +
      `    <Section>\n` +
      `      <Wrong>\n` +
      `        <Inner />\n` +
      `      </Different>\n` +
      `      <Card>\n` +
      `        <span>ok</span>\n` +
      `      </Card>\n` +
      `    </Section>\n` +
      `  );\n` +
      `}\n`;
    const result = drainKnownTypos(content, path);
    expect(result.content).toContain("<Card>");
    expect(result.content).toContain("</Card>");
    // The well-formed Card pair must not have been rewritten.
    expect(result.content).not.toMatch(/<\/Wrong>\s*\n\s*<\/Card>/);
  });

  it("two ambiguous mismatches plus a later void promotion: only the void is fixed", () => {
    const path = "src/Mixed.tsx";
    const content =
      `export function Mixed() {\n` +
      `  return (\n` +
      `    <Outer>\n` +
      `      <A>\n` +
      `        <Inner />\n` +
      `      </Z>\n` +
      `      <B>\n` +
      `        <Inner2 />\n` +
      `      </Y>\n` +
      `      <input type="email">\n` +
      `      </Input>\n` +
      `    </Outer>\n` +
      `  );\n` +
      `}\n`;
    const result = drainKnownTypos(content, path);
    // Void promotion still happens at the end of the cascade.
    expect(result.content).toContain('<input type="email" />');
    expect(result.content).not.toContain("</Input>");
    // The two ambiguous closers stay as-is (we did not invent rewrites).
    expect(result.content).toContain("</Z>");
    expect(result.content).toContain("</Y>");
  });
});

describe("S2 — vite-tailwind-doctor defineConfig coverage", () => {
  it("regex matches vitest.config.{ts,mts,cts} and the multi-callee allowlist", async () => {
    const { VITE_TAILWIND_DOCTOR } = await import("./vite-tailwind-doctor");
    const rule = VITE_TAILWIND_DOCTOR.find((r) => r.id === "vite-defineconfig-call-block");
    expect(rule).toBeDefined();
    const cases: { path: string; callee: string }[] = [
      { path: "vitest.config.ts", callee: "defineConfig" },
      { path: "vitest.config.mts", callee: "defineProject" },
      { path: "vitest.config.cts", callee: "defineWorkspaceProject" },
      { path: "vitest.workspace.ts", callee: "defineWorkspaceProject" },
    ];
    for (const c of cases) {
      const broken = `import { ${c.callee} } from 'vitest/config';\nexport default ${c.callee}() {\n  test: { globals: true },\n};\n`;
      const ctx = { files: [{ path: c.path, content: broken }] };
      expect(rule!.detect(ctx)).toBe(true);
      const changes = rule!.apply(ctx);
      expect(changes.length).toBe(1);
      expect(ctx.files[0].content).toContain(`${c.callee}({`);
      expect(ctx.files[0].content.trimEnd().endsWith("});")).toBe(true);
    }
  });
});
