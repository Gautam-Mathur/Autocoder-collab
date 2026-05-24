process.env.NODE_ENV ??= "development";

import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import cors from "cors";
import cookieParser from "cookie-parser";
import { registerRoutes } from "./routes/autocoder";
import { initializeSLMSystem } from "./modules/slm-registry";
import fs from "fs";

const port = Number(process.env["PORT"]) || 3001;

const app = express();
const httpServer = createServer(app);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: false, limit: "50mb" }));
app.use(cookieParser());

app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  const reqPath = req.path;
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (reqPath.startsWith("/api")) {
      console.log(`${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`);
    }
  });
  next();
});

fs.mkdirSync("./cache", { recursive: true });

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) return next(err);
    return res.status(status).json({ message });
  });

  httpServer.listen({ port, host: "0.0.0.0", reusePort: true }, async () => {
    console.log(`Server listening on port ${port}`);

    try {
      const { buildPrewarmSnapshot } = await import("./modules/snapshot-builder.js");
      buildPrewarmSnapshot();
      console.log("[Startup] Prewarm snapshot build triggered at startup");
    } catch (err) {
      console.error("[Startup] Failed to trigger prewarm snapshot build:", err);
    }

    const aiBaseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL;
    const aiApiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (aiBaseUrl && aiApiKey) {
      initializeSLMSystem({ endpoint: aiBaseUrl });
      console.log("[Startup] SLM system initialized with AI endpoint");
    } else {
      initializeSLMSystem();
      console.log("[Startup] SLM system initialized (no endpoint — rules-only mode)");
    }
  });
})();
