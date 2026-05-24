import { describe, it, expect } from "vitest";
import {
  decidePreservation,
  DEFAULT_PRESERVATION_POLICY,
} from "./template-basement-guard";
import type { TemplateSubstitution } from "./template-basement";

function stub(content: string): TemplateSubstitution {
  return {
    substituted: true,
    kind: "ts-module",
    banner: "test",
    content,
  };
}

describe("decidePreservation", () => {
  it("permits overwrite when original is missing", () => {
    const d = decidePreservation(null, stub("x".repeat(500)), "src/x.ts");
    expect(d.action).toBe("write-stub");
    expect(d.writePath).toBe("src/x.ts");
  });

  it("permits overwrite when original is empty", () => {
    const d = decidePreservation("", stub("x".repeat(500)), "src/x.ts");
    expect(d.action).toBe("write-stub");
  });

  it("permits overwrite when original is below the absolute floor (1 KB)", () => {
    const d = decidePreservation(
      "x".repeat(800),
      stub("y".repeat(200)),
      "src/x.ts",
    );
    expect(d.action).toBe("write-stub");
    expect(d.reason).toMatch(/throwaway/);
  });

  it("REFUSES overwrite when original is large and stub is much smaller (the schema.ts case)", () => {
    const original = "x".repeat(17_477); // real failing-case size
    const tiny = "y".repeat(516); // real stub size
    const d = decidePreservation(original, stub(tiny), "shared/schema.ts");
    expect(d.action).toBe("sidecar-only");
    expect(d.writePath).toBe("shared/schema.ts.broken");
    expect(d.writeContent).toBe(tiny);
    expect(d.originalBytes).toBe(17_477);
    expect(d.stubBytes).toBe(516);
    expect(d.reason).toMatch(/refused/);
  });

  it("permits overwrite when stub is ≥50% of original", () => {
    const original = "x".repeat(2000);
    const big = "y".repeat(1500);
    const d = decidePreservation(original, stub(big), "src/x.ts");
    expect(d.action).toBe("write-stub");
  });

  it("REFUSES overwrite for a 16 KB page → 880 B stub", () => {
    // Mirrors the failing-run page-file shrink reported in REPORT-pipeline-failure-2026-05-16.
    const d = decidePreservation(
      "x".repeat(16_000),
      stub("y".repeat(880)),
      "src/pages/auth-page.tsx",
    );
    expect(d.action).toBe("sidecar-only");
    expect(d.writePath).toBe("src/pages/auth-page.tsx.broken");
  });

  it("honours custom policy overrides", () => {
    // Loosen the policy so a 50% shrink is acceptable even on large files.
    const d = decidePreservation(
      "x".repeat(5000),
      stub("y".repeat(2500)),
      "src/x.ts",
      { absoluteFloorBytes: 100, minRatio: 0.4 },
    );
    expect(d.action).toBe("write-stub");
  });

  it("default policy: 1 KB floor + 50% ratio", () => {
    expect(DEFAULT_PRESERVATION_POLICY.absoluteFloorBytes).toBe(1024);
    expect(DEFAULT_PRESERVATION_POLICY.minRatio).toBe(0.5);
  });
});
