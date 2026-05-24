/**
 * Enhancement Patch contract (Task #17).
 *
 * Post-Stage-11 mutators (quality, deep-quality, hardening, anti-pattern,
 * SLM enhancers, …) used to mutate `ctx.files` directly. Fix 5 routed those
 * writes through a single-writer queue so the last-writer wins per file.
 * That solved the "two stages clobber each other" problem but did not stop
 * stages from inserting JSX/imports that referenced packages no one ever
 * declared in `package.json` (e.g. a hardening pass adding `framer-motion`,
 * a quality pass wrapping the app in `<ThemeProvider>` with no provider
 * package, etc.).
 *
 * `EnhancementPatch` is the structured replacement: a stage describes ALL
 * the implications of its mutation up front — file changes, new package
 * dependencies, new top-level imports, and any provider components that
 * must wrap the app root. `applyEnhancementPatches` then merges patches
 * deterministically, rejects patches whose imports reference packages they
 * did not declare, merges declared dependencies into `package.json`,
 * de-duplicates provider wrappers at the app root, and finally feeds the
 * file changes through the existing single-writer queue (`pendingDiffs`)
 * that Stage 15 / 16 already drain.
 *
 * The applier is structurally typed so this module does not import the
 * orchestrator (which would create a runtime cycle).
 */

interface GeneratedFile {
  path: string;
  content: string;
  language: string;
}

interface FileDiff {
  file: string;
  content: string;
  source: string;
}

interface ThinkingStep {
  phase: string;
  label: string;
  detail?: string;
  timestamp: number;
}

/**
 * Minimal slice of PipelineContext that the applier needs. Defined locally
 * to avoid importing pipeline-orchestrator (and creating a cycle).
 */
export interface EnhancementApplyContext {
  files: GeneratedFile[];
  pendingDiffs?: FileDiff[];
  writeLock?: boolean;
  thinkingSteps: ThinkingStep[];
  onStep?: (step: ThinkingStep) => void;
}

export interface PatchedFile {
  path: string;
  /** Full new file contents — replaces whatever the file currently has. */
  content: string;
  language?: string;
}

/**
 * Provider component that must wrap the app root. The applier inserts the
 * import + wrapper in `src/main.tsx` (or `src/App.tsx` as fallback) exactly
 * once per `component` name, even if multiple patches request it.
 */
export interface RequiredProvider {
  /** JSX component identifier, e.g. `ThemeProvider`. */
  component: string;
  /** Full import statement, e.g. `import { ThemeProvider } from 'next-themes';`. */
  importStatement: string;
  /** Package the provider lives in — must be declared in `addedDependencies` or already present. */
  package: string;
  /** Optional props blob, e.g. `attribute="class" defaultTheme="system"`. */
  props?: string;
}

/**
 * Top-level import that a patch needs to land in a specific file. Used by
 * the applier to verify every referenced package was declared.
 */
export interface AddedImport {
  file: string;
  importStatement: string;
  /** Bare package names referenced by this import, e.g. `['framer-motion']`. */
  packages: string[];
}

export interface EnhancementPatch {
  /** Emitting stage id, used for the audit trail (`source` on FileDiff). */
  source: string;
  /** Human-readable reason — surfaced in thinking steps when rejected. */
  reason: string;
  /** Full file replacements to enqueue. */
  codeChanges?: PatchedFile[];
  /** Runtime deps to merge into `package.json` `dependencies`. */
  addedDependencies?: Record<string, string>;
  /** Dev deps to merge into `package.json` `devDependencies`. */
  addedDevDependencies?: Record<string, string>;
  /** Top-level imports the patch implies (validated against deps). */
  addedImports?: AddedImport[];
  /** Provider wrappers at the app root, deduped by `component`. */
  requiredProviders?: RequiredProvider[];
}

export interface ApplyResult {
  appliedPatches: number;
  rejectedPatches: number;
  rejections: Array<{ source: string; reason: string }>;
  filesQueued: number;
  packagesAdded: string[];
  providersWrapped: string[];
}

/**
 * Optional generation-budget the applier enforces when merging deps. Mirrors
 * the shape returned by `getBudget(mode)` in `generation-mode.ts` — we only
 * read the dep cap so the structural type stays loose.
 */
export interface ApplyBudget {
  maxRuntimeDeps: number;
}

function emit(ctx: EnhancementApplyContext, phase: string, label: string, detail?: string): void {
  const step: ThinkingStep = { phase, label, detail, timestamp: Date.now() };
  ctx.thinkingSteps.push(step);
  if (ctx.onStep) ctx.onStep(step);
}

function readPackageJson(ctx: EnhancementApplyContext): {
  file: GeneratedFile | null;
  parsed: Record<string, any> | null;
} {
  const file = ctx.files.find(f => f.path === 'package.json' || f.path.endsWith('/package.json')) ?? null;
  if (!file) return { file: null, parsed: null };
  try {
    return { file, parsed: JSON.parse(file.content) };
  } catch {
    return { file, parsed: null };
  }
}

function declaredPackageSet(parsed: Record<string, any> | null): Set<string> {
  const set = new Set<string>();
  if (!parsed) return set;
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const block = parsed[key];
    if (block && typeof block === 'object') {
      for (const name of Object.keys(block)) set.add(name);
    }
  }
  return set;
}

/**
 * Mirror of `enqueueFileSnapshot` in pipeline-orchestrator. Re-implemented
 * here so this module stays cycle-free; the wire format (`FileDiff`) is
 * identical so Stage 15 / 16 drain it the same way.
 *
 * Conflict audit: when a later patch enqueues a diff for a file that an
 * earlier patch in the same `applyEnhancementPatches` call already enqueued,
 * we collect the overwritten source so the caller can emit ONE consolidated
 * audit step ("file X — winner: Y, overwrote: A, B"). Last-writer wins per
 * file, matching Fix 5 semantics.
 */
function enqueueDiffs(
  ctx: EnhancementApplyContext,
  files: PatchedFile[],
  source: string,
  conflicts: Map<string, { winner: string; overwritten: string[] }>,
): number {
  if (!ctx.pendingDiffs) ctx.pendingDiffs = [];
  const currentByPath = new Map(ctx.files.map(f => [f.path, f.content]));
  let queued = 0;
  for (const f of files) {
    const cur = currentByPath.get(f.path);
    if (cur === undefined || cur !== f.content) {
      // If a prior pending diff already targets this file, record the
      // overwrite for the consolidated audit log.
      const priorIdx = ctx.pendingDiffs.findIndex(d => d.file === f.path);
      if (priorIdx >= 0) {
        const prior = ctx.pendingDiffs[priorIdx];
        const entry = conflicts.get(f.path) ?? { winner: source, overwritten: [] };
        entry.winner = source;
        if (!entry.overwritten.includes(prior.source)) entry.overwritten.push(prior.source);
        conflicts.set(f.path, entry);
      }
      ctx.pendingDiffs.push({ file: f.path, content: f.content, source });
      queued++;
    }
  }
  return queued;
}

/**
 * Direct apply path used when `writeLock` is false (e.g. fallback path in
 * conversation-phase-handler). Mirrors the queue semantics so the audit
 * surface is identical.
 */
function applyDirect(ctx: EnhancementApplyContext, files: PatchedFile[]): number {
  let applied = 0;
  for (const f of files) {
    const idx = ctx.files.findIndex(x => x.path === f.path);
    if (idx >= 0) {
      if (ctx.files[idx].content !== f.content) {
        ctx.files[idx] = { ...ctx.files[idx], content: f.content };
        applied++;
      }
    } else {
      ctx.files.push({ path: f.path, content: f.content, language: f.language ?? f.path.split('.').pop() ?? '' });
      applied++;
    }
  }
  return applied;
}

/**
 * Compute a new package.json content with merged deps. NON-MUTATING — does
 * not touch `pkgFile.content`, so the file change can flow through the
 * single-writer queue against the pre-merge baseline (the diff actually
 * shows up). Returns null `newContent` when nothing was added.
 */
function planPackageJsonMerge(
  ctx: EnhancementApplyContext,
  toAdd: Record<string, string>,
  toAddDev: Record<string, string>,
  budget?: ApplyBudget,
): { added: string[]; pkgFile: GeneratedFile | null; budgetExceeded: string[]; newContent: string | null } {
  const added: string[] = [];
  const budgetExceeded: string[] = [];
  const { file: pkgFile, parsed } = readPackageJson(ctx);
  if (!pkgFile || !parsed) return { added, pkgFile: null, budgetExceeded, newContent: null };

  // Deep copy so we never mutate the file in place.
  const next: any = JSON.parse(JSON.stringify(parsed));
  next.dependencies = next.dependencies && typeof next.dependencies === 'object' ? next.dependencies : {};
  next.devDependencies = next.devDependencies && typeof next.devDependencies === 'object' ? next.devDependencies : {};

  // Enforce runtime-dep budget. Dev deps don't count against `maxRuntimeDeps`
  // (they're build tooling, not shipped runtime). Existing runtime deps are
  // counted as the baseline; the budget caps total runtime deps after merge.
  const cap = budget && Number.isFinite(budget.maxRuntimeDeps) ? budget.maxRuntimeDeps : Number.POSITIVE_INFINITY;
  let runtimeCount = Object.keys(next.dependencies).length;

  for (const [name, version] of Object.entries(toAdd)) {
    if (next.dependencies[name] || next.devDependencies[name]) continue;
    if (runtimeCount >= cap) {
      budgetExceeded.push(name);
      continue;
    }
    next.dependencies[name] = version;
    added.push(name);
    runtimeCount++;
  }
  for (const [name, version] of Object.entries(toAddDev)) {
    if (next.dependencies[name] || next.devDependencies[name]) continue;
    next.devDependencies[name] = version;
    added.push(name);
  }
  const newContent = added.length > 0 ? JSON.stringify(next, null, 2) : null;
  return { added, pkgFile, budgetExceeded, newContent };
}

/** Find the canonical app-root file the applier should wrap providers around. */
function findAppRoot(ctx: EnhancementApplyContext): GeneratedFile | null {
  const candidates = ['src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/App.tsx', 'src/App.jsx'];
  for (const p of candidates) {
    const f = ctx.files.find(x => x.path === p);
    if (f) return f;
  }
  return null;
}

/**
 * Compute the new app-root content with providers wrapped. NON-MUTATING —
 * does not write back to `root.content`, so the change can flow through the
 * single-writer queue. Returns null `newContent` when nothing was wrapped.
 */
function planProviderWrap(
  ctx: EnhancementApplyContext,
  providers: RequiredProvider[],
): { wrapped: string[]; rootFile: GeneratedFile | null; newContent: string | null } {
  const wrapped: string[] = [];
  if (providers.length === 0) return { wrapped, rootFile: null, newContent: null };

  const root = findAppRoot(ctx);
  if (!root) return { wrapped, rootFile: null, newContent: null };

  let content = root.content;
  // Dedupe by component name. First-writer wins for identical component
  // names — multiple stages requesting `<ThemeProvider>` collapse to one.
  const seen = new Set<string>();
  const unique = providers.filter(p => {
    if (seen.has(p.component)) return false;
    seen.add(p.component);
    return true;
  });

  for (const p of unique) {
    // Skip if the provider is already wrapping something — naive check by
    // component name. Avoids double-wrapping when the generator already did
    // it natively.
    if (new RegExp(`<\\s*${p.component}\\b`).test(content)) {
      continue;
    }
    // Insert import at top if missing.
    if (!content.includes(p.importStatement.trim())) {
      const lines = content.split('\n');
      let lastImportIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*import\b/.test(lines[i])) lastImportIdx = i;
        else if (lastImportIdx >= 0 && lines[i].trim() === '') break;
        else if (lastImportIdx >= 0) break;
      }
      const insertAt = lastImportIdx + 1;
      lines.splice(insertAt, 0, p.importStatement.trim());
      content = lines.join('\n');
    }
    // Wrap. Look for a renderable child — the most common React entry shapes
    // are `<App />`, `<RouterProvider .../>`, or `createRoot(...).render(...)`.
    const propsBlob = p.props ? ` ${p.props}` : '';
    const wrapRe = /<App\s*\/?\s*>(?:\s*<\/App>)?/;
    if (wrapRe.test(content)) {
      content = content.replace(wrapRe, (match) =>
        `<${p.component}${propsBlob}>\n      ${match}\n    </${p.component}>`);
      wrapped.push(p.component);
      continue;
    }
    // Fallback: wrap inside the root render call.
    const renderRe = /(\.render\(\s*)([\s\S]+?)(\s*\)\s*;?\s*$)/m;
    if (renderRe.test(content)) {
      content = content.replace(renderRe, (_m, head, body, tail) =>
        `${head}<${p.component}${propsBlob}>${body}</${p.component}>${tail}`);
      wrapped.push(p.component);
    }
  }

  return { wrapped, rootFile: root, newContent: wrapped.length > 0 ? content : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Import extraction — used to detect undeclared packages from actual
// `codeChanges` content, not just the optional `addedImports` metadata. A
// patch that lands `import { motion } from 'framer-motion'` in a code change
// without declaring `framer-motion` in `addedDependencies` is rejected even
// if `addedImports` is empty.
// ─────────────────────────────────────────────────────────────────────────────

const IMPORT_RES: RegExp[] = [
  /^\s*import\s+[^'"]*?from\s+['"]([^'"]+)['"]/gm,    // import x from 'pkg'
  /^\s*import\s+['"]([^'"]+)['"]/gm,                   // import 'pkg'
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,           // require('pkg')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,            // dynamic import('pkg')
];

function extractBarePackagesFromCode(content: string): Set<string> {
  const out = new Set<string>();
  if (!content) return out;
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1];
      if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue;
      const root = spec.startsWith('@')
        ? spec.split('/').slice(0, 2).join('/')
        : spec.split('/')[0];
      if (root) out.add(root);
    }
  }
  return out;
}

/**
 * Validate that every bare-package import landed by this patch's
 * `codeChanges` is declared (by the patch or by the project). Catches
 * patches that forget to populate `addedImports` metadata. Returns null
 * when clean, or the rejection reason.
 */
function validateCodeChangeImports(
  patch: EnhancementPatch,
  alreadyDeclared: Set<string>,
  ctx: EnhancementApplyContext,
): string | null {
  if (!patch.codeChanges || patch.codeChanges.length === 0) return null;
  const declared = new Set<string>(alreadyDeclared);
  for (const name of Object.keys(patch.addedDependencies ?? {})) declared.add(name);
  for (const name of Object.keys(patch.addedDevDependencies ?? {})) declared.add(name);
  for (const prov of patch.requiredProviders ?? []) declared.add(prov.package);

  const beforeByPath = new Map(ctx.files.map(f => [f.path, f.content]));
  const undeclared = new Set<string>();
  for (const file of patch.codeChanges) {
    const before = beforeByPath.get(file.path) ?? '';
    const beforePkgs = extractBarePackagesFromCode(before);
    const afterPkgs = extractBarePackagesFromCode(file.content);
    for (const pkg of afterPkgs) {
      if (beforePkgs.has(pkg)) continue;        // already there pre-patch
      if (declared.has(pkg)) continue;           // declared by patch or project
      undeclared.add(pkg);
    }
  }
  if (undeclared.size === 0) return null;
  return `codeChanges import undeclared package(s): ${Array.from(undeclared).join(', ')}`;
}

/**
 * Validate that every package mentioned by `addedImports` is either
 * declared by the patch itself (in `addedDependencies` / `addedDevDependencies`)
 * or already present in `package.json`. Returns null on success or a
 * human-readable reason on failure.
 */
function validatePatchAgainstDeclaredDeps(
  patch: EnhancementPatch,
  alreadyDeclared: Set<string>,
): string | null {
  if (!patch.addedImports || patch.addedImports.length === 0) return null;
  const declared = new Set<string>(alreadyDeclared);
  for (const name of Object.keys(patch.addedDependencies ?? {})) declared.add(name);
  for (const name of Object.keys(patch.addedDevDependencies ?? {})) declared.add(name);
  // Providers also imply their package; treat them as declared too.
  for (const prov of patch.requiredProviders ?? []) declared.add(prov.package);

  const undeclared = new Set<string>();
  for (const imp of patch.addedImports) {
    for (const pkg of imp.packages) {
      // Allow relative imports / workspace internals (no bare-package check).
      if (pkg.startsWith('.') || pkg.startsWith('/')) continue;
      // Strip subpath: 'foo/bar' → 'foo', '@scope/foo/bar' → '@scope/foo'.
      const root = pkg.startsWith('@')
        ? pkg.split('/').slice(0, 2).join('/')
        : pkg.split('/')[0];
      if (!declared.has(root)) undeclared.add(root);
    }
  }
  if (undeclared.size === 0) return null;
  return `references undeclared package(s): ${Array.from(undeclared).join(', ')}`;
}

/**
 * Validate that every provider's package is declared (by this patch or the
 * project). Providers without a backing dep would compile-fail downstream.
 */
function validateProvidersAgainstDeclaredDeps(
  patch: EnhancementPatch,
  alreadyDeclared: Set<string>,
): string | null {
  if (!patch.requiredProviders || patch.requiredProviders.length === 0) return null;
  const declared = new Set<string>(alreadyDeclared);
  for (const name of Object.keys(patch.addedDependencies ?? {})) declared.add(name);
  for (const name of Object.keys(patch.addedDevDependencies ?? {})) declared.add(name);
  const missing = patch.requiredProviders
    .filter(p => !declared.has(p.package))
    .map(p => `${p.component} (${p.package})`);
  if (missing.length === 0) return null;
  return `provider(s) reference undeclared package(s): ${missing.join(', ')}`;
}

/**
 * Central applier. Patches are processed in the array's iteration order;
 * within a single applier call all package.json updates land first so
 * subsequent patches can see them as "already declared".
 *
 * Conflict rule: last-writer-per-file wins (mirrors `applyPendingDiffs`).
 * Rejected patches emit ONE consolidated thinking step listing the source +
 * reason — same shape as `slm-health-monitor` rejection logs.
 */
export function applyEnhancementPatches(
  ctx: EnhancementApplyContext,
  patches: EnhancementPatch[],
  opts?: { stagePhase?: string; budget?: ApplyBudget },
): ApplyResult {
  const result: ApplyResult = {
    appliedPatches: 0,
    rejectedPatches: 0,
    rejections: [],
    filesQueued: 0,
    packagesAdded: [],
    providersWrapped: [],
  };
  if (patches.length === 0) return result;

  const stagePhase = opts?.stagePhase ?? 'enhancement-patch';
  const budget = opts?.budget;

  // Patch-size cap. A plugin or stage that returns a 50MB diff would balloon
  // memory + serialization cost for downstream stages. Reject outsized patches
  // up-front. Override via env (chars across all codeChanges contents).
  const MAX_PATCH_SIZE_BYTES = Number(process.env.AUTOCODER_MAX_PATCH_BYTES) || 2_000_000;
  patches = patches.filter((p) => {
    const total = (p.codeChanges ?? []).reduce((acc, c) => acc + (c.content?.length ?? 0), 0);
    if (total > MAX_PATCH_SIZE_BYTES) {
      result.rejectedPatches++;
      result.rejections.push({
        source: p.source,
        reason: `${p.reason} — patch too large (${total} bytes > ${MAX_PATCH_SIZE_BYTES} cap)`,
      });
      return false;
    }
    return true;
  });
  if (patches.length === 0) return result;

  // Conflict audit map — populated by enqueueDiffs whenever a later patch
  // queues a diff for a file an earlier patch in this same call already
  // targeted. Last-writer wins (Fix 5 semantics); the overwritten sources
  // are surfaced via a single consolidated thinking step at the end.
  // Inside the loop we DO mutate ctx.files in-memory after each patch so
  // patch N+1 reads patch N's package.json / app-root state when computing
  // its own merge / wrap. Stage 15's drain re-applies from pendingDiffs
  // (idempotent).
  const conflicts = new Map<string, { winner: string; overwritten: string[] }>();

  for (const patch of patches) {
    // Re-read declared set per patch so earlier patches' deps count.
    const { parsed } = readPackageJson(ctx);
    const declared = declaredPackageSet(parsed);

    // Validation — three rejection gates:
    //   1. addedImports metadata vs declared deps
    //   2. requiredProviders package vs declared deps
    //   3. ACTUAL imports parsed from `codeChanges` content vs declared deps
    //      (catches patches that forget to populate `addedImports`)
    const importRejection = validatePatchAgainstDeclaredDeps(patch, declared);
    const providerRejection = validateProvidersAgainstDeclaredDeps(patch, declared);
    const codeImportRejection = validateCodeChangeImports(patch, declared, ctx);
    const rejectionReason = importRejection ?? providerRejection ?? codeImportRejection;
    if (rejectionReason) {
      result.rejectedPatches++;
      result.rejections.push({ source: patch.source, reason: `${patch.reason} — ${rejectionReason}` });
      continue;
    }

    // 1. Plan the package.json merge (non-mutating). Runtime-dep budget is
    //    enforced here — a patch that overshoots the cap is REJECTED as a
    //    whole so no partial state lands.
    const merge = planPackageJsonMerge(
      ctx,
      patch.addedDependencies ?? {},
      patch.addedDevDependencies ?? {},
      budget,
    );
    if (merge.budgetExceeded.length > 0) {
      result.rejectedPatches++;
      result.rejections.push({
        source: patch.source,
        reason: `${patch.reason} — would exceed runtime-dep budget (rejected: ${merge.budgetExceeded.join(', ')})`,
      });
      continue;
    }

    // 2. Plan the provider wrap (non-mutating).
    const wrap = planProviderWrap(ctx, patch.requiredProviders ?? []);

    // 3. Build the file-change set against the PRE-patch baseline so
    //    enqueueDiffs sees a real diff. Then enqueue (writeLock=true) or
    //    apply directly (writeLock=false). The single-writer queue is the
    //    only path that mutates ctx.files when locked.
    const filesForDiff: PatchedFile[] = [...(patch.codeChanges ?? [])];
    if (merge.pkgFile && merge.newContent !== null) {
      filesForDiff.push({ path: merge.pkgFile.path, content: merge.newContent });
    }
    if (wrap.rootFile && wrap.newContent !== null) {
      filesForDiff.push({ path: wrap.rootFile.path, content: wrap.newContent });
    }
    if (filesForDiff.length > 0) {
      if (ctx.writeLock) {
        result.filesQueued += enqueueDiffs(ctx, filesForDiff, patch.source, conflicts);
        // Mirror the change into ctx.files in-memory so the NEXT patch in
        // this same call reads the post-patch package.json / app-root state
        // when it computes its own merge / wrap. Stage 15's drain will
        // re-apply the same content from pendingDiffs (idempotent).
        applyDirect(ctx, filesForDiff);
      } else {
        result.filesQueued += applyDirect(ctx, filesForDiff);
      }
    }

    result.packagesAdded.push(...merge.added);
    result.providersWrapped.push(...wrap.wrapped);
    result.appliedPatches++;
  }

  // Consolidated conflict audit — emit ONE step listing every file where a
  // later patch overwrote an earlier patch within this call. Last-writer
  // wins (Fix 5 semantics) but the overwritten sources are no longer
  // silent.
  if (conflicts.size > 0) {
    const lines = Array.from(conflicts.entries())
      .slice(0, 5)
      .map(([file, info]) => `${file} — winner: ${info.winner}, overwrote: ${info.overwritten.join(', ')}`);
    const more = conflicts.size > 5 ? ` (+${conflicts.size - 5} more)` : '';
    emit(
      ctx,
      stagePhase,
      `Resolved ${conflicts.size} patch conflict${conflicts.size === 1 ? '' : 's'}|||Last-writer-wins applied`,
      `${lines.join(' | ')}${more}`,
    );
  }

  if (result.rejectedPatches > 0) {
    const sample = result.rejections.slice(0, 3).map(r => `${r.source}: ${r.reason}`).join(' | ');
    emit(
      ctx,
      stagePhase,
      `Some enhancements were skipped|||${result.rejectedPatches} patch(es) rejected by enhancement-patch applier`,
      `${result.rejectedPatches} patch(es) referenced packages they did not declare. ${sample}${result.rejections.length > 3 ? ` (+${result.rejections.length - 3} more)` : ''}`,
    );
  }
  if (result.packagesAdded.length > 0) {
    emit(
      ctx,
      stagePhase,
      `Added ${result.packagesAdded.length} package(s)|||Patch deps merged into package.json`,
      result.packagesAdded.join(', '),
    );
  }
  if (result.providersWrapped.length > 0) {
    emit(
      ctx,
      stagePhase,
      `Wrapped app root with ${result.providersWrapped.length} provider(s)|||Provider wrappers deduped`,
      result.providersWrapped.join(', '),
    );
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — convert the legacy `applyXxxFixes(files, fixes)` shape (which
// returns a fresh full-file array) into an EnhancementPatch.codeChanges.
//
// Stages keep their existing detection + fix logic; the orchestrator just
// wraps the result in a patch and routes it through `applyEnhancementPatches`
// instead of touching `ctx.files` directly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Diff a "before" file array against an "after" file array and return only
 * the files whose content actually changed (or are new). Used by the legacy
 * `applyXxxFixes` shim helpers below.
 */
export function diffFilesToPatchedFiles(
  before: GeneratedFile[],
  after: GeneratedFile[],
): PatchedFile[] {
  const beforeByPath = new Map(before.map(f => [f.path, f.content]));
  const out: PatchedFile[] = [];
  for (const f of after) {
    const prev = beforeByPath.get(f.path);
    if (prev === undefined || prev !== f.content) {
      out.push({ path: f.path, content: f.content, language: f.language });
    }
  }
  return out;
}

/**
 * Build an EnhancementPatch from a full-file replacement array (the shape
 * returned by `applyQualityFixes`, `applyHardeningFixes`,
 * `applyCrossFileConsistencyFixes`). Quality / hardening / consistency
 * fixes are pure regex rewrites today — they touch existing files only and
 * do not introduce new packages or providers, so deps + providers are
 * empty.
 */
export function patchFromFullFileReplacement(
  source: string,
  reason: string,
  before: GeneratedFile[],
  after: GeneratedFile[],
): EnhancementPatch {
  return {
    source,
    reason,
    codeChanges: diffFilesToPatchedFiles(before, after),
  };
}
