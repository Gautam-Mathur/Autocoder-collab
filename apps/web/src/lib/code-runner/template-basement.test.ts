import { describe, it, expect } from "vitest";
import { generateStub } from "./template-basement";
import { runParserGate } from "./parser-gate";

describe("template-basement — generateStub", () => {
  it("produces a parseable React component stub for .tsx components", () => {
    const stub = generateStub("src/components/MyButton.tsx", "stuck on syntax");
    expect(stub.substituted).toBe(true);
    expect(stub.kind).toBe("react-component");
    expect(stub.content).toContain("export function MyButton()");
    expect(stub.content).toContain("export default MyButton");
    const errs = runParserGate([{ path: "src/components/MyButton.tsx", content: stub.content }]);
    expect(errs).toEqual([]);
  });

  it("produces a no-op hook stub for files starting with 'use'", () => {
    const stub = generateStub("src/hooks/useAuth.ts", "broken");
    expect(stub.kind).toBe("react-hook");
    expect(stub.content).toContain("export function useAuth()");
    expect(stub.content).toContain("ready: false");
  });

  it("produces a visible page stub for /pages/ paths", () => {
    const stub = generateStub("src/pages/auth-page.tsx", "stuck");
    expect(stub.kind).toBe("react-page");
    expect(stub.content).toContain("temporarily unavailable");
    expect(stub.content).toContain("AuthPage");
    const errs = runParserGate([{ path: "src/pages/auth-page.tsx", content: stub.content }]);
    expect(errs).toEqual([]);
  });

  it("produces a parseable empty TS module for .ts files", () => {
    const stub = generateStub("src/util/x.ts", "broken");
    expect(stub.kind).toBe("ts-module");
    expect(stub.content).toContain("export {}");
    const errs = runParserGate([{ path: "src/util/x.ts", content: stub.content }]);
    expect(errs).toEqual([]);
  });

  it("includes a banner with the reason text", () => {
    const stub = generateStub("src/A.tsx", "exhausted SLM budget");
    expect(stub.content).toContain("AutoCoder template-basement");
    expect(stub.content).toContain("exhausted SLM budget");
  });

  it("returns substituted=false for unsupported extensions (e.g. .css)", () => {
    const stub = generateStub("src/App.css", "broken");
    expect(stub.substituted).toBe(false);
  });

  // Edge cases flagged by code review: identifiers must be valid JS even
  // for filenames that start with digits or contain hyphens.
  it("produces a parseable component stub for numeric-leading filenames", () => {
    const stub = generateStub("src/pages/404.tsx", "borked");
    expect(stub.substituted).toBe(true);
    const errs = runParserGate([{ path: "src/pages/404.tsx", content: stub.content }]);
    expect(errs).toEqual([]);
  });

  it("produces a parseable hook stub for hyphenated hook filenames", () => {
    const stub = generateStub("src/hooks/useAuth-v2.ts", "borked");
    expect(stub.substituted).toBe(true);
    expect(stub.kind).toBe("react-hook");
    const errs = runParserGate([
      { path: "src/hooks/useAuth-v2.ts", content: stub.content },
    ]);
    expect(errs).toEqual([]);
  });

  it("produces a parseable hook stub for plain .ts hook files (no .tsx)", () => {
    const stub = generateStub("src/hooks/useAuth.ts", "borked");
    expect(stub.substituted).toBe(true);
    expect(stub.kind).toBe("react-hook");
    const errs = runParserGate([
      { path: "src/hooks/useAuth.ts", content: stub.content },
    ]);
    expect(errs).toEqual([]);
  });
});
