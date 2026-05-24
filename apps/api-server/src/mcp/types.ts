/**
 * Initiative A — MCP (Model Context Protocol) types
 *
 * MCP is JSON-RPC 2.0 over HTTP/stdio. We implement the HTTP transport
 * directly so AutoCoder can be driven by Claude Desktop, Cursor, and any
 * other MCP-compatible client without the official SDK.
 *
 * Reference: https://modelcontextprotocol.io/
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export interface McpToolDef {
  name: string;
  description: string;
  /** JSON Schema describing the input. */
  inputSchema: Record<string, unknown>;
}

export interface McpToolHandler {
  def: McpToolDef;
  call: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface McpServerInfo {
  name: string;
  version: string;
  capabilities: {
    tools: { listChanged: boolean };
  };
}
