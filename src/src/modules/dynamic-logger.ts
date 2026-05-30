import { logger } from './logger.js';

/**
 * Safe serialization of function arguments/details to prevent circular reference crashes.
 */
function safeStringify(val: any): string {
  try {
    return JSON.stringify(val, (key, value) => {
      if (value === undefined) return undefined;
      if (value === null) return null;
      if (typeof value === 'object') {
        // Exclude huge contexts or legacy context objects to avoid log bloat
        if (key === 'legacyCtx' || key === 'ctx') {
          return '[Context Object]';
        }
        // Check for specific classes we don't want to expand fully
        if (value.constructor && value.constructor.name !== 'Object' && value.constructor.name !== 'Array') {
          return `[${value.constructor.name}]`;
        }
      }
      if (typeof value === 'function') {
        return `[Function: ${value.name || 'anonymous'}]`;
      }
      return value;
    });
  } catch {
    return '[Unserializable/Circular Object]';
  }
}

/**
 * Logs function entry with arguments.
 */
export function logCall(category: string, funcName: string, args: any[]): void {
  const serialized = safeStringify(args);
  logger.debug(category, `→ ENTER "${funcName}" with args: ${serialized.slice(0, 1000)}`);
}

/**
 * Logs function exit with result and duration.
 */
export function logReturn(category: string, funcName: string, durationMs: number, result: any): void {
  const serialized = safeStringify(result);
  logger.debug(category, `← EXIT "${funcName}" in ${durationMs}ms with result: ${serialized.slice(0, 1000)}`);
}

/**
 * Logs function exceptions with error details and duration.
 */
export function logError(category: string, funcName: string, durationMs: number, err: any): void {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error(category, `💥 ERROR in "${funcName}" after ${durationMs}ms: ${msg}`, { stack });
}
