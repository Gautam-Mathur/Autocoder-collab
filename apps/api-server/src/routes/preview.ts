import { Router } from "express";

const router = Router();

router.post("/preview/prepare/:conversationId", async (req, res) => {
  res.json({
    success: false,
    message: "Preview server management is handled by the WebContainer in the browser.",
  });
});

router.post("/preview/start/:conversationId", async (req, res) => {
  res.json({
    success: false,
    message: "Preview server management is handled by the WebContainer in the browser.",
  });
});

router.post("/preview/stop", async (_req, res) => {
  res.json({ success: true });
});

router.get("/preview/status", (_req, res) => {
  res.json({ running: false, url: null });
});

export default router;
