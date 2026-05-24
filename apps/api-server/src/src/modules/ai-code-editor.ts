import { isAIAvailable, getGeneratorAIConfig } from './ai-fullstack-generator.js';
import { extractJSON } from './local-llm-client.js';
import { generateWithProvider } from './gemma-provider.js';
import { EDIT_CODE_PROMPT, FIX_CODE_PROMPT } from './llm-training-context.js';
import { queryKnowledge } from './knowledge-retrieval/chunk-index.js';
import { retrieveForStage } from './knowledge-retrieval/stage-retriever.js';
import { validateGeneratedFiles } from './post-generation-validator.js';
import { learningEngine } from './generation-learning-engine.js';
import type { FileEdit, EditRequest, EditResult } from './targeted-code-editor.js';
import type { KnowledgeChunk } from './knowledge-retrieval/chunk-extractor.js';
import type { ChunkType } from './knowledge-retrieval/chunk-extractor.js';
import type { ValidationIssue } from './post-generation-validator.js';

interface AIEditResult {
  edits: FileEdit[];
  tier: 'ai' | 'kb' | 'regex';
  confidence: number;
  reasoning?: string;
}

interface ThinkingStep {
  phase: string;
  label: string;
  detail?: string;
}

interface TargetFile {
  path: string;
  content: string;
}

interface ParsedEdit {
  filePath: string;
  editType: string;
  newContent: string;
  description: string;
}

function buildEditPrompt(
  userMessage: string,
  targetFiles: TargetFile[],
  editType: string,
  kbContext?: string,
  validationErrors?: string
): string {
  const fileSection = targetFiles
    .map(f => `--- FILE: ${f.path} ---\n${f.content.slice(0, 3000)}`)
    .join('\n\n');

  const kbSection = kbContext
    ? `\n\nRELEVANT KNOWLEDGE BASE PATTERNS:\n${kbContext}\n`
    : '';

  const validationSection = validationErrors
    ? `\n\nPREVIOUS ATTEMPT HAD VALIDATION ERRORS - FIX THESE:\n${validationErrors}\n`
    : '';

  return `You are a code editor. The user wants to ${editType} their code.
${kbSection}${validationSection}
USER REQUEST: ${userMessage}

CURRENT FILES:
${fileSection}

IMPORTANT: Only modify the files listed above. Do NOT create edits for files not shown.

Return a JSON array of edits. Each edit object has:
- "filePath": string (must be one of the files shown above)
- "editType": "modify" | "create" | "delete"
- "newContent": string (the COMPLETE new file content for modify/create)
- "description": string (what changed)

Return ONLY valid JSON. No markdown, no explanation. Format:
{"edits": [...], "reasoning": "brief explanation"}`;
}

async function callCloudAI(prompt: string, systemPrompt: string): Promise<string> {
  const config = getGeneratorAIConfig();

  if (config.client) {
    const response = await config.client.chat.completions.create({
      model: config.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    });
    return response.choices?.[0]?.message?.content || '';
  }

  if (!config.apiKey) throw new Error('No cloud AI key');

  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    throw new Error(`Cloud AI error: ${response.status}`);
  }

  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content || '';
}

function parseAIEdits(raw: string, targetFiles: TargetFile[]): FileEdit[] {
  const jsonStr = extractJSON(raw);
  if (!jsonStr) return [];

  try {
    const parsed = JSON.parse(jsonStr) as { edits?: ParsedEdit[] } | ParsedEdit[];
    const editsArr: ParsedEdit[] = Array.isArray(parsed)
      ? parsed
      : (parsed as { edits?: ParsedEdit[] }).edits || [];

    const allowedPaths = new Set(targetFiles.map(f => f.path));
    const allowedDirs = new Set(
      targetFiles.map(f => f.path.substring(0, f.path.lastIndexOf('/')))
    );

    return editsArr
      .filter((e: ParsedEdit): boolean => {
        if (typeof e.filePath !== 'string' || e.newContent === undefined) return false;
        if (allowedPaths.has(e.filePath)) return true;
        if (e.editType === 'create') {
          const createDir = e.filePath.substring(0, e.filePath.lastIndexOf('/'));
          return allowedDirs.has(createDir);
        }
        return false;
      })
      .map((e: ParsedEdit): FileEdit => {
        const existing = targetFiles.find(f => f.path === e.filePath);
        const oldContent = existing?.content || '';
        const newContent = String(e.newContent || '');
        const editType: FileEdit['editType'] =
          e.editType === 'delete' ? 'delete' :
          e.editType === 'create' ? 'create' : 'modify';
        return {
          filePath: e.filePath,
          editType,
          oldContent,
          newContent,
          description: String(e.description || 'AI-generated edit'),
          linesChanged: countChangedLines(oldContent, newContent),
        };
      })
      .filter((e: FileEdit) => e.editType === 'create' || e.editType === 'delete' || e.newContent !== e.oldContent);
  } catch {
    return [];
  }
}

function countChangedLines(a: string, b: string): number {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  let changes = 0;
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    if ((aLines[i] || '') !== (bLines[i] || '')) changes++;
  }
  return Math.max(changes, 1);
}

function runValidation(
  edits: FileEdit[],
  allFiles: { path: string; content: string; language: string }[]
): { cleanEdits: FileEdit[]; errors: ValidationIssue[] } {
  if (edits.length === 0) return { cleanEdits: edits, errors: [] };

  const fileMap = new Map(allFiles.map(f => [f.path, f]));
  for (const edit of edits) {
    if (edit.editType === 'delete') {
      fileMap.delete(edit.filePath);
    } else {
      const ext = edit.filePath.split('.').pop()?.toLowerCase() || 'text';
      const langMap: Record<string, string> = {
        tsx: 'tsx', ts: 'typescript', jsx: 'jsx', js: 'javascript',
        css: 'css', html: 'html', json: 'json',
      };
      fileMap.set(edit.filePath, {
        path: edit.filePath,
        content: edit.newContent,
        language: langMap[ext] || ext,
      });
    }
  }

  const filesToValidate = Array.from(fileMap.values());
  const issues = validateGeneratedFiles(filesToValidate);
  const errors = issues.filter(i => i.severity === 'error');

  if (errors.length > 0) {
    const errorFiles = new Set(errors.map(e => e.file));
    const cleanEdits = edits.filter(e => !errorFiles.has(e.filePath));
    return { cleanEdits, errors };
  }

  return { cleanEdits: edits, errors: [] };
}

function recordEditOutcome(
  edits: FileEdit[],
  tier: string,
  editType: string,
  userMessage: string
): void {
  try {
    if (edits.length === 0) return;

    learningEngine.recordGenerationOutcome({
      plan: {
        projectName: `edit-${editType}`,
        overview: userMessage.slice(0, 200),
        techStack: [],
        modules: [],
        dataModel: [],
        pages: [],
        apiEndpoints: [],
        workflows: [],
        roles: [],
        fileBlueprint: [],
        kpis: [],
        estimatedComplexity: 'low',
      },
      files: edits.map(e => ({
        path: e.filePath,
        content: e.newContent,
      })),
      success: true,
      qualityScore: tier === 'ai' ? 0.85 : tier === 'kb' ? 0.6 : 0.4,
      domainId: `edit-${tier}`,
      errors: [],
    }).catch(() => {});
  } catch {
    // non-fatal
  }
}

async function tryAIGeneration(
  prompt: string,
  systemPrompt: string,
  steps: ThinkingStep[]
): Promise<string> {
  try {
    const result = await generateWithProvider(prompt, systemPrompt);

    if (result.source === "cloud" && result.gemmaHints) {
      steps.push({
        phase: 'ai-edit',
        label: 'Gemma failed|||Fell back to cloud AI with context hints',
        detail: (result.gemmaHints.errorMessage || 'unknown error').slice(0, 80),
      });
    }

    return result.content;
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function generateAIEdit(
  userMessage: string,
  targetFiles: TargetFile[],
  editType: string,
  steps: ThinkingStep[],
  allProjectFiles: { path: string; content: string; language: string }[]
): Promise<AIEditResult> {
  const ai = await isAIAvailable();
  if (!ai.local && !ai.cloud) {
    return { edits: [], tier: 'ai', confidence: 0, reasoning: 'No AI available' };
  }

  const systemPrompt = editType === 'fix' ? FIX_CODE_PROMPT : EDIT_CODE_PROMPT;
  const prompt = buildEditPrompt(userMessage, targetFiles, editType);

  steps.push({
    phase: 'ai-edit',
    label: `Tier 1: AI code editing|||${ai.local ? 'Local' : 'Cloud'} AI interpreting your request`,
    detail: `Using ${ai.local ? 'Ollama (local)' : 'cloud AI'} to generate edits for ${targetFiles.length} file(s)`,
  });

  try {
    const raw = await tryAIGeneration(prompt, systemPrompt, steps);
    const edits = parseAIEdits(raw, targetFiles);

    if (edits.length > 0) {
      const { cleanEdits, errors } = runValidation(edits, allProjectFiles);

      if (errors.length > 0 && cleanEdits.length < edits.length) {
        steps.push({
          phase: 'validation',
          label: `Validation found ${errors.length} issue(s)|||Retrying with error context`,
          detail: errors.slice(0, 3).map(e => `${e.file}: ${e.message}`).join('; '),
        });

        const errorContext = errors.map(e => `${e.file}: ${e.message}${e.suggestion ? ` (fix: ${e.suggestion})` : ''}`).join('\n');
        const retryPrompt = buildEditPrompt(userMessage, targetFiles, editType, undefined, errorContext);

        try {
          const retryRaw = await tryAIGeneration(retryPrompt, systemPrompt, steps);
          const retryEdits = parseAIEdits(retryRaw, targetFiles);
          if (retryEdits.length > 0) {
            const retryValidation = runValidation(retryEdits, allProjectFiles);
            if (retryValidation.errors.length === 0) {
              steps.push({
                phase: 'validation',
                label: 'Retry succeeded|||Validation passed on second attempt',
              });
              return { edits: retryEdits, tier: 'ai', confidence: 0.8, reasoning: 'AI edits (validated after retry)' };
            }
            if (retryValidation.cleanEdits.length > 0) {
              steps.push({
                phase: 'validation',
                label: `Retry partially fixed|||${retryValidation.cleanEdits.length} clean edit(s)`,
              });
              return { edits: retryValidation.cleanEdits, tier: 'ai', confidence: 0.7, reasoning: 'AI edits (partial retry)' };
            }
          }
        } catch {
          // retry failed, use clean edits from first attempt
        }

        if (cleanEdits.length > 0) {
          steps.push({
            phase: 'validation',
            label: `Using ${cleanEdits.length} valid edit(s) from first attempt|||Dropped invalid edits`,
          });
          return { edits: cleanEdits, tier: 'ai', confidence: 0.7, reasoning: 'AI edits (partial, post-validation)' };
        }

        steps.push({
          phase: 'validation',
          label: 'All AI edits failed validation|||Falling back to KB',
        });
        return { edits: [], tier: 'ai', confidence: 0 };
      }

      steps.push({
        phase: 'validation',
        label: 'Validation passed|||Edits look clean',
      });

      steps.push({
        phase: 'ai-edit',
        label: `AI generated ${cleanEdits.length} edit(s)|||AI edits ready`,
        detail: cleanEdits.map(e => `${e.editType} ${e.filePath}: ${e.description}`).join('; '),
      });
      return { edits: cleanEdits, tier: 'ai', confidence: 0.85, reasoning: 'AI-generated edits' };
    }

    steps.push({
      phase: 'ai-edit',
      label: 'AI returned no actionable edits|||Falling back to KB',
    });
    return { edits: [], tier: 'ai', confidence: 0 };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    steps.push({
      phase: 'ai-edit',
      label: 'AI edit failed|||Falling back to knowledge base',
      detail: errMsg.slice(0, 100),
    });
    return { edits: [], tier: 'ai', confidence: 0, reasoning: errMsg };
  }
}

export async function generateKBEdit(
  userMessage: string,
  targetFiles: TargetFile[],
  editType: string,
  steps: ThinkingStep[],
  allProjectFiles: { path: string; content: string; language: string }[]
): Promise<AIEditResult> {
  steps.push({
    phase: 'kb-edit',
    label: 'Tier 2: Knowledge base retrieval|||Searching patterns and best practices',
    detail: `Querying BM25+embedding index for "${userMessage.slice(0, 60)}"`,
  });

  try {
    const stageMap: Record<string, string> = {
      fix: 'debug', feature: 'generate', refactor: 'generate',
      style: 'generate', content: 'generate', structure: 'plan',
    };
    const stageName = stageMap[editType] || 'generate';

    let stageContext = '';
    try {
      stageContext = await retrieveForStage({
        stageName,
        query: `${editType} ${userMessage}`,
      });
    } catch {
      // stage retrieval is best-effort
    }

    const chunkTypes: ChunkType[] =
      editType === 'fix'
        ? ['snippet', 'best-practice', 'pattern', 'concept', 'stack', 'anti-pattern']
        : ['snippet', 'best-practice', 'pattern', 'concept', 'stack'];

    const chunks = await queryKnowledge({
      text: `${editType} ${userMessage}`,
      filters: { type: chunkTypes },
      topK: 5,
    });

    if (chunks.length === 0 && !stageContext) {
      steps.push({
        phase: 'kb-edit',
        label: 'No KB matches found|||Falling back to regex',
      });
      return { edits: [], tier: 'kb', confidence: 0 };
    }

    const kbContext = [
      stageContext,
      ...chunks.map((c: KnowledgeChunk) => `[${c.type}] ${c.content.slice(0, 500)}`),
    ].filter(Boolean).join('\n\n');

    steps.push({
      phase: 'kb-edit',
      label: `Found ${chunks.length} knowledge chunks${stageContext ? ' + stage context' : ''}|||Applying patterns`,
      detail: chunks.map((c: KnowledgeChunk) => c.type).join(', '),
    });

    let learnedContext = '';
    try {
      const learnedPlan = learningEngine.applyLearnedPatterns({
        projectName: `edit-${editType}`,
        overview: userMessage.slice(0, 200),
        techStack: [],
        modules: [],
        dataModel: [],
        pages: [],
        apiEndpoints: [],
        workflows: [],
        roles: [],
        fileBlueprint: [],
        kpis: [],
        estimatedComplexity: 'low',
      });
      if (learnedPlan.dataModel.length > 0 || learnedPlan.modules.length > 0) {
        learnedContext = `\nLEARNED PATTERNS: ${learnedPlan.modules.map(m => m.name).join(', ')}`;
      }
    } catch {
      // learning engine is best-effort
    }

    let edits = applyKBPatterns(userMessage, targetFiles, chunks, editType);

    if (edits.length > 0) {
      const { cleanEdits, errors } = runValidation(edits, allProjectFiles);
      if (errors.length > 0) {
        steps.push({
          phase: 'validation',
          label: `KB validation dropped ${edits.length - cleanEdits.length} edit(s)|||${cleanEdits.length} remain`,
          detail: errors.slice(0, 3).map(e => `${e.file}: ${e.message}`).join('; '),
        });
        edits = cleanEdits;
      } else {
        steps.push({ phase: 'validation', label: 'KB validation passed|||Edits look clean' });
      }

      if (edits.length > 0) {
        steps.push({
          phase: 'kb-edit',
          label: `KB produced ${edits.length} edit(s)|||KB edits ready`,
          detail: edits.map(e => `${e.editType} ${e.filePath}`).join('; '),
        });
        return { edits, tier: 'kb', confidence: 0.6, reasoning: `Applied ${chunks.length} knowledge patterns` };
      }
    }

    const ai = await isAIAvailable();
    if (ai.local || ai.cloud) {
      steps.push({
        phase: 'kb-edit',
        label: 'KB patterns found but no direct edits|||Using KB context with AI',
      });

      const systemPrompt = editType === 'fix' ? FIX_CODE_PROMPT : EDIT_CODE_PROMPT;
      const fullContext = kbContext + learnedContext;
      const prompt = buildEditPrompt(userMessage, targetFiles, editType, fullContext);

      try {
        const raw = await tryAIGeneration(prompt, systemPrompt, steps);
        const aiEdits = parseAIEdits(raw, targetFiles);
        if (aiEdits.length > 0) {
          const { cleanEdits, errors } = runValidation(aiEdits, allProjectFiles);
          if (errors.length > 0) {
            steps.push({
              phase: 'validation',
              label: `KB+AI validation dropped ${aiEdits.length - cleanEdits.length} edit(s)`,
            });
          }
          if (cleanEdits.length > 0) {
            steps.push({
              phase: 'kb-edit',
              label: `KB-augmented AI produced ${cleanEdits.length} edit(s)|||Edits ready`,
            });
            return { edits: cleanEdits, tier: 'kb', confidence: 0.7, reasoning: 'KB-augmented AI edits' };
          }
        }
      } catch {
        // fall through to regex
      }
    }

    steps.push({
      phase: 'kb-edit',
      label: 'KB could not produce edits|||Falling back to regex',
    });
    return { edits: [], tier: 'kb', confidence: 0 };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    steps.push({
      phase: 'kb-edit',
      label: 'KB retrieval failed|||Falling back to regex',
      detail: errMsg.slice(0, 100),
    });
    return { edits: [], tier: 'kb', confidence: 0, reasoning: errMsg };
  }
}

function applyKBPatterns(
  userMessage: string,
  targetFiles: TargetFile[],
  chunks: KnowledgeChunk[],
  editType: string
): FileEdit[] {
  const edits: FileEdit[] = [];

  const snippetChunks = chunks.filter((c: KnowledgeChunk) => c.type === 'snippet' || c.type === 'stack');
  const antiPatternChunks = chunks.filter((c: KnowledgeChunk) => c.type === 'anti-pattern');

  if (editType === 'fix' && antiPatternChunks.length > 0) {
    for (const file of targetFiles) {
      const fileLower = file.content.toLowerCase();
      for (const ap of antiPatternChunks) {
        const badMatch = ap.content.match(/Bad:\n([\s\S]*?)(?:\nGood:|\n\[|$)/);
        const goodMatch = ap.content.match(/Good:\n([\s\S]*?)(?:\nFix:|\n\[|$)/);
        if (badMatch && goodMatch) {
          const badPattern = badMatch[1].trim().split('\n')[0].trim();
          const goodPattern = goodMatch[1].trim().split('\n')[0].trim();
          if (badPattern && goodPattern && fileLower.includes(badPattern.toLowerCase())) {
            const newContent = file.content.replace(
              new RegExp(escapeRegex(badPattern), 'g'),
              goodPattern
            );
            if (newContent !== file.content) {
              edits.push({
                filePath: file.path,
                editType: 'modify',
                oldContent: file.content,
                newContent,
                description: `Fixed anti-pattern: ${ap.content.split('\n')[0].replace('Anti-pattern: ', '')}`,
                linesChanged: countChangedLines(file.content, newContent),
              });
            }
          }
        }
      }
    }
  }

  if (editType === 'feature' && snippetChunks.length > 0) {
    for (const snippet of snippetChunks) {
      const codeMatch = snippet.content.match(/```[\w]*\n([\s\S]*?)```/) ||
                        snippet.content.match(/(?:Code snippet|Stack snippet)[^\n]*\n(?:[^\n]*\n)?([\s\S]+)/);
      if (codeMatch) {
        const codeBlock = codeMatch[1].trim();
        if (codeBlock.length > 20) {
          for (const file of targetFiles) {
            if (isCompatibleCode(file.path, codeBlock)) {
              const insertionPoint = findInsertionPoint(file.content, editType);
              if (insertionPoint >= 0) {
                const before = file.content.slice(0, insertionPoint);
                const after = file.content.slice(insertionPoint);
                const newContent = before + '\n\n' + codeBlock + '\n' + after;
                edits.push({
                  filePath: file.path,
                  editType: 'modify',
                  oldContent: file.content,
                  newContent,
                  description: `Added pattern from KB: ${snippet.content.split('\n')[0]}`,
                  linesChanged: codeBlock.split('\n').length,
                });
                break;
              }
            }
          }
        }
      }
    }
  }

  return edits;
}

function isCompatibleCode(filePath: string, code: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const tsExts = ['ts', 'tsx', 'js', 'jsx'];
  const cssExts = ['css', 'scss', 'less'];
  const htmlExts = ['html', 'htm'];

  if (tsExts.includes(ext)) {
    return code.includes('function') || code.includes('const ') || code.includes('import ') ||
           code.includes('export ') || code.includes('=>') || code.includes('class ');
  }
  if (cssExts.includes(ext)) {
    return code.includes('{') && (code.includes(':') || code.includes('@'));
  }
  if (htmlExts.includes(ext)) {
    return code.includes('<') && code.includes('>');
  }
  return false;
}

function findInsertionPoint(content: string, editType: string): number {
  if (editType === 'feature') {
    const exportDefault = content.lastIndexOf('export default');
    if (exportDefault > 0) return exportDefault;

    const lastExport = content.lastIndexOf('export ');
    if (lastExport > 0) return lastExport;
  }

  const lastBrace = content.lastIndexOf('}');
  if (lastBrace > 0) return lastBrace;

  return content.length;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function threeTierEdit(
  request: EditRequest,
  narrowedTargetFiles: TargetFile[],
  regexFallback: (request: EditRequest) => EditResult,
  steps: ThinkingStep[]
): Promise<EditResult> {
  const { userMessage, projectFiles } = request;

  const editTypeGuess = guessEditType(userMessage);

  steps.push({
    phase: 'tier-selection',
    label: 'Three-tier edit engine|||Selecting best approach',
    detail: `Edit type: ${editTypeGuess}, ${narrowedTargetFiles.length} target file(s) of ${projectFiles.length} total`,
  });

  const aiResult = await generateAIEdit(userMessage, narrowedTargetFiles, editTypeGuess, steps, projectFiles);
  if (aiResult.edits.length > 0 && aiResult.confidence >= 0.5) {
    steps.push({
      phase: 'tier-result',
      label: `Tier 1 (AI) succeeded|||${aiResult.edits.length} edit(s) from AI`,
    });
    recordEditOutcome(aiResult.edits, 'ai', editTypeGuess, userMessage);
    return wrapEditsAsResult(aiResult.edits, steps, editTypeGuess, 'Tier 1 (AI)');
  }

  const kbResult = await generateKBEdit(userMessage, narrowedTargetFiles, editTypeGuess, steps, projectFiles);
  if (kbResult.edits.length > 0 && kbResult.confidence >= 0.4) {
    steps.push({
      phase: 'tier-result',
      label: `Tier 2 (KB) succeeded|||${kbResult.edits.length} edit(s) from knowledge base`,
    });
    recordEditOutcome(kbResult.edits, 'kb', editTypeGuess, userMessage);
    return wrapEditsAsResult(kbResult.edits, steps, editTypeGuess, 'Tier 2 (KB)');
  }

  steps.push({
    phase: 'tier-result',
    label: 'Using Tier 3 (regex)|||Pattern-matching edit engine',
    detail: 'AI and KB could not produce edits; using built-in regex editor',
  });

  const regexResult = regexFallback(request);
  regexResult.thinkingSteps = [...steps, ...regexResult.thinkingSteps];
  regexResult.summary = `Tier 3 (Regex): ${regexResult.summary}`;
  recordEditOutcome(regexResult.edits, 'regex', editTypeGuess, userMessage);

  if (regexResult.edits.length === 0) {
    steps.push({
      phase: 'tier-result',
      label: 'All tiers exhausted|||No edits produced',
      detail: `AI unavailable, KB returned no applicable patterns, regex found no matching edit patterns for: "${userMessage.slice(0, 80)}"`,
    });
    regexResult.thinkingSteps = [...steps];
    regexResult.summary = `Could not apply edit: "${userMessage.slice(0, 100)}". All three tiers (AI, Knowledge Base, Regex) were unable to produce edits. Try being more specific about what file or component to change.`;
  }

  return regexResult;
}

function guessEditType(message: string): string {
  const lower = message.toLowerCase();
  if (/\b(fix|bug|error|broken|crash|issue)\b/.test(lower)) return 'fix';
  if (/\b(refactor|rename|extract|split|combine)\b/.test(lower)) return 'refactor';
  if (/\b(add|new|create|insert)\b/.test(lower)) return 'feature';
  if (/\b(color|font|size|padding|margin|background|theme|style)\b/.test(lower)) return 'style';
  if (/\b(text|title|heading|label|wording|rename)\b/.test(lower)) return 'content';
  if (/\b(page|route|nav|section|tab)\b/.test(lower)) return 'structure';
  return 'feature';
}

function wrapEditsAsResult(
  edits: FileEdit[],
  steps: ThinkingStep[],
  editType: string,
  source: string
): EditResult {
  const affectedFiles = Array.from(new Set(edits.map(e => e.filePath)));
  const totalLines = edits.reduce((s, e) => s + e.linesChanged, 0);
  const validEditType = (['style', 'content', 'structure', 'feature', 'fix', 'refactor'].includes(editType)
    ? editType
    : 'feature') as EditResult['editType'];

  return {
    edits,
    summary: `${source}: Applied ${edits.length} edit(s) across ${affectedFiles.length} file(s), ~${totalLines} lines changed.`,
    thinkingSteps: steps,
    affectedFiles,
    editType: validEditType,
  };
}
