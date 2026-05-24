/**
 * MCP HTTP route — exposes the JSON-RPC 2.0 dispatcher at `/api/mcp/rpc`.
 *
 * MCP clients (Claude Desktop, Cursor, etc.) can connect by configuring an
 * HTTP endpoint pointing here. Also exposes:
 *   - GET  /api/mcp/info          server info + capabilities
 *   - GET  /api/mcp/tools         tool catalogue (debug/UI)
 */

import { Router } from 'express';
import { dispatch, getServerInfo } from '../mcp/server.js';
import { getAllTools } from '../mcp/tools.js';

const router = Router();

router.get('/mcp/info', (_req, res) => {
  res.json({
    server: getServerInfo(),
    transport: 'http+jsonrpc',
    endpoint: '/api/mcp/rpc',
  });
});

router.get('/mcp/tools', (_req, res) => {
  res.json({
    tools: Array.from(getAllTools().values()).map((t) => t.def),
  });
});

router.post('/mcp/rpc', async (req, res) => {
  try {
    const result = await dispatch(req.body);
    if (result === null) {
      res.status(204).end();
      return;
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal error', data: err?.message || String(err) },
    });
  }
});

export default router;
