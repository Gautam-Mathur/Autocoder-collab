import { describe, it, expect } from "vitest";
import { runParserGate, isParseable, makeWindow } from "./parser-gate";

describe("parser-gate — isParseable", () => {
  it("accepts ts/tsx/js/jsx/mjs/cjs", () => {
    for (const p of ["src/A.tsx", "src/B.ts", "src/C.jsx", "src/D.js", "src/e.mjs", "src/f.cjs"]) {
      expect(isParseable(p)).toBe(true);
    }
  });
  it("rejects node_modules, .d.ts, configs, and non-code", () => {
    expect(isParseable("node_modules/x/y.ts")).toBe(false);
    expect(isParseable("src/types.d.ts")).toBe(false);
    expect(isParseable("vite.config.ts")).toBe(false);
    expect(isParseable("vitest.config.ts")).toBe(false);
    expect(isParseable("tailwind.config.js")).toBe(false);
    expect(isParseable("postcss.config.js")).toBe(false);
    expect(isParseable("package.json")).toBe(false);
  });
});

describe("parser-gate — runParserGate", () => {
  it("returns no errors on a clean project", () => {
    const errs = runParserGate([
      { path: "src/A.tsx", content: "export const A = () => <div />;" },
      { path: "src/b.ts", content: "export const x = (n: number) => n + 1;" },
    ]);
    expect(errs).toEqual([]);
  });

  it("reports first-error with line/col for broken JSX (mangled-arrow shape)", () => {
    const errs = runParserGate([
      { path: "src/A.tsx", content: "export const A = () => <button onClick={(e) = /> doX(e)} />;" },
    ]);
    expect(errs).toHaveLength(1);
    expect(errs[0].file).toBe("src/A.tsx");
    expect(errs[0].line).toBe(1);
    expect(typeof errs[0].message).toBe("string");
    expect(errs[0].windowText).toContain(">");
  });

  it("reports first-error per file (cascade suppression — never two for same file)", () => {
    const code = [
      "export const A = () => {",
      "  const x = (1 + ;",          // first error
      "  const y = ];",                // second error — must not surface
      "};",
    ].join("\n");
    const errs = runParserGate([{ path: "src/A.tsx", content: code }]);
    expect(errs).toHaveLength(1);
    expect(errs[0].line).toBe(2);
  });

  it("respects maxFiles cap", () => {
    const broken = "export const A = () => <X onClick={(e) = /> y(e)} />;";
    const files = Array.from({ length: 25 }, (_, i) => ({
      path: `src/F${i}.tsx`,
      content: broken,
    }));
    const errs = runParserGate(files, { maxFiles: 5 });
    expect(errs).toHaveLength(5);
  });

  it("skips configs, d.ts, and node_modules", () => {
    const errs = runParserGate([
      { path: "node_modules/x/index.ts", content: "(e) = />" },
      { path: "vite.config.ts", content: "(e) = />" },
      { path: "src/types.d.ts", content: "export const X: =;" },
    ]);
    expect(errs).toEqual([]);
  });

  it("supports TypeScript-only syntax (type aliases, interfaces, generics)", () => {
    const errs = runParserGate([
      {
        path: "src/types.ts",
        content:
          "export type Box<T> = { value: T };\n" +
          "export interface Foo { id: number; nested: Box<string> }\n" +
          "export const f = <T,>(x: T): T => x;\n",
      },
    ]);
    expect(errs).toEqual([]);
  });
});

describe("parser-gate — makeWindow", () => {
  it("centers the marker on the offending line and includes ±radius lines", () => {
    const src = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const w = makeWindow(src, 10, 3);
    expect(w.start).toBe(7);
    expect(w.end).toBe(13);
    const lines = w.text.split("\n");
    expect(lines).toHaveLength(7);
    // Marker `>` only on the centered line
    const marked = lines.filter((l) => l.startsWith(">"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("line 10");
  });

  it("clamps to file bounds without throwing", () => {
    const w = makeWindow("only one line", 1, 5);
    expect(w.start).toBe(1);
    expect(w.end).toBe(1);
  });
});
