import { Router } from "express";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface CapturedFile {
  path?: string;
  content?: string;
}

interface CapturedError {
  file?: string;
  line?: number;
  column?: number;
  message?: string;
}

const router = Router();

// Resolve the fixtures directory once at module load. Path is anchored to
// THIS file's location (not process.cwd()) so capture lands in the right
// place no matter where the api-server was launched from on the user's
// machine. From src/routes/diagnostics.ts up to api-server/src/routes,
// then `../../../autocoder/src/lib/code-runner/__fixtures__/`.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_BASE = resolve(
  HERE,
  "../../../autocoder/src/lib/code-runner/__fixtures__",
);

function safeRelPath(p: string): string {
  // Normalize Windows separators first.
  const normalized = p.replace(/\\/g, "/");
  // Reject absolute paths up front: POSIX absolute (`/foo`), Windows drive
  // (`C:/foo`), and UNC (`//server/share`). These could escape the capture
  // dir on `path.resolve` regardless of `..` filtering.
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith("//")
  ) {
    return "";
  }
  return normalized
    .split("/")
    .filter((seg) => seg && seg !== ".." && seg !== ".")
    .join("/");
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !/^([A-Za-z]:)?[\\/]/.test(rel);
}

router.post("/diagnostics/capture-failure", (req, res) => {
  try {
    const { files, errors, label } = req.body as {
      files?: unknown;
      errors?: unknown;
      label?: unknown;
    };

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "files array is required" });
    }

    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace(/Z$/, "Z");
    const labelTag =
      typeof label === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(label)
        ? `-${label}`
        : "";
    const captureDir = resolve(FIXTURES_BASE, `captured-${stamp}${labelTag}`);
    mkdirSync(captureDir, { recursive: true });

    const written: string[] = [];
    for (const raw of files as CapturedFile[]) {
      const p = typeof raw?.path === "string" ? raw.path : "";
      const c = typeof raw?.content === "string" ? raw.content : "";
      if (!p) continue;
      const rel = safeRelPath(p);
      if (!rel) continue;
      const target = resolve(captureDir, rel);
      // Defense-in-depth: even after sanitization, refuse anything that
      // resolves outside captureDir. Catches edge cases on weird inputs.
      if (!isInside(captureDir, target)) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, c, "utf8");
      written.push(rel);
    }

    const manifest = {
      capturedAt: new Date().toISOString(),
      label: typeof label === "string" ? label : null,
      fileCount: written.length,
      files: written,
      errors: Array.isArray(errors)
        ? (errors as CapturedError[]).map((e) => ({
            file: typeof e?.file === "string" ? e.file : "",
            line: typeof e?.line === "number" ? e.line : 0,
            column: typeof e?.column === "number" ? e.column : 0,
            message: typeof e?.message === "string" ? e.message : "",
          }))
        : [],
    };
    writeFileSync(
      resolve(captureDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );

    // Loud console line — easy to find in the api-server terminal on Windows.
    // eslint-disable-next-line no-console
    console.log(
      `[diagnostics] captured ${written.length} broken file(s) → ${captureDir}`,
    );

    return res.json({
      ok: true,
      capturedDir: captureDir,
      fileCount: written.length,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "capture failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
