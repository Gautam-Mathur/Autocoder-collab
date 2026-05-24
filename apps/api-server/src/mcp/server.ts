/**
 * MCP HTTP transport — JSON-RPC 2.0 dispatcher.
 *
 * Methods supported (per MCP spec):
 *   - `initialize`             handshake + capabilities
 *   - `tools/list`             list available tools
 *   - `tools/call`             invoke a tool by name with args
 *   - `ping`                   health probe
 *
 * The dispatcher is transport-agnostic: `dispatch(req)` takes a parsed JSON
 * payload (single or batch) and returns the response. The Express route in
 * `routes/mcp.ts` wraps this with HTTP plumbing.
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpServerInfo,
  McpToolHandler,
} from './types.js';
import { getAllTools } from './tools.js';
import { emit as emitTelemetry } from '../src/modules/telemetry/sinks.js';

const SERVER_INFO: McpServerInfo = {
  name: 'autocoder-mcp',
  version: '0.1.0',
  capabilities: { tools: { listChanged: false } },
};

const PROTOCOL_VERSION = '2024-11-05';

function ok(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function err(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

async function callTool(
  tools: Map<string, McpToolHandler>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const handler = tools.get(name);
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  const start = Date.now();
  try {
    const result = await Promise.resolve(handler.call(args || {}));
    emitTelemetry({
      kind: 'mcp.tool.call',
      timestamp: Date.now(),
      payload: { tool: name, durationMs: Date.now() - start, ok: true },
    });
    // MCP tools return content arrays.
    if (
      typeof result === 'object' &&
      result !== null &&
      Array.isArray((result as any).content)
    ) {
      return result;
    }
    return {
      content: [
        { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) },
      ],
    };
  } catch (e) {
    emitTelemetry({
      kind: 'mcp.tool.call',
      timestamp: Date.now(),
      payload: { tool: name, durationMs: Date.now() - start, ok: false, error: String(e) },
    });
    return {
      isError: true,
      content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
    };
  }
}

export async function dispatchSingle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return err(req?.id ?? null, -32600, 'Invalid Request');
  }
  const tools = getAllTools();

  switch (req.method) {
    case 'initialize':
      return ok(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: SERVER_INFO.capabilities,
      });

    case 'ping':
      return ok(req.id, {});

    case 'tools/list':
      return ok(req.id, {
        tools: Array.from(tools.values()).map((t) => t.def),
      });

    case 'tools/call': {
      const params = (req.params || {}) as { name?: string; arguments?: Record<string, unknown> };
      if (!params.name) return err(req.id, -32602, 'Missing tool name');
      try {
        const result = await callTool(tools, params.name, params.arguments || {});
        return ok(req.id, result);
      } catch (e) {
        return err(req.id, -32000, e instanceof Error ? e.message : String(e));
      }
    }

    case 'notifications/initialized':
      // notification — no response.
      return null;

    default:
      return err(req.id, -32601, `Method not found: ${req.method}`);
  }
}

export async function dispatch(payload: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    const out: JsonRpcResponse[] = [];
    for (const r of payload) {
      const res = await dispatchSingle(r as JsonRpcRequest);
      if (res) out.push(res);
    }
    return out.length > 0 ? out : null;
  }
  return dispatchSingle(payload as JsonRpcRequest);
}

export function getServerInfo(): McpServerInfo {
  return SERVER_INFO;
}
