import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../ai-fullstack-generator.js', () => ({
  isAIAvailable: vi.fn(),
  getGeneratorAIConfig: vi.fn(() => ({ apiKey: '', baseUrl: '', model: 'test-model', client: null })),
}));

vi.mock('../local-llm-client.js', () => ({
  generateWithLocalLLM: vi.fn(),
  extractJSON: vi.fn((raw: string) => {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? match[0] : null;
  }),
}));

vi.mock('../gemma-provider.js', () => ({
  generateWithProvider: vi.fn(),
}));

vi.mock('../knowledge-retrieval/chunk-index.js', () => ({
  queryKnowledge: vi.fn(),
}));

vi.mock('../knowledge-retrieval/stage-retriever.js', () => ({
  retrieveForStage: vi.fn(() => Promise.resolve('')),
}));

vi.mock('../post-generation-validator.js', () => ({
  validateGeneratedFiles: vi.fn(() => []),
}));

vi.mock('../generation-learning-engine.js', () => ({
  learningEngine: {
    recordGenerationOutcome: vi.fn(() => Promise.resolve()),
    applyLearnedPatterns: vi.fn((plan: Record<string, unknown>) => plan),
  },
}));

vi.mock('../llm-training-context.js', () => ({
  EDIT_CODE_PROMPT: 'system edit prompt',
  FIX_CODE_PROMPT: 'system fix prompt',
}));

import { generateAIEdit, generateKBEdit, threeTierEdit } from '../ai-code-editor.js';
import { isAIAvailable } from '../ai-fullstack-generator.js';
import { generateWithProvider } from '../gemma-provider.js';
import { queryKnowledge } from '../knowledge-retrieval/chunk-index.js';
import { retrieveForStage } from '../knowledge-retrieval/stage-retriever.js';
import { validateGeneratedFiles } from '../post-generation-validator.js';
import { learningEngine } from '../generation-learning-engine.js';
import type { EditRequest, EditResult } from '../targeted-code-editor.js';

const mockIsAIAvailable = vi.mocked(isAIAvailable);
const mockProvider = vi.mocked(generateWithProvider);
const providerOk = (content: string, source: 'gemma' | 'cloud' = 'gemma') => ({
  content,
  source,
  gemmaHints: null,
  model: 'test-model',
  latencyMs: 1,
});
const mockLocalLLM = {
  mockResolvedValue: (raw: string) => mockProvider.mockResolvedValue(providerOk(raw)),
  mockRejectedValue: (err: Error) => mockProvider.mockRejectedValue(err),
  mockImplementation: (fn: () => Promise<string>) =>
    mockProvider.mockImplementation(async () => providerOk(await fn())),
  mock: mockProvider.mock,
};
const mockQueryKnowledge = vi.mocked(queryKnowledge);
const mockRetrieveForStage = vi.mocked(retrieveForStage);
const mockValidate = vi.mocked(validateGeneratedFiles);
const mockRecordOutcome = vi.mocked(learningEngine.recordGenerationOutcome);
const mockApplyLearned = vi.mocked(learningEngine.applyLearnedPatterns);

const sampleTargetFiles = [
  { path: 'src/App.tsx', content: 'export default function App() { return <div>Hello</div>; }' },
];

const sampleProjectFiles = [
  { path: 'src/App.tsx', content: 'export default function App() { return <div>Hello</div>; }', language: 'tsx' },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateAIEdit', () => {
  it('returns empty result when no AI is available', async () => {
    mockIsAIAvailable.mockResolvedValue({ local: false, cloud: false });
    const steps: { phase: string; label: string; detail?: string }[] = [];

    const result = await generateAIEdit('change color', sampleTargetFiles, 'style', steps, sampleProjectFiles);

    expect(result.edits).toHaveLength(0);
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toBe('No AI available');
  });

  it('generates edits from local AI and validates them', async () => {
    mockIsAIAvailable.mockResolvedValue({ local: true, cloud: false });
    mockLocalLLM.mockResolvedValue(JSON.stringify({
      edits: [{
        filePath: 'src/App.tsx',
        editType: 'modify',
        newContent: 'export default function App() { return <div style={{color:"red"}}>Hello</div>; }',
        description: 'Changed text color to red',
      }],
      reasoning: 'Applied style change',
    }));
    mockValidate.mockReturnValue([]);
    const steps: { phase: string; label: string; detail?: string }[] = [];

    const result = await generateAIEdit('make text red', sampleTargetFiles, 'style', steps, sampleProjectFiles);

    expect(result.edits).toHaveLength(1);
    expect(result.tier).toBe('ai');
    expect(result.confidence).toBe(0.85);
    expect(result.edits[0].filePath).toBe('src/App.tsx');
    expect(mockValidate).toHaveBeenCalled();
  });

  it('rejects edits targeting files not in targetFiles', async () => {
    mockIsAIAvailable.mockResolvedValue({ local: true, cloud: false });
    mockLocalLLM.mockResolvedValue(JSON.stringify({
      edits: [{
        filePath: 'src/Secret.tsx',
        editType: 'modify',
        newContent: 'stolen content',
        description: 'sneaky edit',
      }],
    }));
    const steps: { phase: string; label: string; detail?: string }[] = [];

    const result = await generateAIEdit('change something', sampleTargetFiles, 'feature', steps, sampleProjectFiles);

    expect(result.edits).toHaveLength(0);
    expect(result.confidence).toBe(0);
  });

  it('falls back from local to cloud AI on local failure', async () => {
    mockIsAIAvailable.mockResolvedValue({ local: true, cloud: true });
    mockLocalLLM.mockRejectedValue(new Error('Ollama not running'));

    const steps: { phase: string; label: string; detail?: string }[] = [];
    const result = await generateAIEdit('update content', sampleTargetFiles, 'feature', steps, sampleProjectFiles);

    expect(steps.some(s => s.label.includes('AI edit failed'))).toBe(true);
    expect(result.tier).toBe('ai');
    expect(result.confidence).toBe(0);
  });

  it('retries with error context when validation fails then succeeds', async () => {
    mockIsAIAvailable.mockResolvedValue({ local: true, cloud: false });
    let callCount = 0;
    mockLocalLLM.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return JSON.stringify({
          edits: [{
            filePath: 'src/App.tsx',
            editType: 'modify',
            newContent: 'broken import content',
            description: 'first attempt',
          }],
        });
      }
      return JSON.stringify({
        edits: [{
          filePath: 'src/App.tsx',
          editType: 'modify',
          newContent: 'import React from "react";\nexport default function App() { return <div>Fixed</div>; }',
          description: 'fixed attempt',
        }],
      });
    });

    let validateCount = 0;
    mockValidate.mockImplementation(() => {
      validateCount++;
      if (validateCount === 1) {
        return [{
          type: 'missing_import' as const,
          severity: 'error' as const,
          file: 'src/App.tsx',
          message: 'Missing import for React',
        }];
      }
      return [];
    });

    const steps: { phase: string; label: string; detail?: string }[] = [];
    const result = await generateAIEdit('update app', sampleTargetFiles, 'feature', steps, sampleProjectFiles);

    expect(callCount).toBe(2);
    expect(result.edits).toHaveLength(1);
    expect(result.confidence).toBe(0.8);
    expect(steps.some(s => s.label.includes('Retrying with error context'))).toBe(true);
    expect(steps.some(s => s.label.includes('Retry succeeded'))).toBe(true);
  });
});

describe('generateKBEdit', () => {
  it('returns empty when no KB chunks found', async () => {
    mockQueryKnowledge.mockResolvedValue([]);
    const steps: { phase: string; label: string; detail?: string }[] = [];

    const result = await generateKBEdit('add auth', sampleTargetFiles, 'feature', steps, sampleProjectFiles);

    expect(result.edits).toHaveLength(0);
    expect(result.tier).toBe('kb');
  });

  it('includes anti-pattern chunks for fix edits', async () => {
    mockQueryKnowledge.mockResolvedValue([]);
    mockIsAIAvailable.mockResolvedValue({ local: false, cloud: false });
    const steps: { phase: string; label: string; detail?: string }[] = [];

    await generateKBEdit('fix the bug', sampleTargetFiles, 'fix', steps, sampleProjectFiles);

    const queryCall = mockQueryKnowledge.mock.calls[0][0];
    expect(queryCall.filters?.type).toContain('anti-pattern');
  });

  it('applies anti-pattern fixes from KB chunks', async () => {
    const targetWithBug = [
      { path: 'src/App.tsx', content: 'const x = document.getElementById("foo");\nx.style.color = "red";' },
    ];
    const projectWithBug = [
      { ...targetWithBug[0], language: 'tsx' },
    ];

    mockQueryKnowledge.mockResolvedValue([{
      id: 'ap-1',
      type: 'anti-pattern' as const,
      content: 'Anti-pattern: unsafe element access\nBad:\ndocument.getElementById("foo")\nGood:\ndocument.querySelector("#foo")',
      tags: ['dom', 'safety'],
      tokenEstimate: 50,
    }]);
    mockIsAIAvailable.mockResolvedValue({ local: false, cloud: false });
    mockValidate.mockReturnValue([]);
    const steps: { phase: string; label: string; detail?: string }[] = [];

    const result = await generateKBEdit('fix the bug', targetWithBug, 'fix', steps, projectWithBug);

    expect(result.edits.length).toBeGreaterThanOrEqual(1);
    if (result.edits.length > 0) {
      expect(result.edits[0].newContent).toContain('querySelector');
    }
  });

  it('calls retrieveForStage and applyLearnedPatterns during KB retrieval', async () => {
    mockQueryKnowledge.mockResolvedValue([]);
    mockIsAIAvailable.mockResolvedValue({ local: false, cloud: false });
    const steps: { phase: string; label: string; detail?: string }[] = [];

    await generateKBEdit('add feature', sampleTargetFiles, 'feature', steps, sampleProjectFiles);

    expect(mockRetrieveForStage).toHaveBeenCalledWith(
      expect.objectContaining({ stageName: 'generate', query: expect.stringContaining('feature') })
    );
  });
});

describe('threeTierEdit', () => {
  const makeRequest = (msg: string): EditRequest => ({
    userMessage: msg,
    projectFiles: sampleProjectFiles,
  });

  const regexFallback = (req: EditRequest): EditResult => ({
    edits: [{
      filePath: 'src/App.tsx',
      editType: 'modify',
      oldContent: 'old',
      newContent: 'new',
      description: 'regex edit',
      linesChanged: 1,
    }],
    summary: 'Regex fallback applied',
    thinkingSteps: [{ phase: 'regex', label: 'Regex applied' }],
    affectedFiles: ['src/App.tsx'],
    editType: 'feature',
  });

  it('uses AI tier when it succeeds', async () => {
    mockIsAIAvailable.mockResolvedValue({ local: true, cloud: false });
    mockLocalLLM.mockResolvedValue(JSON.stringify({
      edits: [{
        filePath: 'src/App.tsx',
        editType: 'modify',
        newContent: 'export default function App() { return <div>AI edit</div>; }',
        description: 'AI modification',
      }],
    }));
    mockValidate.mockReturnValue([]);

    const steps: { phase: string; label: string; detail?: string }[] = [];
    const result = await threeTierEdit(makeRequest('add feature'), sampleTargetFiles, regexFallback, steps);

    expect(result.summary).toContain('Tier 1 (AI)');
    expect(result.edits[0].description).toBe('AI modification');
    expect(mockRecordOutcome).toHaveBeenCalled();
  });

  it('cascades from AI to KB to regex when higher tiers fail', async () => {
    mockIsAIAvailable.mockResolvedValue({ local: false, cloud: false });
    mockQueryKnowledge.mockResolvedValue([]);

    const steps: { phase: string; label: string; detail?: string }[] = [];
    const result = await threeTierEdit(makeRequest('add feature'), sampleTargetFiles, regexFallback, steps);

    expect(result.summary).toContain('Tier 3 (Regex)');
    expect(steps.some(s => s.label.includes('Tier 3'))).toBe(true);
    expect(mockRecordOutcome).toHaveBeenCalled();
  });

  it('cascades to KB when AI returns no edits', async () => {
    mockIsAIAvailable.mockResolvedValue({ local: true, cloud: false });
    mockLocalLLM.mockResolvedValue('{"edits": []}');
    mockQueryKnowledge.mockResolvedValue([]);

    const steps: { phase: string; label: string; detail?: string }[] = [];
    const result = await threeTierEdit(makeRequest('add auth'), sampleTargetFiles, regexFallback, steps);

    expect(mockQueryKnowledge).toHaveBeenCalled();
    expect(result.summary).toContain('Tier 3 (Regex)');
  });

  it('correctly identifies fix edit type from user message', async () => {
    mockIsAIAvailable.mockResolvedValue({ local: false, cloud: false });
    mockQueryKnowledge.mockResolvedValue([]);

    const steps: { phase: string; label: string; detail?: string }[] = [];
    await threeTierEdit(makeRequest('fix the broken button'), sampleTargetFiles, regexFallback, steps);

    expect(steps.some(s => s.detail?.includes('fix'))).toBe(true);
  });

  it('preserves thinking steps from all tiers in final result', async () => {
    mockIsAIAvailable.mockResolvedValue({ local: false, cloud: false });
    mockQueryKnowledge.mockResolvedValue([]);

    const steps: { phase: string; label: string; detail?: string }[] = [];
    const result = await threeTierEdit(makeRequest('update styling'), sampleTargetFiles, regexFallback, steps);

    const phases = result.thinkingSteps.map(s => s.phase);
    expect(phases).toContain('tier-selection');
    expect(phases).toContain('tier-result');
  });

  it('rejects create edits to directories outside target scope', async () => {
    mockIsAIAvailable.mockResolvedValue({ local: true, cloud: false });
    mockLocalLLM.mockResolvedValue(JSON.stringify({
      edits: [{
        filePath: 'config/secrets.ts',
        editType: 'create',
        newContent: 'export const hack = true;',
        description: 'sneaky file creation',
      }],
    }));
    mockValidate.mockReturnValue([]);

    const steps: { phase: string; label: string; detail?: string }[] = [];
    const result = await threeTierEdit(
      { userMessage: 'add feature', projectFiles: sampleProjectFiles },
      sampleTargetFiles,
      regexFallback,
      steps
    );

    expect(result.summary).toContain('Tier 3 (Regex)');
  });

  it('drops edits that fail validation, retries with error context, then falls through', async () => {
    mockIsAIAvailable.mockResolvedValue({ local: true, cloud: false });
    mockLocalLLM.mockResolvedValue(JSON.stringify({
      edits: [{
        filePath: 'src/App.tsx',
        editType: 'modify',
        newContent: 'broken content',
        description: 'bad edit',
      }],
    }));
    mockValidate.mockReturnValue([{
      type: 'missing_import' as const,
      severity: 'error' as const,
      file: 'src/App.tsx',
      message: 'Missing import for React',
    }]);
    mockQueryKnowledge.mockResolvedValue([]);

    const steps: { phase: string; label: string; detail?: string }[] = [];
    const result = await threeTierEdit(
      { userMessage: 'add feature', projectFiles: sampleProjectFiles },
      sampleTargetFiles,
      regexFallback,
      steps
    );

    expect(steps.some(s => s.label.includes('Validation found'))).toBe(true);
    expect(result.summary).toContain('Tier 3 (Regex)');
  });

  it('passes only narrowed target files to AI, not all project files', async () => {
    const narrowTargets = [{ path: 'src/App.tsx', content: 'narrow content' }];
    const fullProject = [
      { path: 'src/App.tsx', content: 'narrow content', language: 'tsx' },
      { path: 'src/Secret.tsx', content: 'secret stuff', language: 'tsx' },
      { path: '.env', content: 'API_KEY=secret', language: 'text' },
    ];

    mockIsAIAvailable.mockResolvedValue({ local: true, cloud: false });
    mockLocalLLM.mockResolvedValue('{"edits": []}');
    mockQueryKnowledge.mockResolvedValue([]);

    const steps: { phase: string; label: string; detail?: string }[] = [];
    await threeTierEdit(
      { userMessage: 'add feature', projectFiles: fullProject },
      narrowTargets,
      regexFallback,
      steps
    );

    const promptArg = mockLocalLLM.mock.calls[0]?.[0] || '';
    expect(promptArg).not.toContain('secret stuff');
    expect(promptArg).not.toContain('API_KEY=secret');
  });

  it('indicates Tier 3 (Regex) in summary when regex fallback is used', async () => {
    mockIsAIAvailable.mockResolvedValue({ local: false, cloud: false });
    mockQueryKnowledge.mockResolvedValue([]);

    const steps: { phase: string; label: string; detail?: string }[] = [];
    const result = await threeTierEdit(makeRequest('change color'), sampleTargetFiles, regexFallback, steps);

    expect(result.summary).toMatch(/^Tier 3 \(Regex\):/);
  });
});
