/**
 * Task Graph Executor — runs a TaskGraph layer by layer
 *
 * For each layer:
 *   1. Emit a ThinkingStep for the batch
 *   2. Call the provided executor function for each task in the layer
 *   3. Collect outputs
 *   4. Move to next layer only when all tasks in the current layer are done
 *
 * Crucially, this makes the LLM aware of exactly which files to generate
 * at each step, which dramatically reduces context confusion.
 */

import type { TaskGraph, GenerationTask } from './task-graph-builder.js';
import type { GeneratedFile } from '../pipeline-orchestrator.js';
import type { ThinkingStep } from '../pipeline-orchestrator.js';

export type TaskExecutorFn = (
  task: GenerationTask,
  previousFiles: GeneratedFile[]
) => Promise<GeneratedFile[]>;

export interface ExecutionResult {
  files: GeneratedFile[];
  completedTasks: string[];
  failedTasks: string[];
  layersCompleted: number;
}

export async function executeTaskGraph(
  graph: TaskGraph,
  executorFn: TaskExecutorFn,
  onStep: (step: ThinkingStep) => void,
  signal?: AbortSignal
): Promise<ExecutionResult> {
  const files: GeneratedFile[] = [];
  const completedTasks: string[] = [];
  const failedTasks: string[] = [];
  let layersCompleted = 0;

  for (let layerIdx = 0; layerIdx < graph.layers.length; layerIdx++) {
    if (signal?.aborted) break;

    const layer = graph.layers[layerIdx];
    if (layer.length === 0) continue;

    const labels = layer.map(t => t.label).join(', ');
    onStep({
      phase: 'generate',
      label: `Generating layer ${layerIdx + 1} of ${graph.layers.length}|||${labels}`,
      detail: `Parallel batch: ${layer.map(t => t.targetPath).join(', ')}`,
      timestamp: Date.now(),
    });

    // Run all tasks in this layer in parallel
    const layerResults = await Promise.allSettled(
      layer.map(task => executorFn(task, files))
    );

    for (let i = 0; i < layer.length; i++) {
      const task = layer[i];
      const result = layerResults[i];

      if (result.status === 'fulfilled') {
        files.push(...result.value);
        completedTasks.push(task.id);
      } else {
        console.warn(`[TaskGraphExecutor] Task "${task.id}" failed:`, result.reason);
        failedTasks.push(task.id);
        // Insert a placeholder so downstream layers don't break
        files.push({
          path: task.targetPath,
          content: `// Generation failed for ${task.label}: ${result.reason}`,
          language: task.targetPath.endsWith('.py') ? 'python'
            : task.targetPath.endsWith('.ts') || task.targetPath.endsWith('.tsx') ? 'typescript'
            : 'text',
        });
      }
    }

    layersCompleted++;
  }

  onStep({
    phase: 'generate',
    label: `Task graph complete|||${completedTasks.length} tasks done, ${failedTasks.length} failed`,
    detail: `${files.length} files generated across ${layersCompleted} layers`,
    timestamp: Date.now(),
  });

  return { files, completedTasks, failedTasks, layersCompleted };
}
