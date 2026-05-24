/**
 * Plugin registry introspection (Initiative E).
 *   GET /api/plugins         list registered plugins + last audit
 */

import { Router } from 'express';
import { listPlugins } from '../src/modules/plugins/loader.js';

const router = Router();

router.get('/plugins', (_req, res) => {
  res.json({
    plugins: listPlugins().map((p) => ({
      id: p.id,
      name: p.name,
      hook: p.hook,
      priority: p.priority ?? 100,
    })),
  });
});

export default router;
