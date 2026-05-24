import { Router } from "express";

const router = Router();

router.get("/modules/stages", (_req, res) => {
  res.json({ stages: [] });
});

router.post("/modules/test", (req, res) => {
  res.json({ success: false, message: "No AI model connected. Configure an endpoint in Settings." });
});

router.post("/modules/fix", async (req, res) => {
  const { files } = req.body || {};
  if (!Array.isArray(files)) { res.status(400).json({ error: "files array required" }); return; }
  res.json({
    success: true,
    fixed: [],
    message: "No AI model connected — automatic fixes require a configured AI endpoint.",
  });
});

router.post("/modules/diagnostics", async (req, res) => {
  const { files } = req.body || {};
  if (!Array.isArray(files)) { res.status(400).json({ error: "files array required" }); return; }
  const issues: any[] = [];
  for (const file of files) {
    if (!file.path || !file.content) continue;
    if (file.path.endsWith(".tsx") || file.path.endsWith(".jsx")) {
      if (!file.content.includes("import React") && !file.content.includes("from 'react'") && !file.content.includes('from "react"')) {
        if (file.content.includes("jsx") || file.content.includes("<")) {
          issues.push({
            file: file.path,
            severity: "warning",
            type: "import",
            message: "Missing React import",
            line: 1,
            autoFixable: true,
          });
        }
      }
    }
  }

  res.json({
    totalIssues: issues.length,
    byFile: issues.reduce((acc: Record<string, any[]>, issue) => {
      if (!acc[issue.file]) acc[issue.file] = [];
      acc[issue.file].push(issue);
      return acc;
    }, {}),
    issues,
  });
});

export default router;
