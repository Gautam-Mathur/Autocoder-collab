import { Router } from "express";
import archiver from "archiver";
import {
  handleMessage as handlePhaseMessage,
  type ConversationState,
  type PhaseHandlerResult,
  type ThinkingStep,
} from "../src/modules/conversation-phase-handler.js";
import {
  validateGeneratedCode,
  autoFixCode as clientAutoFixCode,
} from "../src/client-lib/code-generator/code-validator.js";
import {
  continuousDebug,
  autoFixCode as serverAutoFixCode,
} from "../src/modules/continuous-debugger.js";

const router = Router();

function inferLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    tsx: "tsx", ts: "typescript", jsx: "jsx", js: "javascript",
    json: "json", html: "html", css: "css", md: "markdown", svg: "svg",
  };
  return map[ext] || "text";
}

interface Message {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
  thinkingSteps?: ThinkingStep[];
  metadata?: Record<string, any>;
}

interface Conversation {
  id: number;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  stack?: string;
  conversationPhase?: string;
  understandingData?: any;
  projectPlanData?: any;
  clarificationRound?: number;
  clarificationState?: any;
  editHistory?: any[];
  shownSuggestions?: any[];
  suggestionTracking?: any[];
}

interface ProjectFile {
  path: string;
  content: string;
  language?: string;
}

interface LogEntry {
  id: number;
  conversationId: number;
  level: string;
  message: string;
  timestamp: Date;
}

let nextConvId = 1;
let nextMsgId = 1;
let nextLogId = 1;
const conversations = new Map<number, Conversation>();
const messages = new Map<number, Message[]>();
const projectFiles = new Map<number, ProjectFile[]>();
const conversationLogs = new Map<number, LogEntry[]>();

/** Shared accessors for cross-route lookups (Initiative D plan-graph route, F dry-run resume). */
export function getConversation(id: number): Conversation | undefined {
  return conversations.get(id);
}
export function getConversationFiles(id: number): ProjectFile[] {
  return projectFiles.get(id) || [];
}
export function getConversationPlanData(id: number): any | undefined {
  return conversations.get(id)?.projectPlanData;
}
export function getConversationUnderstanding(id: number): any | undefined {
  return conversations.get(id)?.understandingData;
}
export function setConversationFiles(id: number, files: ProjectFile[]): void {
  projectFiles.set(id, files);
}
export function updateConversation(id: number, patch: Partial<Conversation>): void {
  const c = conversations.get(id);
  if (!c) return;
  conversations.set(id, { ...c, ...patch, id, updatedAt: new Date() });
}

function parseValidId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id < 0 || id > 2147483647) return null;
  return id;
}

function sendSSE(res: any, data: Record<string, any>) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

router.get("/conversations", async (_req, res) => {
  const all = Array.from(conversations.values()).sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
  );
  res.json(all);
});

router.get("/conversations/:id", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  const conv = conversations.get(id);
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  const msgs = messages.get(id) || [];
  res.json({ ...conv, messages: msgs });
});

router.post("/conversations", async (req, res) => {
  const { title, stack } = req.body || {};
  const id = nextConvId++;
  const now = new Date();
  const conv: Conversation = {
    id,
    title: title || "New Project",
    stack: stack || "react-vite-express",
    createdAt: now,
    updatedAt: now,
    conversationPhase: "initial",
  };
  conversations.set(id, conv);
  messages.set(id, []);
  projectFiles.set(id, []);
  conversationLogs.set(id, []);
  res.status(201).json(conv);
});

router.put("/conversations/:id/context", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  const conv = conversations.get(id);
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  conversations.set(id, { ...conv, ...req.body, id, createdAt: conv.createdAt, updatedAt: new Date() });
  res.json(conversations.get(id));
});

router.delete("/conversations/:id", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  if (!conversations.has(id)) { res.status(404).json({ error: "Conversation not found" }); return; }
  conversations.delete(id);
  messages.delete(id);
  projectFiles.delete(id);
  conversationLogs.delete(id);
  res.json({ success: true });
});

router.post("/conversations/:id/messages", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  const conv = conversations.get(id);
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  const { content, dryRun } = req.body || {};
  if (!content) { res.status(400).json({ error: "content is required" }); return; }
  const userMsg: Message = {
    id: nextMsgId++,
    conversationId: id,
    role: "user",
    content,
    createdAt: new Date(),
  };
  const list = messages.get(id) || [];
  list.push(userMsg);
  messages.set(id, list);
  conv.updatedAt = new Date();
  conversations.set(id, conv);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    const existingFiles = projectFiles.get(id) || [];
    const currentPhase = conv.conversationPhase || "initial";

    const convState: ConversationState = {
      phase: currentPhase as any,
      understandingData: conv.understandingData,
      planData: conv.projectPlanData,
      clarificationRound: conv.clarificationRound,
      clarificationState: conv.clarificationState,
      conversationId: id,
      existingFiles: existingFiles.length > 0
        ? existingFiles.map((f) => ({
            path: f.path,
            content: f.content,
            language: f.language || inferLanguageFromPath(f.path),
          }))
        : undefined,
      editHistory: conv.editHistory,
      shownSuggestions: conv.shownSuggestions,
      suggestionTracking: conv.suggestionTracking,
      dryRun: dryRun === true,
    };

    const recentMsgs = list.slice(-6);
    const conversationHistory = recentMsgs
      .map((m) => `[${m.role}]: ${m.content.slice(0, 300)}`)
      .join("\n");

    const onStep = (step: { phase: string; label: string; detail?: string; timestamp?: number }) => {
      try {
        sendSSE(res, { type: "thinking", step });
      } catch {}
    };

    const result: PhaseHandlerResult = await handlePhaseMessage(
      content,
      convState,
      conversationHistory,
      onStep
    );

    const hasFileEdits = result.fileEdits && result.fileEdits.length > 0;
    const hasGeneratedFiles = result.generatedFiles && result.generatedFiles.length > 0;

    if (hasFileEdits) {
      const files = projectFiles.get(id) || [];
      for (const edit of result.fileEdits!) {
        if (edit.editType === "delete") {
          const idx = files.findIndex((f) => f.path === edit.filePath);
          if (idx >= 0) files.splice(idx, 1);
        } else {
          const fixedContent = clientAutoFixCode(edit.newContent, edit.filePath);
          const lang = inferLanguageFromPath(edit.filePath);
          const idx = files.findIndex((f) => f.path === edit.filePath);
          if (idx >= 0) files[idx] = { path: edit.filePath, content: fixedContent, language: lang };
          else files.push({ path: edit.filePath, content: fixedContent, language: lang });
        }
      }
      projectFiles.set(id, files);
    } else if (hasGeneratedFiles) {
      const validation = validateGeneratedCode(
        result.generatedFiles!.map((f) => ({ path: f.path, content: f.content }))
      );
      const filesToSave = validation.fixedFiles.length > 0
        ? validation.fixedFiles
        : result.generatedFiles!;

      const newFiles: ProjectFile[] = [];
      for (const file of filesToSave) {
        const fixedContent = clientAutoFixCode(file.content, file.path);
        const lang = "language" in file && typeof file.language === "string"
          ? file.language
          : inferLanguageFromPath(file.path);
        newFiles.push({ path: file.path, content: fixedContent, language: lang });
      }
      projectFiles.set(id, newFiles);
    }

    const updateData: Partial<Conversation> = {
      conversationPhase: result.newPhase,
      updatedAt: new Date(),
    };
    if (result.planData) {
      updateData.projectPlanData = result.planData;
    }
    if (result.understandingData) {
      updateData.understandingData = result.understandingData;
    }
    if (result.clarificationRound != null) {
      updateData.clarificationRound = result.clarificationRound;
    }
    if (result.clarificationState) {
      updateData.clarificationState = result.clarificationState;
    }
    if (result.shownSuggestions) {
      updateData.shownSuggestions = result.shownSuggestions;
    }
    if (result.suggestionTracking) {
      updateData.suggestionTracking = result.suggestionTracking;
    }
    if (result.fileEdits && result.fileEdits.length > 0) {
      const prevHistory = conv.editHistory || [];
      const filesChanged = result.fileEdits.map((e: any) => e.filePath);
      const editTypes = [...new Set(result.fileEdits.map((e: any) => e.editType || "modify"))];
      updateData.editHistory = [
        ...prevHistory,
        {
          timestamp: Date.now(),
          summary: `${editTypes.join("/")} ${filesChanged.length} file(s): ${filesChanged.slice(0, 3).join(", ")}${filesChanged.length > 3 ? "..." : ""}`,
          editType: editTypes.length === 1 ? editTypes[0] : "mixed",
          filesChanged,
          edits: result.fileEdits.map((e: any) => ({
            filePath: e.filePath,
            editType: e.editType,
            description: e.description,
          })),
          userMessage: content,
        },
      ].slice(-50);
    }
    conversations.set(id, { ...conv, ...updateData });

    const streamContent = result.responseContent;
    const chunks = streamContent.split(/(?<=\s)/);
    for (const chunk of chunks) {
      sendSSE(res, { content: chunk });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const assistantMsg: Message = {
      id: nextMsgId++,
      conversationId: id,
      role: "assistant",
      content: streamContent,
      createdAt: new Date(),
      thinkingSteps: result.thinkingSteps,
    };
    list.push(assistantMsg);
    messages.set(id, list);

    const donePayload: any = {
      done: true,
      thinkingSteps: result.thinkingSteps,
      messageId: assistantMsg.id,
      phase: result.newPhase,
    };
    if (result.generatedFiles && !result.fileEdits) {
      donePayload.deepProject = {
        name: result.planData?.projectName || "Generated Project",
        totalFiles: result.generatedFiles.length,
      };
    }
    if (result.fileEdits && result.fileEdits.length > 0) {
      donePayload.fileEdits = result.fileEdits.map((e: any) => ({
        filePath: e.filePath,
        editType: e.editType,
        description: e.description,
        linesChanged: e.linesChanged,
      }));
      donePayload.editType = result.editResult?.editType;
    }
    if (result.validationSummary) {
      donePayload.validationSummary = result.validationSummary;
    }
    donePayload.slmEnhanced = result.slmEnhanced || false;
    donePayload.slmStagesRun = result.slmStagesRun || [];
    donePayload.slmHealth = result.slmHealth || [];
    if (result.diagnostics) {
      donePayload.diagnostics = result.diagnostics;
    }
    if (result.snapshotHash) {
      donePayload.snapshotHash = result.snapshotHash;
    }
    if (result.newPhase === "approval") {
      donePayload.showApproval = true;
    }
    if (result.shownSuggestions && result.shownSuggestions.length > 0) {
      donePayload.suggestions = {
        items: result.shownSuggestions.map((s: any) => ({
          name: s.name,
          description: s.description,
          capabilityDescription: s.capabilityDescription,
        })),
        headerText: result.suggestionsHeaderText || 'You might want to consider:',
      };
    }

    sendSSE(res, donePayload);
    res.end();
  } catch (error: any) {
    console.error("Error in message handler:", error);
    const rawMsg = error?.message || String(error);

    let userMessage = "Failed to generate response";
    const stageMatch = rawMsg.match(/Critical stage "([^"]+)" failed/);
    const failedStage = stageMatch ? stageMatch[1] : undefined;

    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed/.test(rawMsg)) {
      userMessage = `Could not reach the AI model${failedStage ? ` during "${failedStage}"` : ""}. Make sure your local model server (Ollama / LM Studio) is running and the endpoint is correct.`;
    } else if (/timeout|ETIMEDOUT|AbortError/.test(rawMsg)) {
      userMessage = `The AI model timed out${failedStage ? ` during "${failedStage}"` : ""}. Try a smaller prompt or a faster model.`;
    } else if (/JSON|parse|SyntaxError|Unexpected token/.test(rawMsg)) {
      userMessage = `The AI model returned an invalid response${failedStage ? ` during "${failedStage}"` : ""}. Try a larger model (7B+ parameters).`;
    } else if (failedStage) {
      userMessage = `Generation failed during "${failedStage}": ${rawMsg.replace(/Critical stage "[^"]+" failed:\s*/, "")}`;
    }

    if (res.headersSent) {
      sendSSE(res, { error: userMessage, failedStage });
      res.end();
    } else {
      res.status(500).json({ error: userMessage, failedStage });
    }
  }
});

router.get("/conversations/:id/files", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  if (!conversations.has(id)) { res.status(404).json({ error: "Conversation not found" }); return; }
  res.json(projectFiles.get(id) || []);
});

router.post("/conversations/:id/files", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  if (!conversations.has(id)) { res.status(404).json({ error: "Conversation not found" }); return; }
  const { path: filePath, content, language } = req.body || {};
  if (!filePath || content === undefined) { res.status(400).json({ error: "path and content required" }); return; }
  const files = projectFiles.get(id) || [];
  const idx = files.findIndex((f) => f.path === filePath);
  const file: ProjectFile = { path: filePath, content, language };
  if (idx >= 0) files[idx] = file;
  else files.push(file);
  projectFiles.set(id, files);
  res.json(file);
});

router.post("/conversations/:id/files/bulk", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  if (!conversations.has(id)) { res.status(404).json({ error: "Conversation not found" }); return; }
  const { files: incoming } = req.body || {};
  if (!Array.isArray(incoming)) { res.status(400).json({ error: "files array required" }); return; }
  const files = projectFiles.get(id) || [];
  for (const f of incoming) {
    if (!f.path || f.content === undefined) continue;
    const idx = files.findIndex((x) => x.path === f.path);
    const file: ProjectFile = { path: f.path, content: f.content, language: f.language };
    if (idx >= 0) files[idx] = file;
    else files.push(file);
  }
  projectFiles.set(id, files);
  if (conversations.has(id)) conversations.get(id)!.updatedAt = new Date();
  res.json({ updated: incoming.length });
});

router.delete("/conversations/:id/files", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  if (!conversations.has(id)) { res.status(404).json({ error: "Conversation not found" }); return; }
  projectFiles.set(id, []);
  res.json({ success: true });
});

router.delete("/conversations/:id/files/*filePath", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  if (!conversations.has(id)) { res.status(404).json({ error: "Conversation not found" }); return; }
  const rawPath = (req.params as any).filePath;
  const joined = Array.isArray(rawPath) ? rawPath.join("/") : String(rawPath || "");
  const filePath = decodeURIComponent(joined);
  if (!filePath) { res.status(400).json({ error: "File path is required" }); return; }
  const files = projectFiles.get(id) || [];
  const idx = files.findIndex((f) => f.path === filePath);
  if (idx < 0) { res.status(404).json({ error: "File not found" }); return; }
  files.splice(idx, 1);
  projectFiles.set(id, files);
  res.json({ success: true });
});

router.post("/conversations/:id/upload-files", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  if (!conversations.has(id)) { res.status(404).json({ error: "Conversation not found" }); return; }
  const { files: incoming } = req.body || {};
  if (!Array.isArray(incoming)) { res.status(400).json({ error: "files array required" }); return; }
  const files = projectFiles.get(id) || [];
  for (const f of incoming) {
    if (!f.path || f.content === undefined) continue;
    const idx = files.findIndex((x) => x.path === f.path);
    const file: ProjectFile = { path: f.path, content: f.content };
    if (idx >= 0) files[idx] = file;
    else files.push(file);
  }
  projectFiles.set(id, files);
  res.json({ success: true, count: incoming.length });
});

router.post("/conversations/:id/import-github", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  if (!conversations.has(id)) { res.status(404).json({ error: "Conversation not found" }); return; }
  const { owner, repo, branch = "main", files: filePaths } = req.body || {};
  if (!owner || !repo || !Array.isArray(filePaths)) {
    res.status(400).json({ error: "owner, repo, and files are required" });
    return;
  }

  const files = projectFiles.get(id) || [];
  const imported: string[] = [];

  for (const filePath of filePaths.slice(0, 100)) {
    try {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
      const headers: Record<string, string> = {};
      if (req.headers["x-github-token"]) {
        headers["Authorization"] = `token ${req.headers["x-github-token"]}`;
      }
      const r = await fetch(url, { headers });
      if (!r.ok) continue;
      const fetchedContent = await r.text();
      const idx = files.findIndex((f) => f.path === filePath);
      if (idx >= 0) files[idx] = { path: filePath, content: fetchedContent };
      else files.push({ path: filePath, content: fetchedContent });
      imported.push(filePath);
    } catch {
      continue;
    }
  }

  projectFiles.set(id, files);
  res.json({ success: true, imported: imported.length, files: imported });
});

router.post("/conversations/:id/regenerate-file", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  if (!conversations.has(id)) { res.status(404).json({ error: "Conversation not found" }); return; }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sendSSE(res, {
    error: "File regeneration requires an AI model connection. Configure an endpoint in Settings.",
  });
  sendSSE(res, { done: true });
  res.end();
});

router.get("/conversations/:id/export", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  const conv = conversations.get(id);
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  const files = projectFiles.get(id) || [];
  const msgs = messages.get(id) || [];
  res.json({
    conversation: conv,
    messages: msgs,
    files,
    exportedAt: new Date().toISOString(),
  });
});

router.get("/conversations/:id/download", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  const conv = conversations.get(id);
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  const files = projectFiles.get(id) || [];

  const safeTitle = (conv.title || "project").replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 40);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.zip"`);

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.pipe(res);

  for (const file of files) {
    archive.append(file.content, { name: file.path });
  }

  if (files.length === 0) {
    archive.append("# No files generated yet", { name: "README.md" });
  }

  await archive.finalize();
});

router.get("/conversations/:id/logs", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  if (!conversations.has(id)) { res.status(404).json({ error: "Conversation not found" }); return; }
  res.json(conversationLogs.get(id) || []);
});

router.post("/conversations/:id/logs", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  if (!conversations.has(id)) { res.status(404).json({ error: "Conversation not found" }); return; }
  const { level = "info", message } = req.body || {};
  if (!message) { res.status(400).json({ error: "message is required" }); return; }
  const logs = conversationLogs.get(id) || [];
  const entry: LogEntry = { id: nextLogId++, conversationId: id, level, message, timestamp: new Date() };
  logs.push(entry);
  conversationLogs.set(id, logs);
  res.status(201).json(entry);
});

router.post("/conversations/:id/auto-fix", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  if (!conversations.has(id)) { res.status(404).json({ error: "Conversation not found" }); return; }
  const { errors, attempt } = req.body || {};
  if (!Array.isArray(errors) || errors.length === 0) {
    res.status(400).json({ error: "errors array is required" });
    return;
  }

  const files = projectFiles.get(id) || [];
  const fixes: Array<{ file: string; changes: string[] }> = [];

  for (const file of files) {
    const lang = file.language || inferLanguageFromPath(file.path);
    if (!["typescript", "tsx", "javascript", "jsx"].includes(lang)) continue;

    const { fixed, changes } = serverAutoFixCode(file.content);
    if (changes.length > 0) {
      file.content = fixed;
      fixes.push({ file: file.path, changes });
    }
  }

  projectFiles.set(id, files);

  res.json({
    totalFixed: fixes.length,
    fixes,
    attempt: attempt || 1,
  });
});

/**
 * Initiative F — resume a dry-run conversation. Drives the conversation
 * past the approval phase (which a dry-run leaves it in) and runs the
 * full pipeline. Streams the same SSE events as POST /messages.
 */
const inFlightResumes = new Set<number>();
router.post("/conversations/:id/resume", async (req, res) => {
  const id = parseValidId(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid conversation ID" }); return; }
  const conv = conversations.get(id);
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  if (!conv.projectPlanData) {
    res.status(400).json({ error: "Cannot resume: conversation has no plan yet" });
    return;
  }
  if (inFlightResumes.has(id)) {
    res.status(409).json({ error: "Conversation is already resuming" });
    return;
  }
  inFlightResumes.add(id);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const existingFiles = projectFiles.get(id) || [];
  const convState: ConversationState = {
    phase: "approval" as any,
    understandingData: conv.understandingData,
    planData: conv.projectPlanData,
    clarificationRound: conv.clarificationRound,
    clarificationState: conv.clarificationState,
    conversationId: id,
    existingFiles: existingFiles.length > 0
      ? existingFiles.map((f) => ({
          path: f.path,
          content: f.content,
          language: f.language || inferLanguageFromPath(f.path),
        }))
      : undefined,
    editHistory: conv.editHistory,
    dryRun: false,
  };

  const onStep = (step: { phase: string; label: string; detail?: string; timestamp?: number }) => {
    try { sendSSE(res, { type: "thinking", step }); } catch {}
  };

  try {
    const result: PhaseHandlerResult = await handlePhaseMessage("approve", convState, "", onStep);
    if (result.generatedFiles && result.generatedFiles.length > 0) {
      const newFiles: ProjectFile[] = result.generatedFiles.map((f: any) => ({
        path: f.path,
        content: clientAutoFixCode(f.content, f.path),
        language: f.language || inferLanguageFromPath(f.path),
      }));
      projectFiles.set(id, newFiles);
    }
    conversations.set(id, { ...conv, conversationPhase: result.newPhase, updatedAt: new Date() });
    sendSSE(res, {
      done: true,
      phase: result.newPhase,
      thinkingSteps: result.thinkingSteps,
      slmHealth: result.slmHealth || [],
      validationSummary: result.validationSummary,
    });
  } catch (err: any) {
    sendSSE(res, { error: String(err?.message || err) });
  } finally {
    inFlightResumes.delete(id);
    res.end();
  }
});

router.put("/files/*filePath", async (req, res) => {
  const rawPath = (req.params as any).filePath;
  const joined = Array.isArray(rawPath) ? rawPath.join("/") : String(rawPath || "");
  const filePath = decodeURIComponent(joined);
  if (!filePath) { res.status(400).json({ error: "File path is required" }); return; }
  const { content, conversationId } = req.body || {};
  if (content === undefined) { res.status(400).json({ error: "content is required" }); return; }
  const convId = conversationId ? parseValidId(String(conversationId)) : null;
  if (convId !== null) {
    const files = projectFiles.get(convId) || [];
    const idx = files.findIndex((f) => f.path === filePath);
    if (idx >= 0) {
      files[idx].content = content;
    } else {
      files.push({ path: filePath, content, language: inferLanguageFromPath(filePath) });
    }
    projectFiles.set(convId, files);
  }

  res.json({ success: true, path: filePath });
});

export default router;
