import { Router } from "express";

const router = Router();

interface LogEntry {
  id: number;
  level: string;
  category: string;
  message: string;
  timestamp: string;
  data?: any;
}

let nextId = 1;
const logStore: LogEntry[] = [];

function addLog(level: string, category: string, message: string, data?: any) {
  logStore.push({ id: nextId++, level, category, message, data, timestamp: new Date().toISOString() });
  if (logStore.length > 500) logStore.splice(0, logStore.length - 500);
}

addLog("info", "Server", "API server started");

router.get("/logs", (req, res) => {
  const { level, category, search } = req.query;
  const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
  let result = [...logStore];
  if (level) result = result.filter((l) => l.level === level);
  if (category) result = result.filter((l) => l.category === category);
  if (search) {
    const s = (search as string).toLowerCase();
    result = result.filter((l) => l.message.toLowerCase().includes(s));
  }
  res.json(result.slice(-limit));
});

router.post("/logs", (req, res) => {
  const { level = "info", category = "Client", message, data } = req.body || {};
  if (!message) { res.status(400).json({ error: "message is required" }); return; }
  addLog(level, category, message, data);
  res.status(201).json({ success: true });
});

router.delete("/logs", (_req, res) => {
  logStore.length = 0;
  addLog("info", "Server", "Logs cleared");
  res.json({ success: true });
});

router.get("/logs/stats", (_req, res) => {
  const counts: Record<string, number> = {};
  for (const l of logStore) {
    counts[l.level] = (counts[l.level] || 0) + 1;
  }
  res.json({ total: logStore.length, byLevel: counts });
});

export default router;
