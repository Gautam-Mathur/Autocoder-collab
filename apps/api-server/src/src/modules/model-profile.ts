/**
 * Model Capability Profiles — Per-model tiering for prompt and template constraints.
 *
 * Each known SLM model id is mapped to a capability tier. Each tier defines a set of
 * TemplateConstraints that the inference engine injects into the system prompt and
 * that the template selector respects when assembling generation templates.
 *
 * The goal is to prevent weaker models from hallucinating long import lists or complex
 * animations they cannot reliably produce. Unknown models default to BASIC for safety.
 *
 * This module has zero external dependencies. It is a pure data + helper module so it
 * can be imported from both the model manager and the inference engine without cycles.
 */

export enum ModelCapabilityTier {
  FULL = 'full',
  STANDARD = 'standard',
  BASIC = 'basic',
}

export interface TemplateConstraints {
  /** Maximum number of third-party (non-relative) import statements allowed per file. */
  maxThirdPartyImportsPerFile: number;
  /** Prefer Tailwind utilities and inline style props over importing animation libraries. */
  preferInlineStyles: boolean;
  /** Avoid framer-motion / gsap / three.js style heavy animation code. */
  avoidComplexAnimations: boolean;
  /** Maximum number of distinct components defined in a single file. */
  maxComponentsPerFile: number;
}

const FULL_CONSTRAINTS: TemplateConstraints = {
  maxThirdPartyImportsPerFile: 10,
  preferInlineStyles: false,
  avoidComplexAnimations: false,
  maxComponentsPerFile: 5,
};

const STANDARD_CONSTRAINTS: TemplateConstraints = {
  maxThirdPartyImportsPerFile: 6,
  preferInlineStyles: true,
  avoidComplexAnimations: true,
  maxComponentsPerFile: 3,
};

const BASIC_CONSTRAINTS: TemplateConstraints = {
  maxThirdPartyImportsPerFile: 3,
  preferInlineStyles: true,
  avoidComplexAnimations: true,
  maxComponentsPerFile: 2,
};

/**
 * Hand-curated tier table. Match is case-insensitive and tolerant of common id forms:
 *   - "qwen2.5-coder:14b"
 *   - "Qwen2.5-Coder-14B-Instruct-GGUF"
 *   - "ollama/qwen2.5-coder:14b"
 * The longest matching key wins, so "qwen2.5-coder:14b" is preferred over "qwen2.5-coder".
 */
const TIER_RULES: ReadonlyArray<{ pattern: string; tier: ModelCapabilityTier }> = [
  // FULL tier — large, well-characterised coding models
  { pattern: 'qwen2.5-coder:14b', tier: ModelCapabilityTier.FULL },
  { pattern: 'qwen2.5-coder-14b', tier: ModelCapabilityTier.FULL },
  { pattern: 'deepseek-coder-v2:16b', tier: ModelCapabilityTier.FULL },
  { pattern: 'codellama:34b', tier: ModelCapabilityTier.FULL },
  { pattern: 'codestral:22b', tier: ModelCapabilityTier.FULL },

  // STANDARD tier — mid-size coding models
  { pattern: 'qwen2.5-coder:7b', tier: ModelCapabilityTier.STANDARD },
  { pattern: 'qwen2.5-coder-7b', tier: ModelCapabilityTier.STANDARD },
  { pattern: 'gemma2:9b', tier: ModelCapabilityTier.STANDARD },
  { pattern: 'codellama:13b', tier: ModelCapabilityTier.STANDARD },
  { pattern: 'codellama:7b', tier: ModelCapabilityTier.STANDARD },
  { pattern: 'starcoder2:7b', tier: ModelCapabilityTier.STANDARD },
  { pattern: 'deepseek-coder:6.7b', tier: ModelCapabilityTier.STANDARD },

  // BASIC tier — small / general-purpose models
  { pattern: 'gemma:7b', tier: ModelCapabilityTier.BASIC },
  { pattern: 'gemma2:2b', tier: ModelCapabilityTier.BASIC },
  { pattern: 'qwen2.5:3b', tier: ModelCapabilityTier.BASIC },
  { pattern: 'phi3:mini', tier: ModelCapabilityTier.BASIC },
  { pattern: 'starcoder2:3b', tier: ModelCapabilityTier.BASIC },
  { pattern: 'tinyllama', tier: ModelCapabilityTier.BASIC },
];

function normalize(modelId: string): string {
  return modelId.toLowerCase().trim();
}

/**
 * Returns the capability tier for a model id. Unknown models default to BASIC.
 *
 * Matching strategy: longest pattern wins. Patterns are checked as substrings of the
 * normalised id, so registry-style ids like "ollama/qwen2.5-coder:14b" still match.
 */
export function getModelTier(modelId: string | null | undefined): ModelCapabilityTier {
  if (!modelId) return ModelCapabilityTier.BASIC;
  const id = normalize(modelId);

  let best: { len: number; tier: ModelCapabilityTier } | null = null;
  for (const rule of TIER_RULES) {
    if (id.includes(rule.pattern) && (!best || rule.pattern.length > best.len)) {
      best = { len: rule.pattern.length, tier: rule.tier };
    }
  }
  return best ? best.tier : ModelCapabilityTier.BASIC;
}

/** Returns a fresh copy of the constraints for a given tier. */
export function getTemplateConstraints(tier: ModelCapabilityTier): TemplateConstraints {
  switch (tier) {
    case ModelCapabilityTier.FULL:
      return { ...FULL_CONSTRAINTS };
    case ModelCapabilityTier.STANDARD:
      return { ...STANDARD_CONSTRAINTS };
    case ModelCapabilityTier.BASIC:
    default:
      return { ...BASIC_CONSTRAINTS };
  }
}

/**
 * Formats constraints as natural-language instructions to append to a system prompt.
 * Returns an empty string if constraints is null so callers can append unconditionally.
 */
export function formatConstraintsForPrompt(constraints: TemplateConstraints | null): string {
  if (!constraints) return '';

  const lines: string[] = [
    '',
    'GENERATION CONSTRAINTS (model capability profile):',
    `- Use at most ${constraints.maxThirdPartyImportsPerFile} third-party imports per file.`,
    `- Define at most ${constraints.maxComponentsPerFile} components per file.`,
  ];
  if (constraints.preferInlineStyles) {
    lines.push('- Prefer Tailwind utility classes and inline style props over additional UI libraries.');
  }
  if (constraints.avoidComplexAnimations) {
    lines.push('- Avoid heavy animation libraries (framer-motion, gsap, three.js). Use CSS transitions or simple keyframes.');
  }
  lines.push('- If a feature would exceed these limits, prefer a simpler self-contained implementation.');
  return lines.join('\n');
}

/** For diagnostic / debug surfaces. */
export function describeTier(tier: ModelCapabilityTier): string {
  switch (tier) {
    case ModelCapabilityTier.FULL:     return 'Full — flagship coding model, no constraints applied';
    case ModelCapabilityTier.STANDARD: return 'Standard — mid-size coding model, moderate import budget';
    case ModelCapabilityTier.BASIC:    return 'Basic — small / general model, tight import budget';
  }
}
