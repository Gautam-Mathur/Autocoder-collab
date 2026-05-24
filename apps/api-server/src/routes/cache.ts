import { Router } from "express";
import fs from "fs";
import path from "path";
import {
  upgradePackageJson,
  buildSnapshotAsync,
  getSnapshotStatus,
  buildPrewarmSnapshot,
  getPrewarmSnapshotStatus,
  getPrewarmManifest,
} from "../src/modules/snapshot-builder.js";

const router = Router();

router.get("/cache/prewarm-status", (_req, res) => {
  try {
    const status = getPrewarmSnapshotStatus();
    const manifest = getPrewarmManifest();
    const chunks = manifest?.chunks?.map((c: string) => `/api/cache/${c}`) || null;

    if (status === "ready" && chunks && chunks.length > 0) {
      res.json({ status: "ready", url: chunks[0], chunks });
    } else if (status === "ready") {
      res.json({ status: "ready", url: "/api/cache/snapshot-prewarm.json.gz", chunks: null });
    } else if (status === "building") {
      res.json({ status: "building", url: null, chunks: null });
    } else {
      res.json({ status: "not-found", url: null, chunks: null });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/cache/rebuild-prewarm", (_req, res) => {
  try {
    buildPrewarmSnapshot(true);
    res.json({ status: "building" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/cache/snapshot-status/:hash", (req, res) => {
  const hash = req.params.hash;
  if (!/^[a-f0-9]{8,32}$/.test(hash)) {
    res.status(400).json({ error: "Invalid hash" });
    return;
  }
  const status = getSnapshotStatus(hash);
  res.json({
    status,
    url: status === "ready" ? `/api/cache/snapshot-${hash}.json.gz` : null,
  });
});

router.post("/cache/build-snapshot", async (req, res) => {
  try {
    const { packageJsonContent, hash } = req.body || {};
    if (!packageJsonContent || !hash) {
      res.status(400).json({ error: "packageJsonContent and hash are required" });
      return;
    }
    if (!/^[a-f0-9]{8,32}$/.test(hash)) {
      res.status(400).json({ error: "Invalid hash" });
      return;
    }

    const upgradeResult = upgradePackageJson(packageJsonContent);
    const upgradedStr = typeof upgradeResult.packageJson === 'string'
      ? upgradeResult.packageJson
      : JSON.stringify(upgradeResult.packageJson, null, 2);

    buildSnapshotAsync(hash, upgradedStr);

    const response: any = {
      status: "building",
      hash,
    };

    const changed =
      upgradeResult.removedPackages.length > 0 ||
      upgradeResult.renamedPackages.length > 0 ||
      upgradeResult.upgradedVersions.length > 0;
    if (changed) {
      response.upgradedPackageJson = upgradedStr;
      response.upgradeInfo = {
        removedPackages: upgradeResult.removedPackages,
        renamedPackages: upgradeResult.renamedPackages,
        upgradedVersions: upgradeResult.upgradedVersions,
        warnings: upgradeResult.warnings,
      };
    }

    res.json(response);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/cache/:filename", (req, res) => {
  const filename = req.params.filename;
  if (filename.includes("/") || filename.includes("..")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (filename.endsWith(".wasm")) {
    const cacheRoot = path.resolve("./cache");
    const filePath = path.join(cacheRoot, filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.setHeader("Content-Type", "application/wasm");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(filename, { root: cacheRoot });
    return;
  }
  if (!filename.endsWith(".json.gz")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const cacheRoot = path.resolve("./cache");
  const filePath = path.join(cacheRoot, filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "No snapshot available" });
    return;
  }
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Encoding", "identity");
  res.sendFile(filename, { root: cacheRoot });
});

export default router;
