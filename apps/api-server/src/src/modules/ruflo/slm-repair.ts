import { isSLMAvailable, runSLM } from '../slm-inference-engine.js';
import { logEvent } from './observability-sink.js';

export const MAX_PATCH_LIMIT = 4096;

export async function repairFileWithSlm(file: string, content: string, errorMsg: string): Promise<string> {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  if (sizeBytes > MAX_PATCH_LIMIT) {
    logEvent({
      type: 'patch_oversized',
      agent: 'Debugger',
      file,
      size: sizeBytes,
      limit: MAX_PATCH_LIMIT
    });
    throw new Error(`Patch size ${sizeBytes} exceeds limit of ${MAX_PATCH_LIMIT} bytes. Falling back.`);
  }

  if (!isSLMAvailable()) {
    throw new Error('SLM is not available for repair.');
  }

  // Attempt to call SLM with registered stage template (e.g. 'quality' or a new one, let's use quality or fallback)
  try {
    const response = await runSLM<{ repairedContent: string }>('quality', {
      file,
      content,
      error: errorMsg
    });

    if (response.success && response.data?.repairedContent) {
      return response.data.repairedContent;
    }
  } catch (err) {
    // Non-fatal, fallback will catch
  }

  throw new Error('SLM repair failed.');
}
