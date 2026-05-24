/**
 * Telemetry sinks introspection (Initiative C).
 *   GET  /api/telemetry/sinks       list registered sinks + status
 */
import { Router } from 'express';
import { getRegisteredSinks } from '../src/modules/telemetry/sinks.js';

const router = Router();

router.get('/telemetry/sinks', (_req, res) => {
  res.json({ sinks: getRegisteredSinks() });
});

export default router;
