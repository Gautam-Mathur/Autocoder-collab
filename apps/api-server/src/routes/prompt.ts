import { Router } from "express";
import { z } from "zod";

const router = Router();

router.post("/prompt/generate", async (req, res) => {
  try {
    const { generatePrompt } = await import("../src/modules/prompt-enhancer.js");
    const schema = z.object({
      topic: z.string().min(1).max(500),
      options: z
        .object({
          scale: z.enum(["small", "medium", "large"]).optional(),
          includeAuth: z.boolean().optional(),
          includeAnalytics: z.boolean().optional(),
          style: z.enum(["minimal", "detailed"]).optional(),
        })
        .optional()
        .default({}),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
      return;
    }
    const result = generatePrompt(parsed.data.topic.trim(), parsed.data.options);
    res.json(result);
  } catch (error: any) {
    console.error("Prompt generate error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/prompt/upgrade", async (req, res) => {
  try {
    const { upgradePrompt } = await import("../src/modules/prompt-enhancer.js");
    const schema = z.object({
      prompt: z.string().min(1).max(5000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
      return;
    }
    const result = upgradePrompt(parsed.data.prompt.trim());
    res.json(result);
  } catch (error: any) {
    console.error("Prompt upgrade error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
