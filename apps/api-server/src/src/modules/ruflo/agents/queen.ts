/**
 * QUEEN — Intent interpreter
 * Interprets raw prompts into TaskSpec.
 *
 * Reads:  raw prompt
 * Writes: TaskSpec (mem.queen.taskSpec)
 */

import { runSLM, registerStageTemplate } from '../../slm-inference-engine.js';
import type { TaskSpec } from '../types.js';

registerStageTemplate({
  stage: 'Queen',
  systemPrompt: `You are the Queen Orchestrator agent in a multi-agent system.
Your job is to interpret raw user requirements into a structured task specification.
You must determine:
1. The domain (e.g. ecommerce, hospitality, productivity, etc.)
2. The primary user type (e.g. customer, admin, team member)
3. The core flow (how users navigate the app)
4. A list of must-have features (at least 3-5 specific features)
5. Explicit non-goals (what is out of scope)
6. Customized tasks for each agent in the pipeline (Planner, Architect, System, Designer, Coder, Tester, Debugger, Security, Reviewer, Refiner) on what they should focus on based on the request. Make sure these instructions are clear and specific to the request.`,
  userPromptBuilder: (context: Record<string, any>) => `Interpret this user request:\n\n"${context.prompt}"`,
  outputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string' },
      userType: { type: 'string' },
      coreFlow: { type: 'string' },
      mustHaveFeatures: { type: 'array', items: { type: 'string' } },
      explicitNonGoals: { type: 'array', items: { type: 'string' } },
      agentTasks: {
        type: 'object',
        properties: {
          Planner: { type: 'string' },
          Architect: { type: 'string' },
          System: { type: 'string' },
          Designer: { type: 'string' },
          Coder: { type: 'string' },
          Tester: { type: 'string' },
          Debugger: { type: 'string' },
          Security: { type: 'string' },
          Reviewer: { type: 'string' },
          Refiner: { type: 'string' }
        },
        required: ['Planner', 'Architect', 'System', 'Designer', 'Coder', 'Tester', 'Debugger', 'Security', 'Reviewer', 'Refiner']
      }
    },
    required: ['domain', 'userType', 'coreFlow', 'mustHaveFeatures', 'explicitNonGoals', 'agentTasks']
  },
  maxTokens: 1024,
  temperature: 0.2
});

export async function runQueen(prompt: string, _legacyCtx?: any): Promise<TaskSpec> {
  const slmResult = await runSLM<TaskSpec>('Queen', { prompt });
  if (slmResult.success && slmResult.data) {
    return slmResult.data;
  }

  // Standalone fallback (RuFlo without upstream understanding).
  const text = (prompt || '').toLowerCase();
  const domain = detectDomain(text);
  const userType = detectUserType(text);
  const coreFlow = extractCoreFlow(text);
  const mustHaveFeatures = extractFeatures(text);
  const explicitNonGoals = extractNonGoals(text);

  const agentTasks: Record<string, string> = {
    Planner: `Create a detailed feature plan for the ${domain} application catering to ${userType}.`,
    Architect: `Plan modules and file dependencies for ${domain} application core flow: ${coreFlow}.`,
    System: `Define logical models and API endpoints for features: ${mustHaveFeatures.join(', ')}.`,
    Designer: `Establish design tokens and UI components.`,
    Coder: `Generate source code files.`,
    Tester: `Author tests.`,
    Debugger: `Fix errors.`,
    Security: `Audit security.`,
    Reviewer: `Rate quality.`,
    Refiner: `Polish and optimize.`
  };

  return {
    domain,
    userType,
    coreFlow,
    mustHaveFeatures: mustHaveFeatures.length > 0 ? mustHaveFeatures : ['main view', 'list items', 'create item'],
    explicitNonGoals,
    agentTasks,
  };
}

const DOMAIN_KEYWORDS: Array<{ domain: string; keys: string[] }> = [
  { domain: 'hospitality',  keys: ['restaurant', 'reservation', 'booking', 'hotel', 'menu'] },
  { domain: 'ecommerce',    keys: ['shop', 'store', 'cart', 'checkout', 'product', 'ecommerce'] },
  { domain: 'productivity', keys: ['todo', 'task', 'kanban', 'project management', 'note'] },
  { domain: 'social',       keys: ['chat', 'message', 'post', 'feed', 'social', 'follow'] },
  { domain: 'finance',      keys: ['invoice', 'payment', 'wallet', 'budget', 'expense'] },
  { domain: 'education',    keys: ['course', 'lesson', 'quiz', 'school', 'student', 'learn'] },
  { domain: 'health',       keys: ['fitness', 'workout', 'health', 'meal', 'doctor'] },
  { domain: 'media',        keys: ['video', 'photo', 'gallery', 'music', 'podcast'] },
];

function detectDomain(text: string): string {
  for (const { domain, keys } of DOMAIN_KEYWORDS) if (keys.some((k) => text.includes(k))) return domain;
  return 'general';
}
function detectUserType(text: string): string {
  if (text.includes('admin')) return 'admin + end user';
  if (text.includes('team')) return 'team member';
  if (text.includes('customer') || text.includes('user')) return 'customer';
  return 'end user';
}
function extractCoreFlow(text: string): string {
  const verbs = ['create', 'manage', 'view', 'browse', 'book', 'order', 'track', 'send', 'plan'];
  const found = verbs.filter((v) => text.includes(v));
  return found.length === 0 ? 'user interacts with the app' : `user can ${found.slice(0, 3).join(' and ')}`;
}
function extractFeatures(text: string): string[] {
  const candidates: Array<[string, string]> = [
    ['booking', 'booking flow'], ['reservation', 'reservation system'], ['cart', 'shopping cart'],
    ['checkout', 'checkout'], ['login', 'authentication'], ['signup', 'authentication'],
    ['auth', 'authentication'], ['dashboard', 'dashboard'], ['admin', 'admin panel'],
    ['search', 'search'], ['filter', 'filtering'], ['profile', 'user profile'],
    ['settings', 'settings page'], ['notification', 'notifications'], ['chat', 'chat'],
    ['comment', 'comments'], ['review', 'reviews'], ['payment', 'payments'], ['calendar', 'calendar'],
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [k, label] of candidates) {
    if (text.toLowerCase().includes(k) && !seen.has(label)) { out.push(label); seen.add(label); }
  }
  return out.slice(0, 8);
}
function extractNonGoals(text: string): string[] {
  const out: string[] = [];
  if (text.includes('no payment') || text.includes('without payment')) out.push('payment processing');
  if (text.includes('no auth') || text.includes('no login')) out.push('authentication');
  if (text.includes('no admin')) out.push('admin panel');
  return out;
}
