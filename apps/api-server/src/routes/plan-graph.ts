/**
 * Plan-as-Graph endpoint (Initiative D).
 *
 * GET /api/conversations/:id/plan/graph
 *   Returns `{nodes, edges, stats}` derived from the conversation's stored
 *   plan. 404 if no plan has been built yet for the conversation.
 *
 * POST /api/plan/graph
 *   Body: `{plan}` — render any plan ad-hoc (used by dry-run preview).
 */

import { Router } from 'express';
import { buildPlanGraph } from '../src/modules/plan-graph/builder.js';
import { getConversationPlan } from './conversations-store.js';

const router = Router();

router.get('/conversations/:id/plan/graph', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: 'Invalid conversation id' });
    return;
  }
  const plan = getConversationPlan(id);
  if (!plan) {
    res.status(404).json({ error: 'No plan available for this conversation yet' });
    return;
  }
  res.json(buildPlanGraph(plan));
});

router.post('/plan/graph', (req, res) => {
  const plan = req.body?.plan;
  if (!plan || typeof plan !== 'object') {
    res.status(400).json({ error: 'plan object required in body' });
    return;
  }
  res.json(buildPlanGraph(plan));
});

export default router;
