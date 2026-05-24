// template-basement-guard.ts — content-preservation gate.
//
// Sits between `generateStub()` (template-basement.ts) and the actual
// FileSystem write performed by the cascade orchestrator. Its sole
// purpose: NEVER overwrite a substantial source file with a tiny stub.
//
// Failure mode this prevents (REPORT-pipeline-failure-2026-05-16):
//   shared/schema.ts (17 477 B) → stub (516 B) silently written to disk;
//   the user's schema is destroyed, the chat thread shows nothing useful.
//
// Decision matrix:
//   original ≤ floorBytes (default 1 KB)  → write-stub  (current behaviour)
//   stub ≥ minRatio × original            → write-stub  (the "real" file is
//                                                       already mostly empty)
//   otherwise                             → sidecar-only — keep the original,
//                                                         write the stub to
//                                                         `${path}.broken`,
//                                                         surface a hard error.
//
// Pure module. No I/O. The cascade orchestrator handles the actual write.

import type { TemplateSubstitution } from "./template-basement";

export interface PreservationPolicy {
  /** Files at or below this size are considered "throwaway" and may be replaced. */
  absoluteFloorBytes: number;
  /** Stub must be at least this fraction of the original size to be allowed to overwrite. */
  minRatio: number;
}

export const DEFAULT_PRESERVATION_POLICY: PreservationPolicy = {
  absoluteFloorBytes: 1024,
  minRatio: 0.5,
};

export type PreservationAction =
  | "write-stub"     // Safe to overwrite the original with the stub.
  | "sidecar-only";  // Keep the original; write the stub to ${path}.broken.

export interface PreservationDecision {
  action: PreservationAction;
  /** Path to write the stub to. Either the original `path` or `${path}.broken`. */
  writePath: string;
  /** Bytes to write at `writePath`. Same as `stub.content`. */
  writeContent: string;
  /** Human-readable explanation, suitable for surfacing in the chat thread. */
  reason: string;
  /** Original byte count (for logging). */
  originalBytes: number;
  /** Stub byte count (for logging). */
  stubBytes: number;
}

/**
 * Decide whether the cascade may overwrite `path` with `stub`.
 *
 * `originalContent` is what's currently on disk (or in the project file
 * buffer). Pass `null`/`""` for files that don't exist yet.
 */
export function decidePreservation(
  originalContent: string | null,
  stub: TemplateSubstitution,
  path: string,
  policy: PreservationPolicy = DEFAULT_PRESERVATION_POLICY,
): PreservationDecision {
  const original = originalContent ?? "";
  const originalBytes = byteLen(original);
  const stubBytes = byteLen(stub.content);

  // Throwaway-size original — let the stub through.
  if (originalBytes <= policy.absoluteFloorBytes) {
    return {
      action: "write-stub",
      writePath: path,
      writeContent: stub.content,
      reason: `original ≤ ${policy.absoluteFloorBytes} B (throwaway), stub permitted`,
      originalBytes,
      stubBytes,
    };
  }

  // Empty/missing original — let the stub through (nothing to lose).
  if (originalBytes === 0) {
    return {
      action: "write-stub",
      writePath: path,
      writeContent: stub.content,
      reason: "original missing/empty, stub permitted",
      originalBytes,
      stubBytes,
    };
  }

  // Stub is "almost as big" as the original — let it through.
  // (Caller has decided the original is broken; if the stub keeps most of
  // the byte budget the user isn't losing meaningful content.)
  if (stubBytes >= originalBytes * policy.minRatio) {
    return {
      action: "write-stub",
      writePath: path,
      writeContent: stub.content,
      reason: `stub is ≥ ${Math.round(policy.minRatio * 100)}% of original (${stubBytes}/${originalBytes} B)`,
      originalBytes,
      stubBytes,
    };
  }

  // Refuse the overwrite. Write to a sidecar so the user can diff.
  return {
    action: "sidecar-only",
    writePath: `${path}.broken`,
    writeContent: stub.content,
    reason: `refused overwrite: stub (${stubBytes} B) would shrink ${path} (${originalBytes} B) below ${Math.round(policy.minRatio * 100)}%`,
    originalBytes,
    stubBytes,
  };
}

/** UTF-8 byte length, with a fast-path for ASCII-only content. */
function byteLen(s: string): number {
  // Fast-path: if all chars are ASCII, byte length === code-point length.
  // Falls back to TextEncoder for any non-ASCII payload.
  let asciiOnly = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) {
      asciiOnly = false;
      break;
    }
  }
  if (asciiOnly) return s.length;
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}
