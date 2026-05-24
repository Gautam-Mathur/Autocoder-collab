/**
 * Subprocess Runner — executes build/compile commands in a temp directory
 *
 * Writes generated files to a tmp dir, runs the specified command,
 * captures stdout/stderr, and returns structured results.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import type { GeneratedFile } from '../pipeline-orchestrator.js';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const WORKSPACE_BIN = join(WORKSPACE_ROOT, 'node_modules', '.bin');

export interface SubprocessOptions {
  fileFilter?: (f: GeneratedFile) => boolean;
  entryPoint?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  workdir: string;
}

async function writeFilesToDir(
  dir: string,
  files: GeneratedFile[],
  filter?: (f: GeneratedFile) => boolean
): Promise<void> {
  const toWrite = filter ? files.filter(filter) : files;
  for (const file of toWrite) {
    const fullPath = join(dir, file.path);
    await fs.mkdir(dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content, 'utf8');
  }
}

export async function runSubprocess(
  command: string,
  args: string[],
  files: GeneratedFile[],
  options: SubprocessOptions = {}
): Promise<SubprocessResult> {
  const { fileFilter, timeoutMs = 30_000, env = {} } = options;

  // Create isolated temp directory
  const workdir = join(tmpdir(), `autocoder-sandbox-${randomBytes(4).toString('hex')}`);
  await fs.mkdir(workdir, { recursive: true });

  const start = Date.now();

  try {
    await writeFilesToDir(workdir, files, fileFilter);

    // Write minimal tsconfig if we're running tsc and no tsconfig present
    if (command === 'npx' && args[0] === 'tsc') {
      const tsconfigPath = join(workdir, 'tsconfig.json');
      try { await fs.access(tsconfigPath); } catch {
        await fs.writeFile(tsconfigPath, JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            noEmit: true,
            jsx: 'react-jsx',
            skipLibCheck: true,
          },
          include: ['**/*.ts', '**/*.tsx'],
        }, null, 2));
      }
    }

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve) => {
        let stdout = '';
        let stderr = '';

        let resolvedCommand = command;
        let resolvedArgs = args;
        if (command === 'npx' && args[0] === 'tsc') {
          resolvedCommand = join(WORKSPACE_BIN, 'tsc');
          resolvedArgs = args.slice(1);
        }

        const proc = spawn(resolvedCommand, resolvedArgs, {
          cwd: workdir,
          env: { ...process.env, ...env, PATH: `${WORKSPACE_BIN}:${process.env.PATH}` },
          shell: false,
        });

        proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        const timer = setTimeout(() => {
          proc.kill('SIGTERM');
          resolve({ stdout, stderr: stderr + '\n[TIMEOUT]', exitCode: 124 });
        }, timeoutMs);

        proc.on('close', (code) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          resolve({ stdout, stderr: err.message, exitCode: 1 });
        });
      }
    );

    return {
      ...result,
      durationMs: Date.now() - start,
      workdir,
    };
  } catch (e: unknown) {
    return {
      stdout: '',
      stderr: String(e),
      exitCode: 1,
      durationMs: Date.now() - start,
      workdir,
    };
  } finally {
    // Clean up temp dir asynchronously (don't block)
    fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
