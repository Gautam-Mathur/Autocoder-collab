/**
 * Re-export the in-memory conversation store accessors so cross-route
 * modules (plan-graph, dry-run resume) don't have to import the full
 * router module just to read state.
 */
export {
  getConversation,
  getConversationFiles,
  getConversationPlanData as getConversationPlan,
  getConversationUnderstanding,
  setConversationFiles,
  updateConversation,
} from './conversations.js';
