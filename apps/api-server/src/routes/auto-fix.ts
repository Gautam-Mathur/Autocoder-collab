import { Router } from "express";
import { parseErrors, analyzeAndFix } from "../src/modules/vite-error-fixer.js";

interface AutoFixFileInput {
  path?: string;
  content?: string;
  language?: string;
}

const router = Router();

router.post("/auto-fix", (req, res) => {
  try {
    const { errors, files } = req.body as { errors: unknown; files: unknown };

    if (!errors || !Array.isArray(errors)) {
      return res.status(400).json({ error: "errors array is required" });
    }

    const parsedErrors = parseErrors(errors);
    const projectFiles = Array.isArray(files)
      ? (files as AutoFixFileInput[]).map((f) => ({
          path: String(f.path || ""),
          content: String(f.content || ""),
          language: String(f.language || f.path?.split(".").pop() || ""),
        }))
      : [];

    const result = analyzeAndFix(parsedErrors, projectFiles);

    return res.json({
      fixes: result.fixes,
      unfixable: result.unfixable,
      summary: result.summary,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Auto-fix analysis failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
