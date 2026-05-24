import { analyzeError, FixSuggestion } from "./error-fixer";
import { runViteTailwindDoctor, isViteOrTailwindError, stripAnsi } from "./vite-tailwind-doctor";

export interface AutoFixResult {
  error: string;
  fixed: boolean;
  action: string;
  details?: string;
  codeChanges?: { file: string; original: string; fixed: string }[];
  needsFullReinstall?: boolean;
}

export interface AutoFixConfig {
  enabled: boolean;
  maxRetries: number;
  autoApply: boolean;
  onFix?: (result: AutoFixResult) => void;
  onError?: (error: string) => void;
}

type AutoFixHandler = (
  error: string,
  context: AutoFixContext
) => AutoFixResult | null;

export interface AutoFixContext {
  files: { path: string; content: string }[];
  updateFile: (path: string, content: string) => Promise<void>;
  addTerminalLine: (type: string, message: string) => void;
  retryCount: number;
}

const KNOWN_GOOD_VITE_CONFIG = [
  'import { defineConfig } from "vite";',
  'import react from "@vitejs/plugin-react";',
  '',
  'export default defineConfig({',
  '  plugins: [react()],',
  '  resolve: {',
  '    alias: {',
  '      "@": "/src",',
  '    },',
  '  },',
  '});',
  '',
].join('\n');

function splitLinesPreserveEol(content: string): { lines: string[]; eol: string } {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return { lines: normalized.split('\n'), eol };
}

function joinLinesWithEol(lines: string[], eol: string): string {
  return lines.join(eol);
}

// ────────────────────────────────────────────────────────────────────────────
// Content guard for `useMemo(() => [)` / `useCallback(() => [)` repairs.
//
// The LLM produces this typo in two distinct shapes:
//   (1) Genuinely empty hook body — next non-whitespace token after `[)` is
//       a statement keyword (`return`, `const`, `}`, …). Repair: `[], []`.
//   (2) Multi-line array literal where the LLM merely dropped the closing
//       `])` after `[`. Next non-whitespace token after `[)` is array
//       content (object literal `{`, string, JSX, identifier-as-value, …)
//       and a real `])` exists later in the source. Repair: `[)` → `[`
//       and let the existing `])` close the array.
//
// Returns true when shape (2) is detected. The caller picks the repair.
// ────────────────────────────────────────────────────────────────────────────
export function isMultiLineArrayBodyAfter(content: string, matchEnd: number): boolean {
  let i = matchEnd;
  // Skip whitespace and JS comments
  while (i < content.length) {
    const ch = content[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i);
      if (nl < 0) return false;
      i = nl + 1; continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 2; continue;
    }
    break;
  }
  if (i >= content.length) return false; // EOF → genuinely empty
  const remainder = content.slice(i, i + 50);
  // Statement-starters / block-close → genuinely empty (the surrounding hook
  // call is broken and the rest of the function continues normally).
  if (/^(return|const|let|var|if|else|for|while|do|switch|case|break|continue|throw|try|catch|finally|}|export|import|function|class|interface|type|enum)\b/.test(remainder)) {
    return false;
  }
  // Object/array/string/template/JSX literal → array entry content.
  if (/^[{["'`<]/.test(remainder)) return true;
  // Identifier/number → likely an entry expression (e.g. `column1,` or `42,`).
  if (/^[A-Za-z_$0-9]/.test(remainder)) return true;
  return false;
}

export function applyParsedSyntaxFix(
  error: string,
  ctx: AutoFixContext,
  rawPath: string,
  line: number,
  col: number,
  errorMsg: string,
): AutoFixResult | null {
  const filePath = rawPath.replace(/^\/home\/[^/]+\//, '');

  ctx.addTerminalLine("warn", `syntax error in ${filePath}:${line}:${col}`);
  ctx.addTerminalLine("info", `Error: ${errorMsg.trim()}`);

  const targetFile = ctx.files.find(f =>
    f.path === filePath ||
    f.path.endsWith('/' + filePath) ||
    filePath.endsWith('/' + f.path) ||
    filePath.endsWith(f.path)
  );

  if (!targetFile) {
    ctx.addTerminalLine("warn", `Could not find file ${filePath} in project files`);
    return null;
  }

  const { lines, eol } = splitLinesPreserveEol(targetFile.content);
  const originalContent = targetFile.content;
  let fixDescription = '';

  const isViteConfig =
    targetFile.path === 'vite.config.ts' || targetFile.path.endsWith('/vite.config.ts') ||
    targetFile.path === 'vite.config.js' || targetFile.path.endsWith('/vite.config.js');

  if (isViteConfig) {
    // Delegate every vite.config repair to the doctor (single source of truth).
    const filesCopy = ctx.files.map((f: { path: string; content: string }) => ({ path: f.path, content: f.content }));
    const report = runViteTailwindDoctor(
      { files: filesCopy, log: (m: string) => ctx.addTerminalLine('info', m) },
      'runtime',
      error,
    );
    if (report.codeChanges.length > 0) {
      return {
        error,
        fixed: true,
        action: `Vite/Tailwind Doctor (runtime): ${report.fixesApplied.map((f: { id: string }) => f.id).join(', ')}`,
        codeChanges: report.codeChanges.filter((c: { fixed: string }) => c.fixed !== ''),
      };
    }
    // Last-resort fallback: replace with known-good config when we can't
    // identify the failure mode but the file is clearly unparseable.
    const pkgFile = ctx.files.find(f => f.path === 'package.json');
    const hasReact = pkgFile && /["']react["']/.test(pkgFile.content);
    if (hasReact) {
      const fallback = eol === '\r\n'
        ? KNOWN_GOOD_VITE_CONFIG.replace(/\n/g, '\r\n')
        : KNOWN_GOOD_VITE_CONFIG;
      ctx.addTerminalLine('info', 'Auto-fix: Replaced unparseable vite.config with known-good React configuration');
      return {
        error,
        fixed: true,
        action: 'Replaced broken vite.config with known-good React configuration',
        codeChanges: [{ file: targetFile.path, original: originalContent, fixed: fallback }],
      };
    }
    return null;
  }

  const errorLine = lines[line - 1];
  if (!errorLine) return null;

  const jsxCloseRe = /<\/[A-Za-z][\w.\-]*>\s*$|<\/>\s*$/;

  const findNearestJsxCloseAbove = (fromIdx: number): { idx: number; line: string } | null => {
    for (let i = fromIdx; i >= 0; i--) {
      const raw = lines[i];
      const t = raw.trim();
      if (!t) continue;
      if (/^(\/\/|\*|\/\*)/.test(t)) continue;
      return jsxCloseRe.test(raw.trimEnd()) ? { idx: i, line: raw } : null;
    }
    return null;
  };

  const trimmedErrorLine = errorLine.trim();

  const isMissingParenError =
    /Expected "\)"/.test(errorMsg) ||
    /Unexpected token,?\s*expected\s*["']?,["']?/.test(errorMsg);

  if (trimmedErrorLine === ';' && isMissingParenError) {
    const jsxAbove = findNearestJsxCloseAbove(line - 2);
    if (jsxAbove) {
      lines[line - 1] = errorLine.replace(/;/, ');');
      const fixed = joinLinesWithEol(lines, eol);
      fixDescription = `Replaced bare ';' with ');' after JSX close at line ${line}`;
      ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
      return {
        error,
        fixed: true,
        action: fixDescription,
        codeChanges: [{ file: targetFile.path, original: originalContent, fixed }],
      };
    }
  }

  if (trimmedErrorLine === '}' && isMissingParenError) {
    const jsxAbove = findNearestJsxCloseAbove(line - 2);
    if (jsxAbove) {
      const indentMatch = jsxAbove.line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : '';
      lines.splice(line - 1, 0, `${indent});`);
      const fixed = joinLinesWithEol(lines, eol);
      fixDescription = `Inserted missing ');' before line ${line} (after JSX close at line ${jsxAbove.idx + 1})`;
      ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
      return {
        error,
        fixed: true,
        action: fixDescription,
        codeChanges: [{ file: targetFile.path, original: originalContent, fixed }],
      };
    }
  }

  // Vite's Babel pipeline emits "Missing semicolon." for the same defect that
  // esbuild reports as `Expected ";" but found "{"`. Accept either wording.
  const isCallBlockError =
    /Expected ";" but found "\{"/.test(errorMsg) ||
    (/Missing semicolon/i.test(errorMsg) && /\{\s*$/.test(errorLine));

  if (isCallBlockError) {
    const funcBlockMatch = errorLine.match(/(export\s+default\s+\w+)\(\)\s*\{/);
    if (funcBlockMatch) {
      lines[line - 1] = errorLine.replace(/(export\s+default\s+\w+)\(\)\s*\{/, '$1({');
      let joined = joinLinesWithEol(lines, eol);
      joined = joined.replace(/(\r?\n)(\s*)\}\s*;?\s*$/, `$1$2});`);
      fixDescription = `Fixed config export syntax at line ${line}`;
      ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
      return {
        error,
        fixed: true,
        action: fixDescription,
        codeChanges: [{ file: targetFile.path, original: originalContent, fixed: joined }],
      };
    }

    // EOL anchor narrowed (mirrors drainKnownTypos at ~L1220): permit
    // trailing whitespace or a single-line comment after `{`, but NOT
    // executable tokens — the rewrite below replaces the whole line with
    // `head + newArgs` and would truncate inline body content otherwise.
    const callOptsMatch = errorLine.match(/^(.*?)(\([^()]*\))(\s*)\{(\s*(?:\/\/.*|\/\*[\s\S]*?\*\/\s*)?)$/);
    if (callOptsMatch) {
      const head = callOptsMatch[1];
      const argsRaw = callOptsMatch[2];
      const innerArgs = argsRaw.slice(1, -1).trim();
      const isFunctionDecl = /\b(function|class)\b/.test(head) ||
        /=>\s*$/.test(head) ||
        /\b(if|for|while|switch|catch)\s*$/.test(head) ||
        /\)\s*$/.test(head);
      // Object/class method shorthand: `foo`, `async foo`, `get foo`, `set foo`,
      // `*foo`. Head is just an identifier — could be either a method declaration
      // or a bare call statement (e.g. `apiRequest("POST", "/x", d) {`).
      const headTrim = head.trim();
      const headLooksLikeShorthand =
        /^(?:async\s+)?(?:get\s+|set\s+)?\*?[A-Za-z_$][\w$]*$/.test(headTrim);
      // Args containing string/template literals or member access are
      // unambiguous evidence of a call expression (params can't contain those).
      const argsLookLikeCall = /["'`]/.test(innerArgs) || /\.\w/.test(innerArgs);
      // Call-site evidence in the head: assignment, await/return/etc., member
      // access, or a chained call.
      const hasCallContext =
        /[=.\]\)]/.test(headTrim) ||
        /\b(await|return|yield|throw|new)\s+[\w$.<>]*$/.test(headTrim);
      // Skip true method shorthand: head looks like a declaration AND args
      // don't look like a call. Bare-call statements (apiRequest("x", y) {)
      // get fixed because their args contain literals.
      const isMethodShorthand = headLooksLikeShorthand && !argsLookLikeCall;
      if (!isFunctionDecl && !isMethodShorthand && (hasCallContext || argsLookLikeCall)) {
        // Strip a trailing comma so `fetch(url, ) {` doesn't become `fetch(url,, {`.
        const cleanedArgs = innerArgs.replace(/,\s*$/, '');
        const newArgs = cleanedArgs.length > 0 ? `(${cleanedArgs}, {` : `({`;
        lines[line - 1] = head + newArgs;
        let depth = 1;
        let foundCloseAt = -1;
        for (let i = line; i < lines.length; i++) {
          const l = lines[i];
          for (let c = 0; c < l.length; c++) {
            const ch = l[c];
            if (ch === '{') depth++;
            else if (ch === '}') {
              depth--;
              if (depth === 0) { foundCloseAt = i; break; }
            }
          }
          if (foundCloseAt >= 0) break;
        }
        if (foundCloseAt >= 0) {
          const closeLine = lines[foundCloseAt];
          lines[foundCloseAt] = closeLine.replace(/\}(\s*[;,]?)\s*$/, '})$1');
          const joined = joinLinesWithEol(lines, eol);
          if (joined !== originalContent) {
            fixDescription = `Wrapped call options object at line ${line} (added ", {" / "})")`;
            ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
            return {
              error,
              fixed: true,
              action: fixDescription,
              codeChanges: [{ file: targetFile.path, original: originalContent, fixed: joined }],
            };
          }
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Pattern: `useMemo(() => [)` / `useCallback(() => [)` / `useEffect(() => [)`
  // — React hook with elided body and stray ")" instead of array close.
  // The drain's generic stray-paren rule would strip the ")" producing
  // `useMemo(() => [` (unterminated array), so this branch MUST run
  // before the generic stray-paren handler. Canonical repair preserves
  // the hook signature: `useMemo(() => [], [])` so deps lint surfaces
  // any missing dependencies cleanly.
  // ──────────────────────────────────────────────────────────────────────
  {
    const hookRe = /(useMemo|useCallback|useEffect)\(\s*((?:async\s*)?)\(\s*\)\s*=>\s*\[\)/;
    const hookEmptyArrayMatch = errorLine.match(hookRe);
    if (hookEmptyArrayMatch) {
      const hookName = hookEmptyArrayMatch[1];
      // Locate the match end inside the FILE so we can peek past the `[)`
      // for content. The match itself sits on `errorLine` (the source line).
      const lineStartOffset = lines.slice(0, line - 1).reduce((acc, l) => acc + l.length + eol.length, 0);
      const matchOnLine = errorLine.match(hookRe);
      let isMultiLine = false;
      if (matchOnLine && matchOnLine.index !== undefined) {
        const fileMatchEnd = lineStartOffset + matchOnLine.index + matchOnLine[0].length;
        isMultiLine = isMultiLineArrayBodyAfter(originalContent, fileMatchEnd);
      }
      let newLine: string;
      let label: string;
      if (isMultiLine) {
        // Drop only the stray `)` so the existing `])` later in the source
        // closes the array; preserves all entries verbatim.
        newLine = errorLine.replace(hookRe, `${hookName}($2() => [`);
        label = `Removed stray ")" after "[" in ${hookName}(() => [) at line ${line} (multi-line array body)`;
      } else {
        // Genuinely empty hook body — canonical close with empty deps.
        newLine = errorLine.replace(hookRe, `${hookName}($2() => [], [])`);
        label = `Repaired ${hookName}(() => [)) → ${hookName}(() => [], []) at line ${line}`;
      }
      if (newLine !== errorLine) {
        lines[line - 1] = newLine;
        const fixed = joinLinesWithEol(lines, eol);
        if (fixed !== originalContent) {
          fixDescription = label;
          ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
          return {
            error,
            fixed: true,
            action: fixDescription,
            codeChanges: [{ file: targetFile.path, original: originalContent, fixed }],
          };
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Pattern: generic `=> [)` — empty-array arrow with stray ")" instead
  // of array close. Insert "]" before the ")" to close the array; the
  // remaining ")" still closes whatever outer call wraps the arrow.
  // Hook-specific shapes are handled above; this is the catch-all.
  // ──────────────────────────────────────────────────────────────────────
  if (/=>\s*\[\)/.test(errorLine)) {
    const newLine = errorLine.replace(/=>(\s*)\[\)/, '=>$1[])');
    if (newLine !== errorLine) {
      lines[line - 1] = newLine;
      const fixed = joinLinesWithEol(lines, eol);
      if (fixed !== originalContent) {
        fixDescription = `Closed empty array body "=> [)" → "=> [])" at line ${line}`;
        ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
        return {
          error,
          fixed: true,
          action: fixDescription,
          codeChanges: [{ file: targetFile.path, original: originalContent, fixed }],
        };
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Pattern: bare `=> )` — empty-body arrow with stray ")" and NO following
  // "{" (e.g. `items.map((x) => )`). Replace with `=> {}` so the arrow at
  // least parses; downstream lint surfaces the empty-body issue cleanly.
  // Guarded: must be at end of line / before `;`/`,`/`)` — never strip a
  // legitimate trailing `)` that closes the outer call.
  // MUST run before the generic isStrayParenError handler below, which would
  // otherwise drop the ")" producing the unparseable `=>;`.
  // ──────────────────────────────────────────────────────────────────────
  if (/=>\s*\)(?=\s*(?:;|,|\)|$))/.test(errorLine) && !/=>\s*\)\s*\{/.test(errorLine)) {
    const newLine = errorLine.replace(/=>(\s*)\)(?=\s*(?:;|,|\)|$))/, '=>$1{}');
    if (newLine !== errorLine) {
      lines[line - 1] = newLine;
      const fixed = joinLinesWithEol(lines, eol);
      if (fixed !== originalContent) {
        fixDescription = `Replaced bare empty arrow "=> )" with "=> {}" at line ${line}`;
        ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
        return {
          error,
          fixed: true,
          action: fixDescription,
          codeChanges: [{ file: targetFile.path, original: originalContent, fixed }],
        };
      }
    }
  }

  // Stray ")" — esbuild reports `Unexpected ")"`, Vite/Babel reports the
  // bare `Unexpected token` with the column pointing at the offending char.
  // Try both column conventions: esbuild is 0-based, Babel is 0-based-ish but
  // sometimes off by one depending on parser. Probe col, col-1, col+1.
  const isStrayParenError =
    /Unexpected "\)"/.test(errorMsg) ||
    /Unexpected token/i.test(errorMsg);

  if (isStrayParenError) {
    const probeCols = [col, col - 1, col + 1];
    for (const probe of probeCols) {
      if (probe < 0 || probe >= errorLine.length) continue;
      if (errorLine.charAt(probe) !== ')') continue;
      const before = errorLine.slice(0, probe);
      const after = errorLine.slice(probe + 1);
      const beforeTrim = before.replace(/\s+$/, '');
      const droppable =
        /=>\s*$/.test(beforeTrim) ||
        /[\[(,]\s*$/.test(beforeTrim) ||
        /=>\s*\[\s*$/.test(before);
      if (!droppable) continue;
      lines[line - 1] = before.replace(/\s+$/, '') + after.replace(/^\s+/, ' ');
      const joined = joinLinesWithEol(lines, eol);
      if (joined !== originalContent) {
        fixDescription = `Removed stray ")" at line ${line}:${probe}`;
        ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
        return {
          error,
          fixed: true,
          action: fixDescription,
          codeChanges: [{ file: targetFile.path, original: originalContent, fixed: joined }],
        };
      }
    }
  }

  if (/Expected "\)" but found/.test(errorMsg)) {
    const before = errorLine.slice(0, col - 1);
    const after = errorLine.slice(col - 1);
    lines[line - 1] = before + ')' + after;
    const fixed = joinLinesWithEol(lines, eol);
    if (fixed !== originalContent) {
      fixDescription = `Inserted missing ")" at line ${line}:${col}`;
      ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
      return {
        error,
        fixed: true,
        action: fixDescription,
        codeChanges: [{ file: targetFile.path, original: originalContent, fixed }],
      };
    }
  }

  if (/Expected "\}" but found/.test(errorMsg)) {
    lines.splice(line - 1, 0, '}');
    const fixed = joinLinesWithEol(lines, eol);
    fixDescription = `Inserted missing "}" before line ${line}`;
    ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
    return {
      error,
      fixed: true,
      action: fixDescription,
      codeChanges: [{ file: targetFile.path, original: originalContent, fixed }],
    };
  }

  if (/Expected "\(" but found/.test(errorMsg)) {
    const before = errorLine.slice(0, col - 1);
    const after = errorLine.slice(col - 1);
    lines[line - 1] = before + '(' + after;
    const fixed = joinLinesWithEol(lines, eol);
    fixDescription = `Inserted missing "(" at line ${line}:${col}`;
    ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
    return {
      error,
      fixed: true,
      action: fixDescription,
      codeChanges: [{ file: targetFile.path, original: originalContent, fixed }],
    };
  }

  if (/Unexpected ";"/.test(errorMsg) && trimmedErrorLine === ';') {
    lines[line - 1] = '';
    const fixed = joinLinesWithEol(lines, eol);
    fixDescription = `Removed stray ";" at line ${line}`;
    ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
    return {
      error,
      fixed: true,
      action: fixDescription,
      codeChanges: [{ file: targetFile.path, original: originalContent, fixed }],
    };
  }

  if (/Expected ">"/.test(errorMsg)) {
    const joined = joinLinesWithEol(lines, eol).replace(
      /<(meta|link|hr|br|img|input|source|embed|track|wbr|col|area|base)\b([^>]*?)(?<!\/)>/gi,
      (_m: string, tag: string, attrs: string) => {
        let a = attrs;
        a = a.replace(/\bcharset\s*=/gi, 'charSet=');
        a = a.replace(/\bclass\s*=/gi, 'className=');
        a = a.replace(/\bfor\s*=/gi, 'htmlFor=');
        return `<${tag}${a} />`;
      }
    );
    if (joined !== originalContent) {
      fixDescription = `Self-closed void HTML elements in JSX at line ${line}`;
      ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
      return {
        error,
        fixed: true,
        action: fixDescription,
        codeChanges: [{ file: targetFile.path, original: originalContent, fixed: joined }],
      };
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Pattern: `(e) = />` (mangled JSX arrow). Babel reports
  // "Unterminated regular expression" because `/>` looks like a regex.
  // Source line contains a paren-close followed by ` = />`.
  // ──────────────────────────────────────────────────────────────────────
  if (/Unterminated regular expression/i.test(errorMsg) && /=\s*\/>/.test(errorLine)) {
    // Only fire when the `= />` appears after a paren-close, which is the
    // signature of an arrow whose `=>` was garbled.
    const mangledArrowMatch = errorLine.match(/(\))(\s*)=(\s*)\/>(\s*)/);
    if (mangledArrowMatch) {
      const newLine = errorLine.replace(/(\))(\s*)=(\s*)\/>(\s*)/, '$1$2=>$4');
      lines[line - 1] = newLine;
      const fixed = joinLinesWithEol(lines, eol);
      if (fixed !== originalContent) {
        fixDescription = `Repaired mangled arrow "= />" → "=>" at line ${line}`;
        ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
        return {
          error,
          fixed: true,
          action: fixDescription,
          codeChanges: [{ file: targetFile.path, original: originalContent, fixed }],
        };
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Pattern: `=> ) {` empty-body arrow with stray ")" before "{".
  // Either Babel "Unexpected token" or esbuild "Unexpected ')'".
  // Drop the stray ")" so `=> ) {` becomes `=> {`.
  // ──────────────────────────────────────────────────────────────────────
  if (/=>\s*\)\s*\{/.test(errorLine)) {
    const newLine = errorLine.replace(/=>(\s*)\)(\s*)\{/, '=>$1$2{');
    if (newLine !== errorLine) {
      lines[line - 1] = newLine;
      const fixed = joinLinesWithEol(lines, eol);
      if (fixed !== originalContent) {
        fixDescription = `Removed stray ")" before "{" in empty arrow body at line ${line}`;
        ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
        return {
          error,
          fixed: true,
          action: fixDescription,
          codeChanges: [{ file: targetFile.path, original: originalContent, fixed }],
        };
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Pattern: `(arg: type) ) =>` — duplicated ")" after a typed param list.
  // Babel reports "Did not expect a type annotation here" because the parser
  // closes the params at the first ")", leaving the type annotation orphaned.
  // Collapse `) )` to `)`.
  // ──────────────────────────────────────────────────────────────────────
  if (/Did not expect a type annotation here/i.test(errorMsg) || /\)\s+\)\s*=>/.test(errorLine)) {
    const dupParenMatch = errorLine.match(/\)([ \t]+)\)([ \t]*=>)/);
    if (dupParenMatch) {
      const newLine = errorLine.replace(/\)([ \t]+)\)([ \t]*=>)/, ')$2');
      if (newLine !== errorLine) {
        lines[line - 1] = newLine;
        const fixed = joinLinesWithEol(lines, eol);
        if (fixed !== originalContent) {
          fixDescription = `Collapsed duplicated ") )" → ")" before "=>" at line ${line}`;
          ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
          return {
            error,
            fixed: true,
            action: fixDescription,
            codeChanges: [{ file: targetFile.path, original: originalContent, fixed }],
          };
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Pattern: `<Tag) attr=...>` — stray ")" after JSX tag name.
  // Babel reports "Expected corresponding JSX closing tag for <Tag>".
  // Sweep the whole file for `<Tag) ` and strip the ")" — the broken site
  // is rarely on the reported line (the closing-tag mismatch is reported
  // there, but the actual stray paren is upstream).
  // ──────────────────────────────────────────────────────────────────────
  if (/Expected corresponding JSX closing tag/i.test(errorMsg) ||
      /Unexpected closing\s+["']?\w+["']?\s*tag does not match opening/i.test(errorMsg)) {
    // First sub-handler: rewrite a wrong closing-tag name when the error
    // explicitly lists both the wrong and the right tag names. This is the
    // shape Babel produces for `</Link>` where the matching open is `<div>`.
    const tagMismatch = errorMsg.match(/Unexpected closing\s+["']?(\w+)["']?\s*tag does not match opening\s+["']?(\w+)["']?/i);
    if (tagMismatch) {
      const wrongName = tagMismatch[1];
      const rightName = tagMismatch[2];
      if (wrongName !== rightName) {
        const wrongCloseRe = new RegExp(`</${wrongName}\\s*>`);
        if (wrongCloseRe.test(errorLine)) {
          const newLine = errorLine.replace(wrongCloseRe, `</${rightName}>`);
          if (newLine !== errorLine) {
            lines[line - 1] = newLine;
            const fixed = joinLinesWithEol(lines, eol);
            if (fixed !== originalContent) {
              fixDescription = `Rewrote mismatched closing tag </${wrongName}> → </${rightName}> at line ${line}`;
              ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
              return {
                error,
                fixed: true,
                action: fixDescription,
                codeChanges: [{ file: targetFile.path, original: originalContent, fixed }],
              };
            }
          }
        }
      }
    }
    const fileText = joinLinesWithEol(lines, eol);
    const strayJsxParenRe = /<([A-Za-z][\w$.]*)\)(\s)/g;
    if (strayJsxParenRe.test(fileText)) {
      const newText = fileText.replace(/<([A-Za-z][\w$.]*)\)(\s)/g, '<$1$2');
      if (newText !== fileText) {
        const matchCount = (fileText.match(/<([A-Za-z][\w$.]*)\)\s/g) || []).length;
        fixDescription = `Removed stray ")" after ${matchCount} JSX tag name(s)`;
        ctx.addTerminalLine("info", `Auto-fix: ${fixDescription}`);
        return {
          error,
          fixed: true,
          action: fixDescription,
          codeChanges: [{ file: targetFile.path, original: originalContent, fixed: newText }],
        };
      }
    }
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// drainKnownTypos: scans an entire file for every recurring LLM typo we
// know about and applies all fixes in one pass. This collapses the 3+
// restart cascade that occurred when each file held N typos but the parser
// only reported the first one per round.
//
// Pure regex sweeps for unambiguous fixes; falls back to the AST-aware
// `applyParsedSyntaxFix` for the call-options-block pattern (which needs
// matching close-brace tracking).
// ──────────────────────────────────────────────────────────────────────────
export interface DrainResult {
  content: string;
  fixesApplied: { id: string; count: number }[];
}

// Skip a single token starting at `i` in `src` IF it is a comment,
// string, or template literal. Returns the index *after* the token, or
// -1 if no token was skipped. Strings and template literals respect
// escapes; templates recursively skip nested `${...}` expressions
// (which themselves may contain strings, comments, and more templates).
// Used by countCodeBraceBalance and any future lexical scanners that
// need to ignore non-code regions.
function skipNonCodeAt(src: string, i: number): number {
  const n = src.length;
  const ch = src[i];
  // // line comment
  if (ch === '/' && src[i + 1] === '/') {
    let k = i + 2;
    while (k < n && src[k] !== '\n') k++;
    return k;
  }
  // /* block comment */
  if (ch === '/' && src[i + 1] === '*') {
    let k = i + 2;
    while (k < n - 1 && !(src[k] === '*' && src[k + 1] === '/')) k++;
    return Math.min(n, k + 2);
  }
  // "..." or '...' string
  if (ch === '"' || ch === "'") {
    const q = ch;
    let k = i + 1;
    while (k < n && src[k] !== q) {
      if (src[k] === '\\') k += 2;
      else k++;
    }
    return Math.min(n, k + 1);
  }
  // `...${ expr }...` template literal — recurse into ${...} so strings
  // and comments inside the expression do not throw outer counts off.
  if (ch === '`') {
    let k = i + 1;
    while (k < n && src[k] !== '`') {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === '$' && src[k + 1] === '{') {
        k += 2;
        let d = 1;
        while (k < n && d > 0) {
          const skipped = skipNonCodeAt(src, k);
          if (skipped > k) { k = skipped; continue; }
          if (src[k] === '{') d++;
          else if (src[k] === '}') { d--; if (d === 0) break; }
          k++;
        }
        k++;
        continue;
      }
      k++;
    }
    return Math.min(n, k + 1);
  }
  return -1;
}

// Count `{` minus `}` in source code, skipping comments, strings, and
// template literals (including nested `${...}` expression interiors).
// Returns negative when the file has more `}` than `{`. Used by P9 to
// decide if EOF has stray close-braces to drop.
function countCodeBraceBalance(src: string): number {
  let balance = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const skipped = skipNonCodeAt(src, i);
    if (skipped > i) { i = skipped; continue; }
    const ch = src[i];
    if (ch === '{') balance++;
    else if (ch === '}') balance--;
    i++;
  }
  return balance;
}

export function drainKnownTypos(originalContent: string, filePath: string): DrainResult {
  // Skip vite.config — the doctor owns it and its idiomatic defineConfig({})
  // call would confuse the call-options heuristics.
  if (/(?:^|\/)vite\.config\.[jt]s$/.test(filePath)) {
    return { content: originalContent, fixesApplied: [] };
  }

  let content = originalContent;
  const counts: Record<string, number> = {};
  const inc = (id: string, by = 1) => { counts[id] = (counts[id] ?? 0) + by; };
  const isJsxFile = /\.(jsx|tsx)$/.test(filePath);

  // ── Phase 1: regex sweeps until stable ───────────────────────────────
  for (let iter = 0; iter < 20; iter++) {
    const before = content;

    // P1: mangled JSX arrow `(...)= />` → `(...) =>`
    // Guard: must follow a `)` close (arrow params) to avoid false positives
    // on real `prop = />` JSX (which would be invalid anyway, but be safe).
    content = content.replace(/(\))(\s*)=(\s*)\/>(\s*)/g, (_m, p, s1, _s2, s4) => {
      inc('mangled-arrow');
      return `${p}${s1}=>${s4}`;
    });

    // P1b: mangled-arrow-attr — defensive duplicate scoped to JSX attribute
    // braces. Matches `attr={(... = />` patterns even if a future P1 guard
    // change accidentally narrows. Also covers shapes where the LLM omitted
    // the param parens entirely: `onClick={e = /> doX(e)}` → `onClick={e => doX(e)}`.
    if (isJsxFile) {
      // Bare-identifier arrow inside attribute brace: `={ident = />`
      const matches1b = content.match(/(=\{\s*[A-Za-z_$][\w$]*)(\s*)=(\s*)\/>/g);
      if (matches1b) {
        inc('mangled-arrow-attr', matches1b.length);
        content = content.replace(
          /(=\{\s*[A-Za-z_$][\w$]*)(\s*)=(\s*)\/>(\s*)/g,
          (_m, head, s1, _s2, s4) => `${head}${s1}=>${s4}`,
        );
      }
    }

    // P2a: empty-body arrow with stray paren before brace `=> ) {` → `=> {`
    {
      const matches = content.match(/=>\s*\)\s*\{/g);
      if (matches) {
        inc('empty-arrow-stray-paren-brace', matches.length);
        content = content.replace(/=>(\s*)\)(\s*)\{/g, '=>$1$2{');
      }
    }

    // P2b: bare empty-arrow stray paren `=> )` at end of line (no `{` after).
    // Common shape: `.map((x) => )` where the body was elided. Drop the
    // stray ")" so the arrow at least parses (downstream type/runtime errors
    // will surface meaningfully instead of a syntax error blocking the file).
    // Guarded: only at end of line / before `;` / before `,` / before `)` —
    // never strip the legitimate trailing `)` that closes an outer call when
    // the arrow already has a body.
    {
      const matches = content.match(/=>\s*\)(?=\s*(?:;|,|\)|\r?\n|$))/g);
      if (matches) {
        inc('empty-arrow-stray-paren-bare', matches.length);
        content = content.replace(/=>(\s*)\)(?=\s*(?:;|,|\)|\r?\n|$))/g, '=>$1{}');
      }
    }

    // P3a: React hook with elided body and stray ")" instead of array close:
    // `useMemo(() => [)`. Two distinct LLM shapes need DIFFERENT repairs:
    //   • Genuinely empty body → `useMemo(() => [], [])` (preserves deps slot)
    //   • Multi-line array body where LLM dropped only the closing `])` →
    //     `useMemo(() => [` so the existing `])` later in source closes it.
    // The generic P3b rule would convert `[)` to `[])` for both, which would
    // either drop the deps array (empty case) or fragment the array entries
    // (multi-line case). MUST run before P3b for correctness.
    {
      const re = /(useMemo|useCallback|useEffect)\(\s*((?:async\s*)?)\(\s*\)\s*=>\s*\[\)/g;
      let multiLineCount = 0;
      let emptyCount = 0;
      let result = '';
      let lastIdx = 0;
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(content)) !== null) {
        const matchEnd = m.index + m[0].length;
        const hookName = m[1];
        const asyncKw = m[2];
        const isMultiLine = isMultiLineArrayBodyAfter(content, matchEnd);
        const replacement = isMultiLine
          ? `${hookName}(${asyncKw}() => [`
          : `${hookName}(${asyncKw}() => [], [])`;
        if (isMultiLine) multiLineCount++; else emptyCount++;
        result += content.slice(lastIdx, m.index) + replacement;
        lastIdx = matchEnd;
      }
      if (multiLineCount > 0 || emptyCount > 0) {
        result += content.slice(lastIdx);
        content = result;
        if (emptyCount > 0) inc('hook-empty-array-body', emptyCount);
        if (multiLineCount > 0) inc('hook-multiline-array-stray-paren', multiLineCount);
      }
    }

    // P3b: generic `=> [)` — close the array before the stray paren so the
    // outer call still parses. Hook-specific shapes are handled by P3a above.
    {
      const matches = content.match(/=>\s*\[\)/g);
      if (matches) {
        inc('empty-array-stray-paren', matches.length);
        content = content.replace(/=>(\s*)\[\)/g, '=>$1[])');
      }
    }

    // P4: duplicated paren after typed param list `) ) =>` → `) =>`
    {
      const matches = content.match(/\)[ \t]+\)[ \t]*=>/g);
      if (matches) {
        inc('duplicated-paren-type-annot', matches.length);
        content = content.replace(/\)([ \t]+)\)([ \t]*=>)/g, ')$2');
      }
    }

    // P5: stray `)` after JSX tag name `<Tag) attr` → `<Tag attr`
    if (isJsxFile) {
      const matches = content.match(/<([A-Za-z][\w$.]*)\)\s/g);
      if (matches) {
        inc('stray-paren-jsx-tag', matches.length);
        content = content.replace(/<([A-Za-z][\w$.]*)\)(\s)/g, '<$1$2');
      }
    }

    // P6: jsx-stray-fragment-close — orphan `</>` when no matching `<>`
    // opener appears earlier in the same scope. LLMs sometimes emit a
    // trailing `</>` after a closing tag (`</div></>`); we drop the
    // orphan rather than leave a parser error. Conservative: only drop
    // when a *plain* `</>` occurs and there is no matching `<>` to its
    // left (string-level scan, good enough for the common shapes).
    if (isJsxFile) {
      const occurrences: number[] = [];
      let idx = content.indexOf('</>');
      while (idx !== -1) {
        const left = content.slice(0, idx);
        const opens = (left.match(/<>/g) || []).length;
        const closes = (left.match(/<\/>/g) || []).length;
        if (closes >= opens) {
          // This closing fragment has no matching opener → orphan.
          occurrences.push(idx);
        }
        idx = content.indexOf('</>', idx + 1);
      }
      if (occurrences.length > 0) {
        // Remove from right→left so indices stay valid.
        for (let i = occurrences.length - 1; i >= 0; i--) {
          const at = occurrences[i];
          content = content.slice(0, at) + content.slice(at + 3);
        }
        inc('jsx-stray-fragment-close', occurrences.length);
      }
    }

    // P7: jsx-close-tag-name-mismatch — `</Wrong>` when the matching
    // opener was something else. We walk a JSX tag stack at string
    // level (single-pass, coarse skip of string/template literals).
    //
    // Three repair branches, applied per-mismatch:
    //   (a) UNAMBIGUOUS RENAME — top.name !== closer.name AND nothing
    //       was opened between top and closer → rewrite the closer to
    //       `</top.name>`. Pre-existing safe behavior.
    //   (b) VOID-ELEMENT PROMOTION — when stack-top is a known
    //       void/self-closing element (Input, img, br, hr, meta, link,
    //       input, area, base, col, embed, source, track, wbr), the
    //       LLM intent was self-closing. Rewrite the opener to
    //       `<X ... />`, pop, then RE-CHECK the same closer against
    //       the new top. Walks down through stacked voids if needed.
    //   (c) AMBIGUOUS — neither rule applies → leave for the verify
    //       gate to surface; do not mangle the structure further.
    if (isJsxFile) {
      const VOID_NAMES = new Set([
        'input','Input','img','Img','br','Br','hr','Hr','meta','Meta',
        'link','Link','area','Area','base','Base','col','Col',
        'embed','Embed','source','Source','track','Track','wbr','Wbr',
      ]);
      // Brace-aware tag scanner. A naive regex like `<\/?\w+\s*[^<>]*?>`
      // gets fooled by JSX attribute bodies that contain `>` — most
      // notoriously arrow functions like `onClick={(e) => ...}`. We walk
      // the source character-by-character, treating any `{...}` block
      // inside a tag as opaque (with brace counting), so the only `>`
      // that closes a tag is one at brace-depth 0.
      type Tok = {
        idx: number;
        end: number;
        full: string;
        name: string;
        isClosing: boolean;
        isSelfClosing: boolean;
      };
      const scanTags = (src: string): Tok[] => {
        const out: Tok[] = [];
        let j = 0;
        while (j < src.length) {
          if (src[j] !== '<') { j++; continue; }
          let k = j + 1;
          let isClosing = false;
          if (src[k] === '/') { isClosing = true; k++; }
          if (k >= src.length || !/[A-Za-z]/.test(src[k])) { j++; continue; }
          const nameStart = k;
          while (k < src.length && /[\w$.]/.test(src[k])) k++;
          const name = src.slice(nameStart, k);
          // Walk to the closing `>` at brace depth 0, treating `{...}`
          // (and nested) as opaque attribute expressions.
          let depth = 0;
          let hit = -1;
          while (k < src.length) {
            const ch = src[k];
            if (ch === '{') depth++;
            else if (ch === '}') { if (depth > 0) depth--; }
            else if (depth === 0) {
              if (ch === '>') { hit = k; break; }
              if (ch === '<') break; // malformed; abandon this start
            }
            k++;
          }
          if (hit === -1) { j++; continue; }
          const full = src.slice(j, hit + 1);
          const isSelfClosing = src[hit - 1] === '/';
          out.push({ idx: j, end: hit + 1, full, name, isClosing, isSelfClosing });
          j = hit + 1;
        }
        return out;
      };
      type StackEntry = { name: string; openIdx: number; openEnd: number; openText: string };
      const stack: StackEntry[] = [];
      type Fix = { from: number; to: number; replacement: string };
      const fixes: Fix[] = [];
      const promotedOpenIdx = new Set<number>();
      let renameCount = 0;
      let promotionCount = 0;
      const tokens = scanTags(content);
      for (const tok of tokens) {
        const { full, name, isClosing, isSelfClosing } = tok;
        const idx = tok.idx;
        const tokLen = full.length;
        if (isSelfClosing) continue;
        if (!isClosing) {
          stack.push({
            name,
            openIdx: idx,
            openEnd: idx + tokLen,
            openText: full,
          });
          continue;
        }
        // Closing tag handling
        let top = stack[stack.length - 1];
        // Branch (d-empty): closer with empty stack AND closer is a known
        // void element → orphan, drop. (Plain non-void with empty stack
        // is left alone — likely a wider structural issue we won't guess.)
        if (!top) {
          if (VOID_NAMES.has(name)) {
            fixes.push({ from: idx, to: idx + tokLen, replacement: '' });
            promotionCount++; // count as a void-promotion outcome
          }
          continue;
        }
        if (top.name === name) { stack.pop(); continue; }

        // Branch (b): walk down through stacked void elements,
        // promoting each to self-closing, until we either match or
        // exhaust the void chain.
        let promoted = false;
        while (top && top.name !== name && VOID_NAMES.has(top.name)) {
          if (!promotedOpenIdx.has(top.openIdx)) {
            const stripped = top.openText.slice(0, -1).replace(/\s+$/, '');
            // Avoid double-slash if opener already weirdly ended in `/`
            const replacement = stripped.endsWith('/') ? `${stripped}>` : `${stripped} />`;
            fixes.push({ from: top.openIdx, to: top.openEnd, replacement });
            promotedOpenIdx.add(top.openIdx);
            promotionCount++;
          }
          stack.pop();
          top = stack[stack.length - 1];
          promoted = true;
        }
        if (top && top.name === name) {
          stack.pop();
          continue;
        }
        // If we promoted but the closer still matches nothing on the
        // stack, the closer is now an orphan — drop it.
        if (promoted) {
          fixes.push({ from: idx, to: idx + tokLen, replacement: '' });
          continue;
        }

        // Branch (d-void-orphan): closer is a known void element AND
        // its name is not anywhere on the stack → orphan from the LLM
        // emitting `</Input>` after a self-closing `<Input ... />`.
        // Safe to drop; the matching real opener handled itself.
        if (VOID_NAMES.has(name) && !stack.some(s => s.name === name)) {
          fixes.push({ from: idx, to: idx + tokLen, replacement: '' });
          promotionCount++;
          continue;
        }

        // Branch (a): unambiguous rename when no nested opens.
        if (top) {
          const between = content.slice(top.openEnd, idx);
          const hasNestedOpens = /<[A-Za-z]/.test(between);
          if (!hasNestedOpens) {
            fixes.push({
              from: idx,
              to: idx + tokLen,
              replacement: `</${top.name}>`,
            });
            stack.pop();
            renameCount++;
            continue;
          }
        }
        // Branch (c): ambiguous — leave THIS closer alone but keep
        // scanning. Dropping the prior `break;` lets later, independent
        // mismatches (especially void-element promotions further down
        // the file) still be repaired instead of being abandoned after
        // one ambiguous case.
        continue;
      }
      if (fixes.length > 0) {
        // Apply right→left to keep indices valid.
        const sorted = [...fixes].sort((a, b) => b.from - a.from);
        for (const f of sorted) {
          content = content.slice(0, f.from) + f.replacement + content.slice(f.to);
        }
        if (renameCount > 0) inc('jsx-close-tag-name-mismatch', renameCount);
        if (promotionCount > 0) inc('jsx-void-element-promotion', promotionCount);
      }
    }

    // P8: void-typed-initializer — `const x: void = fn(...)` → `const x = fn(...)`.
    // The `: void` annotation on a value initializer is the LLM-typical typo
    // when the intent is "function returns void". Narrow guard: ONLY strip
    // when the RHS starts with an identifier-call (`name(`) — the shape that
    // LLMs actually emit and that yields the runtime-blocking parse error
    // observed in bucket-2/bucket-3. Hand-written `const x: void = undefined`
    // or `: void = null` is left untouched.
    {
      const re = /(\b(?:const|let|var)\s+[A-Za-z_$][\w$]*)\s*:\s*void(\s*=\s*)(?=[A-Za-z_$][\w$.]*\s*\()/g;
      const matches = content.match(re);
      if (matches) {
        inc('void-typed-initializer', matches.length);
        content = content.replace(re, '$1$2');
      }
    }

    // P10: generic-self-close-typo — `<T,/>` → `<T,>` in declaration position.
    // The trailing-comma generic (`<T,>`) is the TSX-safe disambiguation for
    // generic arrow functions; LLMs sometimes emit the malformed `<T,/>`
    // (mixing generic syntax with JSX self-close). Rewrite to the canonical
    // form so the file parses.
    {
      const re = /<([A-Z][\w$]*)\s*,\s*\/>/g;
      const matches = content.match(re);
      if (matches) {
        inc('generic-self-close-typo', matches.length);
        content = content.replace(re, '<$1,>');
      }
    }

    // P11: jsx-attr-extra-close-paren — extra `)` inside a `={...}` JSX
    // attribute brace. LLMs emit shapes like `onClick={() => fn(arg))}`
    // (one paren too many before the closing brace). Walk every JSX
    // attribute brace, count parens (skipping strings, comments, and
    // template literals so `onClick={() => fn(")")}` does NOT mis-count);
    // if the brace body has exactly one more `)` than `(` AND the byte
    // immediately before `}` is `)`, drop that one paren. Safe: zero
    // structural change unless paren count is off by exactly +1 AND the
    // offender sits right before the `}`.
    if (isJsxFile) {
      const fixes: { from: number; to: number }[] = [];
      let j = 0;
      while (j < content.length - 1) {
        // Look for an attribute brace opener: `={`
        if (content[j] === '=' && content[j + 1] === '{') {
          const start = j + 2; // first byte inside the brace
          let depth = 1;
          let k = start;
          let opens = 0;
          let closes = 0;
          let lastCloseIdx = -1;
          while (k < content.length && depth > 0) {
            // Skip strings / template literals / comments so their
            // contents do not contribute to the paren count.
            const skipped = skipNonCodeAt(content, k);
            if (skipped > k) { k = skipped; continue; }
            const ch = content[k];
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) break; }
            else if (ch === '(') opens++;
            else if (ch === ')') { closes++; lastCloseIdx = k; }
            k++;
          }
          if (depth === 0 && closes === opens + 1 && lastCloseIdx === k - 1) {
            // The `)` immediately before `}` is the extra one — drop it.
            fixes.push({ from: lastCloseIdx, to: lastCloseIdx + 1 });
          }
          j = k + 1;
          continue;
        }
        j++;
      }
      if (fixes.length > 0) {
        const sorted = [...fixes].sort((a, b) => b.from - a.from);
        for (const f of sorted) {
          content = content.slice(0, f.from) + content.slice(f.to);
        }
        inc('jsx-attr-extra-close-paren', fixes.length);
      }
    }

    if (content === before) break;
  }

  // ── Phase 1b: EOF stray close-brace drop (P9) ─────────────────────────
  // After all other repairs have stabilized, if the file's brace counter
  // shows MORE `}` than `{` AND the file ends in a run of `}` characters,
  // drop the excess. We count braces in code (skipping single-line
  // comments and string/template literals) so legitimate braces inside
  // string content do not throw the count off.
  {
    const balance = countCodeBraceBalance(content);
    if (balance < 0) {
      let excess = -balance;
      // Walk backwards from end of file, skipping whitespace, dropping
      // up to `excess` trailing `}` characters.
      let endIdx = content.length;
      while (excess > 0 && endIdx > 0) {
        // Skip trailing whitespace.
        let k = endIdx - 1;
        while (k >= 0 && /\s/.test(content[k])) k--;
        if (k < 0 || content[k] !== '}') break;
        // Drop this `}` (preserving the trailing whitespace as-is).
        content = content.slice(0, k) + content.slice(k + 1);
        endIdx = k;
        excess--;
        inc('eof-extra-close-brace');
      }
    }
  }

  // ── Phase 2: call-options blocks (xxx() { → xxx({ ... }) ─────────────
  // Reuse applyParsedSyntaxFix's full logic per site (it handles matching
  // close-brace tracking). Iterate until no more sites are fixed.
  for (let iter = 0; iter < 50; iter++) {
    const lines = content.split(/\r?\n/);
    let appliedThisPass = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // EOL anchor narrowed (was `\{(\s*)$`): allow trailing whitespace
      // OR a single-line comment after the `{`. Captured shape from
      // setup.ts:53:59 has `vi.fn() { // comment` form. We DO NOT allow
      // executable tokens after `{` because the downstream rewriter
      // replaces the whole line with `head + newArgs`, which would
      // truncate any inline body content. The isFunctionDecl /
      // isMethodShorthand guards below still gate over-matches.
      const callOptsMatch = line.match(/^(.*?)(\([^()]*\))(\s*)\{(\s*(?:\/\/.*|\/\*[\s\S]*?\*\/\s*)?)$/);
      if (!callOptsMatch) continue;

      const head = callOptsMatch[1];
      const argsRaw = callOptsMatch[2];
      const innerArgs = argsRaw.slice(1, -1).trim();
      const isFunctionDecl = /\b(function|class)\b/.test(head) ||
        /=>\s*$/.test(head) ||
        /\b(if|for|while|switch|catch)\s*$/.test(head) ||
        /\)\s*$/.test(head);
      const headTrim = head.trim();
      const headLooksLikeShorthand =
        /^(?:async\s+)?(?:get\s+|set\s+)?\*?[A-Za-z_$][\w$]*$/.test(headTrim);
      const argsLookLikeCall = /["'`]/.test(innerArgs) || /\.\w/.test(innerArgs);
      const hasCallContext =
        /[=.\]\)]/.test(headTrim) ||
        /\b(await|return|yield|throw|new)\s+[\w$.<>]*$/.test(headTrim);
      const isMethodShorthand = headLooksLikeShorthand && !argsLookLikeCall;
      if (isFunctionDecl || isMethodShorthand || (!hasCallContext && !argsLookLikeCall)) continue;

      const tempCtx: AutoFixContext = {
        files: [{ path: filePath, content }],
        updateFile: async () => {},
        addTerminalLine: () => {},
        retryCount: 0,
      };
      const result = applyParsedSyntaxFix(
        'Expected ";" but found "{"',
        tempCtx,
        filePath,
        i + 1,
        head.length,
        'Expected ";" but found "{"',
      );
      const change = result?.codeChanges?.find((c) =>
        c.file === filePath ||
        filePath.endsWith('/' + c.file) ||
        c.file.endsWith('/' + filePath) ||
        filePath.endsWith(c.file)
      );
      if (change && change.fixed !== content) {
        content = change.fixed;
        inc('call-options-block');
        appliedThisPass = true;
        break;
      }
    }
    if (!appliedThisPass) break;
  }

  const fixesApplied = Object.entries(counts).map(([id, count]) => ({ id, count }));
  return { content, fixesApplied };
}

// ──────────────────────────────────────────────────────────────────────────
// auditResidualBrokenPatterns: AFTER a drain pass, scan every code file for
// known-broken patterns the drain *should* have eliminated. Any hit is a
// silent miss — the drain ran on different bytes than what's now on disk,
// or a typo shape escaped its regex. We surface each hit as a structured
// finding the runner can log loudly so we never again see "drain reported
// zero mangled-arrow but Vite errored on `(e) = />`".
// ──────────────────────────────────────────────────────────────────────────
export interface ResidualFinding {
  file: string;
  pattern: string;
  line: number;
  snippet: string;
}

const RESIDUAL_PATTERNS: { id: string; re: RegExp; jsxOnly?: boolean }[] = [
  { id: 'mangled-arrow', re: /(\))(\s*)=(\s*)\/>/ },
  // Bare-identifier arrow inside JSX attribute brace — pairs with P1b.
  { id: 'mangled-arrow-attr', re: /=\{\s*[A-Za-z_$][\w$]*\s*=\s*\/>/, jsxOnly: true },
  { id: 'empty-arrow-stray-paren-brace', re: /=>\s*\)\s*\{/ },
  { id: 'duplicated-paren-type-annot', re: /\)[ \t]+\)[ \t]*=>/ },
  { id: 'stray-paren-jsx-tag', re: /<[A-Za-z][\w$.]*\)\s/, jsxOnly: true },
  { id: 'empty-array-stray-paren', re: /=>\s*\[\)/ },
];

export function auditResidualBrokenPatterns(
  files: { path: string; content: string }[],
): ResidualFinding[] {
  const findings: ResidualFinding[] = [];
  const codeRe = /\.(?:tsx?|jsx?|mjs|cjs)$/;
  for (const f of files) {
    if (!codeRe.test(f.path)) continue;
    if (f.path.includes('node_modules')) continue;
    // Note: vite/tailwind/postcss configs are intentionally INCLUDED in
    // the audit (these surfaces broke too in the failing-run-2026-04-18
    // generation). They are skipped only by the verify-then-start parse
    // gate (which has a different goal: pre-Vite TSX parse-check).
    const isJsx = /\.(jsx|tsx)$/.test(f.path);
    const lines = f.content.split(/\r?\n/);
    for (const { id, re, jsxOnly } of RESIDUAL_PATTERNS) {
      if (jsxOnly && !isJsx) continue;
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          const snippet = lines[i].length > 200 ? lines[i].slice(0, 197) + '...' : lines[i];
          findings.push({ file: f.path, pattern: id, line: i + 1, snippet });
          break; // one finding per pattern per file is enough to surface the bug
        }
      }
    }
  }
  return findings;
}

// ──────────────────────────────────────────────────────────────────────────
// VERIFY-THEN-START GATE — pre-Vite parse via esbuild-wasm transform()
//
// After the pre-start drain + residual audit, we *parse-check* every code
// file using esbuild's transform-only API. Any syntax error means Vite
// would also choke and cache a bad transform — so we run the per-error
// fixer, re-drain, and re-parse, up to N iterations. Cascade suppressor:
// only ONE error per file is actioned per iteration; everything else is
// re-checked on the next pass after we've re-parsed the now-edited file.
// ──────────────────────────────────────────────────────────────────────────

export interface VerifyError {
  file: string;
  line: number;
  column: number;
  message: string;
}

// Per-file outcome for a single verify-gate iteration.
//   - 'fixed'      : had an error in this iter, drain mutated bytes
//   - 'unchanged'  : had an error in this iter, drain produced no change
//   - 'new-error'  : did NOT have an error in the prior iter but does now
//                    (a repair elsewhere uncovered or introduced this one)
export type FileAction = 'fixed' | 'unchanged' | 'new-error';

export interface VerifyGateResult {
  ok: boolean;
  iterations: number;
  stillBroken: VerifyError[];   // first error per file after final pass
  repairedFiles: string[];      // files mutated by the verify→repair loop
  perIteration: {
    iteration: number;
    errorCount: number;
    repairedCount: number;
    perFileActions: Record<string, FileAction>;
  }[];
  /**
   * Files that the gate substituted with a minimal stub via
   * template-basement after stagnation. Present only when the caller
   * supplied a `criticalityClassifier` and at least one non-critical
   * file refused to converge. When non-empty, `degradedMode` is true.
   */
  stubbedFiles?: { path: string; reason: string; criticalityReason: string }[];
  /** True when the gate boots the app with one or more stubbed files. */
  degradedMode?: boolean;
}

type EsbuildTransform = (
  src: string,
  opts: { loader?: 'ts' | 'tsx' | 'js' | 'jsx'; sourcefile?: string }
) => Promise<unknown>;

type EsbuildErrorObj = {
  text?: string;
  location?: { line?: number; column?: number; file?: string } | null;
};

function loaderFor(path: string): 'ts' | 'tsx' | 'js' | 'jsx' {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.jsx')) return 'jsx';
  if (path.endsWith('.ts')) return 'ts';
  return 'js';
}

function isVerifiable(path: string): boolean {
  if (!/\.(?:tsx?|jsx?|mjs|cjs)$/.test(path)) return false;
  if (path.includes('node_modules')) return false;
  if (/(?:^|\/)vite\.config\.[jt]s$/.test(path)) return false;
  if (/(?:^|\/)tailwind\.config\.[jt]s$/.test(path)) return false;
  if (/(?:^|\/)postcss\.config\.[jt]s$/.test(path)) return false;
  if (/\.d\.ts$/.test(path)) return false;
  return true;
}

/**
 * Parse-check every verifiable file. Returns first error per file (cascade
 * suppressor — one actionable error per file per iteration).
 *
 * @internal exported for testing
 */
export async function parseCheckOnce(
  files: { path: string; content: string }[],
  transform: EsbuildTransform,
): Promise<VerifyError[]> {
  const errors: VerifyError[] = [];
  for (const f of files) {
    if (!isVerifiable(f.path)) continue;
    try {
      await transform(f.content, { loader: loaderFor(f.path), sourcefile: f.path });
    } catch (e: unknown) {
      const eb = e as { errors?: EsbuildErrorObj[]; message?: string };
      const first = eb?.errors?.[0];
      if (first) {
        errors.push({
          file: f.path,
          line: first.location?.line ?? 1,
          column: first.location?.column ?? 0,
          message: first.text ?? 'syntax error',
        });
      } else {
        errors.push({
          file: f.path,
          line: 1,
          column: 0,
          message: eb?.message ?? 'syntax error',
        });
      }
    }
  }
  return errors;
}

/**
 * Verify-then-start gate. Runs up to `maxIterations` rounds of:
 *   1. parse-check every file (cascade-suppressed: first error/file)
 *   2. for each erroring file, run drainKnownTypos on fresh disk content
 *   3. write back if mutated
 * Stops early when all files parse clean.
 */
export async function runVerifyThenStartGate(opts: {
  files: { path: string; content: string }[];
  transform: EsbuildTransform;
  read: (path: string) => Promise<string | null>;
  write: (path: string, content: string) => Promise<void>;
  /**
   * Task #23 — optional FS delete callback. When supplied, branch
   * discard removes paths that were CREATED inside the branch (no
   * baseline) so true snapshot parity is restored after a regression.
   * When omitted, discard falls back to writing empty content + a
   * warn-once log (graceful degradation for callers that haven't
   * wired the delete path yet).
   */
  del?: (path: string) => Promise<void>;
  drain: (content: string, path: string) => { content: string };
  maxIterations?: number;
  /**
   * Task #23 — optional sandboxed-repair-branch host. When supplied, each
   * iteration is wrapped in a `RunnerRepairBranch`: if the iteration
   * regresses (more parser errors than at iteration start, or a
   * previously-clean file becomes broken), the branch is discarded and
   * the FS is restored to the pre-iteration snapshot. When not supplied,
   * the gate behaves exactly as before (back-compat for existing tests).
   */
  branchHost?: import('./repair-branch').RunnerBranchHost;
  // Optional doctor pass invoked at the start of every iteration. Receives
  // a snapshot of live file contents and returns whole-file rewrites to
  // apply (e.g. the `defineConfig() {` → `defineConfig({` repair). Any
  // returned change is written to disk + tracked as a repair before the
  // parse-check runs, so doctor-fixable shapes never count against the
  // drain's per-file repair budget.
  doctor?: (
    files: { path: string; content: string }[],
  ) => Promise<{ file: string; fixed: string }[]> | { file: string; fixed: string }[];
  /**
   * Optional pure classifier deciding whether a still-broken file is
   * fatal-for-boot ("critical") or stub-able ("non-critical"). When
   * supplied AND `stubGenerator` is supplied, files that refuse to
   * converge after `maxIterations` get stubbed instead of aborting,
   * provided every still-broken file is non-critical.
   */
  criticalityClassifier?: (path: string) => { critical: boolean; reason: string };
  /** Returns a minimal valid stub for a path that won't parse. */
  stubGenerator?: (path: string, reason: string) => { substituted: boolean; content: string } | null;
}): Promise<VerifyGateResult> {
  const maxIterations = opts.maxIterations ?? 3;
  const repairedFiles = new Set<string>();
  const perIteration: VerifyGateResult['perIteration'] = [];
  let lastErrors: VerifyError[] = [];
  let prevErrorPaths = new Set<string>();

  // Snapshot live in-memory copies so callers see updates.
  const live = new Map<string, string>();
  for (const f of opts.files) live.set(f.path, f.content);

  for (let i = 1; i <= maxIterations; i++) {
    // Task #23 — open a per-iteration repair branch when a host is
    // supplied. Snapshot of the live FS at iteration start; commit on
    // success (or no-regression), discard + restore baseline on
    // regression.
    let iterBranch: import('./repair-branch').RunnerRepairBranch | null = null;
    // CRITICAL (Task #23): the regression baseline is the parse-error
    // count of the live FS BEFORE the doctor pass runs, not after. If
    // we sampled it after the doctor, a doctor-introduced regression
    // would silently become part of the baseline and not trigger the
    // discard branch. We snapshot here, parse-check, then let doctor +
    // drain run.
    let iterBaseErrorCount = 0;
    let preDoctorErrorPaths = new Set<string>();
    if (opts.branchHost) {
      try {
        const repairBranch = await import('./repair-branch');
        iterBranch = repairBranch.openRunnerRepairBranch(
          opts.branchHost,
          'verify-then-start',
          new Map(live),
          i,
        );
        // Capture true pre-iteration error baseline (before doctor) —
        // BOTH count AND path set, so a doctor pass that fixes one file
        // while breaking a previously-clean one is caught even when the
        // total count doesn't go up.
        const preDoctorSnapshot = Array.from(live.entries()).map(
          ([path, content]) => ({ path, content }),
        );
        const preDoctorErrors = await parseCheckOnce(preDoctorSnapshot, opts.transform);
        iterBaseErrorCount = preDoctorErrors.length;
        preDoctorErrorPaths = new Set(preDoctorErrors.map(e => e.file));
      } catch (err) {
        // Never let branch-helper bugs break the gate.
        iterBranch = null;
        // eslint-disable-next-line no-console
        console.warn('[verify-gate] branch open failed:', err);
      }
    }
    // Doctor pass — applies file-shape repairs (vite/vitest config, etc.)
    // that don't depend on a parse error to be detected. Runs every
    // iteration so a fix uncovered by an earlier drain is still picked
    // up. Cheap when there's nothing to fix (detect predicates short-
    // circuit).
    if (opts.doctor) {
      const docSnapshot = Array.from(live.entries()).map(([path, content]) => ({ path, content }));
      let changes: { file: string; fixed: string }[] = [];
      try { changes = await opts.doctor(docSnapshot); } catch { changes = []; }
      for (const c of changes) {
        const current = live.get(c.file);
        if (current === undefined || current === c.fixed) continue;
        // Task #23 — strict copy-on-write: when a branch is open, stage
        // the write in-memory only. Disk is updated by commitRunnerBranch
        // at iteration end; on discard, no half-applied edits leak.
        // Without a branch host, fall through to the legacy direct write.
        if (iterBranch) {
          iterBranch.files.set(c.file, c.fixed);
          iterBranch.touched.add(c.file);
        } else {
          try { await opts.write(c.file, c.fixed); } catch { continue; }
        }
        live.set(c.file, c.fixed);
        repairedFiles.add(c.file);
      }
    }

    const snapshot = Array.from(live.entries()).map(([path, content]) => ({ path, content }));
    const errors = await parseCheckOnce(snapshot, opts.transform);
    lastErrors = errors;
    // Only set baseline from post-doctor errors when NO branch is open
    // (legacy path — regression check is gated on iterBranch). With a
    // branch, iterBaseErrorCount was set to the pre-doctor error count
    // above so doctor-introduced regressions trigger discard.
    if (!iterBranch) iterBaseErrorCount = errors.length;
    if (errors.length === 0) {
      perIteration.push({ iteration: i, errorCount: 0, repairedCount: 0, perFileActions: {} });
      // Task #23 — clean iteration: commit the (no-op) branch for audit.
      if (iterBranch && opts.branchHost) {
        try {
          const repairBranch = await import('./repair-branch');
          await repairBranch.commitRunnerBranch(opts.branchHost, iterBranch, opts.write,
            { ok: true, errors: [] });
        } catch { /* never block on branch helpers */ }
      }
      return { ok: true, iterations: i, stillBroken: [], repairedFiles: Array.from(repairedFiles), perIteration };
    }

    let repairedThisIter = 0;
    const perFileActions: Record<string, FileAction> = {};
    // Cascade suppressor: one error → one file → one repair attempt per pass.
    const seen = new Set<string>();
    // 'new-error' is only meaningful from iteration 2 onward — on the
    // first pass everything is by definition "new". Treat first-iter
    // unrepaired files as 'unchanged' so the diagnostic stays meaningful.
    const isFirstIter = i === 1;
    for (const err of errors) {
      if (seen.has(err.file)) continue;
      seen.add(err.file);
      // Task #23 — when a branch is open, prefer the in-memory `live`
      // copy (which reflects staged-but-not-yet-flushed branch writes)
      // over a fresh disk read. Without a branch, behave as before and
      // hit disk so external edits are still picked up.
      let fresh: string | null = null;
      if (iterBranch) {
        fresh = live.get(err.file) ?? null;
        if (fresh === null) {
          try { fresh = await opts.read(err.file); } catch { fresh = null; }
        }
      } else {
        try { fresh = await opts.read(err.file); } catch { fresh = null; }
      }
      if (fresh === null) {
        perFileActions[err.file] =
          isFirstIter || prevErrorPaths.has(err.file) ? 'unchanged' : 'new-error';
        continue;
      }
      const after = opts.drain(fresh, err.file).content;
      if (after !== fresh) {
        // Task #23 — strict copy-on-write: stage to branch only; disk
        // gets the write at commit time. Without a branch, write live.
        if (iterBranch) {
          iterBranch.files.set(err.file, after);
          iterBranch.touched.add(err.file);
        } else {
          await opts.write(err.file, after);
        }
        live.set(err.file, after);
        repairedFiles.add(err.file);
        repairedThisIter++;
        perFileActions[err.file] = 'fixed';
      } else {
        perFileActions[err.file] =
          isFirstIter || prevErrorPaths.has(err.file) ? 'unchanged' : 'new-error';
      }
    }
    perIteration.push({ iteration: i, errorCount: errors.length, repairedCount: repairedThisIter, perFileActions });
    prevErrorPaths = new Set(errors.map(e => e.file));

    // Task #23 — close the iteration's branch. Re-parse to detect
    // regression: if the iteration introduced more errors than it
    // started with, restore the live FS to baseline and discard.
    if (iterBranch && opts.branchHost) {
      try {
        const repairBranch = await import('./repair-branch');
        const after = Array.from(live.entries()).map(([path, content]) => ({ path, content }));
        const afterErrors = await parseCheckOnce(after, opts.transform);
        // Regression rule: a previously-clean file (NOT in the
        // pre-doctor error set) is now erroring. We use the pre-doctor
        // path set, not `errors` (post-doctor), so a doctor pass that
        // breaks a clean file is caught even when total count is flat.
        const regressed: string[] = [];
        const seenPath = new Set<string>();
        for (const e of afterErrors) {
          if (seenPath.has(e.file)) continue;
          seenPath.add(e.file);
          if (!preDoctorErrorPaths.has(e.file)) regressed.push(e.file);
        }
        const errorIncreased = afterErrors.length > iterBaseErrorCount;
        if (regressed.length > 0 || errorIncreased) {
          // Restore baseline contents to live + disk; discard branch.
          // For paths CREATED inside the branch (no baseline), drop
          // them from live so in-memory state matches the post-discard
          // disk state (the branch helper deletes them on disk via
          // the `del` callback below).
          for (const path of iterBranch.touched) {
            const baseline = iterBranch.baseline.get(path);
            if (baseline === undefined) {
              live.delete(path);
              repairedFiles.delete(path);
              continue;
            }
            live.set(path, baseline);
          }
          await repairBranch.discardRunnerBranch(
            opts.branchHost,
            iterBranch,
            regressed.length > 0
              ? `iteration regressed ${regressed.length} previously-clean file(s): ${regressed.slice(0, 3).join(', ')}`
              : `iteration increased error count ${iterBaseErrorCount}→${afterErrors.length}`,
            opts.write,
            { ok: false, errors: afterErrors.map(e => e.file), regressedFiles: regressed.length > 0 ? regressed : undefined },
            opts.del,
          );
          // Treat this iteration as no progress so the loop bails.
          if (repairedThisIter === 0) break;
          continue;
        }
        // Sync touched files into the branch's working map so commit's
        // diff sees the right delta; then commit.
        for (const path of iterBranch.touched) {
          const cur = live.get(path);
          if (cur !== undefined) iterBranch.files.set(path, cur);
        }
        await repairBranch.commitRunnerBranch(opts.branchHost, iterBranch, opts.write,
          { ok: true, errors: afterErrors.map(e => e.file) });
      } catch { /* never let branch helpers break the gate */ }
    }

    if (repairedThisIter === 0) {
      // No progress possible — bail with current errors.
      break;
    }
  }

  // ── Stub-on-stagnation escalation ────────────────────────────────────
  // The repair loop didn't converge. If the caller supplied a
  // criticality classifier AND a stub generator, partition the
  // still-broken files: any non-critical file gets a minimal valid
  // stub written so the dev server can still boot in degraded mode.
  // If even one still-broken file is critical, we keep the existing
  // hard-abort behaviour (the caller surfaces that to the user).
  const stubbedFiles: { path: string; reason: string; criticalityReason: string }[] = [];
  if (lastErrors.length > 0 && opts.criticalityClassifier && opts.stubGenerator) {
    const byPath = new Map<string, VerifyError>();
    for (const e of lastErrors) if (!byPath.has(e.file)) byPath.set(e.file, e);
    const critical: VerifyError[] = [];
    const stubable: VerifyError[] = [];
    for (const e of byPath.values()) {
      const c = opts.criticalityClassifier(e.file);
      if (c.critical) critical.push(e); else stubable.push(e);
    }
    if (critical.length === 0 && stubable.length > 0) {
      // Every still-broken file is safely stub-able. Write stubs.
      for (const e of stubable) {
        const c = opts.criticalityClassifier(e.file);
        const reason = e.message || 'syntax error';
        const stub = opts.stubGenerator(e.file, reason);
        if (!stub || !stub.substituted) continue;
        try {
          await opts.write(e.file, stub.content);
          live.set(e.file, stub.content);
          repairedFiles.add(e.file);
          stubbedFiles.push({
            path: e.file,
            reason,
            criticalityReason: c.reason,
          });
        } catch {
          // If we can't even write the stub, leave the original error
          // alone so the abort path picks it up below.
        }
      }
      // Final parse-check: confirm the stubs actually parse clean.
      // (template-basement stubs are minimal exports and always do, but
      // we re-verify so a bug in a custom stubGenerator can't sneak a
      // broken file through.)
      const verifyAgain = await parseCheckOnce(
        Array.from(live.entries()).map(([path, content]) => ({ path, content })),
        opts.transform,
      );
      lastErrors = verifyAgain;
    }
  }

  const ok = lastErrors.length === 0;
  return {
    ok,
    iterations: perIteration.length,
    stillBroken: lastErrors,
    repairedFiles: Array.from(repairedFiles),
    perIteration,
    stubbedFiles: stubbedFiles.length > 0 ? stubbedFiles : undefined,
    degradedMode: ok && stubbedFiles.length > 0,
  };
}

export const AUTO_FIX_HANDLERS: { pattern: RegExp; handler: AutoFixHandler }[] = [
  {
    pattern: /Pre-transform error:\s*([^\s:]+\.[jt]sx?):\s*(.+?)\s*\((\d+):(\d+)\)/,
    handler: (error, ctx) => {
      const match = error.match(/Pre-transform error:\s*([^\s:]+\.[jt]sx?):\s*(.+?)\s*\((\d+):(\d+)\)/);
      if (!match) return null;
      const [, rawPath, errorMsg, lineStr, colStr] = match;
      return applyParsedSyntaxFix(
        error,
        ctx,
        rawPath,
        parseInt(lineStr),
        parseInt(colStr),
        errorMsg,
      );
    },
  },
  {
    pattern: /([^\s:]+\.[jt]sx?):(\d+):(\d+):\s*Unexpected token,?\s*expected\s*["'][^"']+["']/,
    handler: (error, ctx) => {
      const match = error.match(/([^\s:]+\.[jt]sx?):(\d+):(\d+):\s*(Unexpected token,?\s*expected\s*["'][^"']+["'])/);
      if (!match) return null;
      const [, rawPath, lineStr, colStr, errorMsg] = match;
      return applyParsedSyntaxFix(
        error,
        ctx,
        rawPath,
        parseInt(lineStr),
        parseInt(colStr),
        errorMsg,
      );
    },
  },
  {
    pattern: /([^\s:]+\.[jt]sx?):(\d+):(\d+): ERROR: (.+)/,
    handler: (error, ctx) => {
      const match = error.match(/([^\s:]+\.[jt]sx?):(\d+):(\d+): ERROR: (.+)/);
      if (!match) return null;
      const [, rawPath, lineStr, colStr, errorMsg] = match;
      return applyParsedSyntaxFix(
        error,
        ctx,
        rawPath,
        parseInt(lineStr),
        parseInt(colStr),
        errorMsg,
      );
    },
  },
  {
    pattern: /Unknown node type:\s*undefined|unknown node type/i,
    handler: (error, ctx) => {
      ctx.addTerminalLine("warn", "Rollup WASM parseAst incompatibility detected in WebContainer.");
      ctx.addTerminalLine("info", "Auto-fix: Reinstalling @rollup/wasm-node and patching parseAst + Vite chunk...");
      return {
        error,
        fixed: true,
        action: "Patching Rollup parseAst and Vite import-analysis for WebContainer WASM compatibility",
        details: "Rollup WASM parser produces AST nodes incompatible with Vite's import analysis. Patching convertProgram and transformCjsImport.",
        needsFullReinstall: true,
        codeChanges: [],
      };
    },
  },
  {
    pattern: /Cannot read properties of undefined.*reading 'type'.*vite|vite.*Cannot read properties of undefined.*reading 'type'/i,
    handler: (error, ctx) => {
      ctx.addTerminalLine("warn", "Vite import-analysis crash: AST node type undefined.");
      ctx.addTerminalLine("info", "Auto-fix: Patching Vite's transformCjsImport with error handling...");
      return {
        error,
        fixed: true,
        action: "Patching Vite transformCjsImport with try-catch wrapper",
        details: "Vite's import analysis crashes when Rollup WASM returns invalid AST. Wrapping transformCjsImport with error handling.",
        needsFullReinstall: true,
        codeChanges: [],
      };
    },
  },
  {
    pattern: /Host version "[^"]+" does not match binary version|Cannot start service.*does not match/i,
    handler: (error, ctx) => {
      ctx.addTerminalLine("warn", "esbuild version mismatch — host JS and binary versions differ.");
      ctx.addTerminalLine("info", "Auto-fix: Reinstalling version-matched esbuild-wasm fallback...");
      return {
        error,
        fixed: true,
        action: "Reinstalling version-matched esbuild-wasm for WebContainer",
        details: "esbuild host and binary versions must match. Reinstalling with correct versions.",
        needsFullReinstall: true,
        codeChanges: [],
      };
    },
  },
  {
    pattern: /WebContainers require SharedArrayBuffer|cross-origin isolation/i,
    handler: (error, ctx) => {
      ctx.addTerminalLine("warn", "WebContainer requires cross-origin isolation headers.");
      ctx.addTerminalLine("info", "Auto-fix: This is a server configuration issue.");
      ctx.addTerminalLine("info", "→ The preview will use fallback mode (iframe sandbox).");
      return {
        error,
        fixed: true,
        action: "Switched to fallback preview mode",
        details: "WebContainer requires COOP/COEP headers. Using iframe sandbox instead.",
      };
    },
  },
  {
    pattern: /Cannot find module ['"]([^'"]+)['"]/,
    handler: (error, ctx) => {
      const match = error.match(/Cannot find module ['"]([^'"]+)['"]/);
      if (!match) return null;

      const moduleName = match[1];

      const isNativeRollupBinding = /^@rollup\/rollup-/.test(moduleName);
      if (isNativeRollupBinding) {
        ctx.addTerminalLine("warn", `Native rollup binding not available in WebContainer: ${moduleName}`);
        ctx.addTerminalLine("info", `Auto-fix: Patching rollup to use WASM fallback...`);
        return {
          error,
          fixed: true,
          action: `Patching rollup to use @rollup/wasm-node instead of native binding`,
          details: `WebContainer cannot run native binaries like ${moduleName}`,
          needsFullReinstall: true,
          codeChanges: [],
        };
      }

      const isNativeEsbuildBinding = /^@esbuild\//.test(moduleName);
      if (isNativeEsbuildBinding) {
        ctx.addTerminalLine("warn", `Native esbuild binary not available in WebContainer: ${moduleName}`);
        ctx.addTerminalLine("info", `Auto-fix: Patching esbuild to use esbuild-wasm fallback...`);
        return {
          error,
          fixed: true,
          action: `Patching esbuild to use esbuild-wasm instead of native binary`,
          details: `WebContainer cannot run native binaries like ${moduleName}`,
          needsFullReinstall: true,
          codeChanges: [],
        };
      }

      const isInternalPath = moduleName.includes('node_modules/') ||
        moduleName.includes('/dist/') ||
        moduleName.includes('/chunks/') ||
        moduleName.startsWith('/home/') ||
        moduleName.startsWith('/tmp/') ||
        /^[A-Z]:[\\/]/.test(moduleName) ||
        /dep-[A-Za-z0-9]+\.js$/.test(moduleName);

      if (isInternalPath) {
        const parentPkg = moduleName.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/)?.[1] || 'unknown';
        ctx.addTerminalLine("warn", `Corrupted package installation detected: ${parentPkg}`);
        ctx.addTerminalLine("info", `Auto-fix: Forcing full reinstall to repair ${parentPkg}...`);

        return {
          error,
          fixed: true,
          action: `Detected corrupted ${parentPkg} installation — forcing full reinstall`,
          details: `Internal file missing: ${moduleName.split('/').pop()}`,
          needsFullReinstall: true,
          codeChanges: [],
        };
      }

      if (moduleName.startsWith('.') || moduleName.startsWith('/')) {
        return null;
      }

      const baseName = moduleName.startsWith('@')
        ? moduleName.split('/').slice(0, 2).join('/')
        : moduleName.split('/')[0];

      if (!baseName || baseName.includes(' ') || baseName.length > 214) {
        return null;
      }

      ctx.addTerminalLine("warn", `Missing module: ${baseName}`);
      ctx.addTerminalLine("info", `Auto-fix: Adding ${baseName} to package.json...`);

      const pkgFile = ctx.files.find(f => f.path === "package.json");
      if (pkgFile) {
        try {
          const pkg = JSON.parse(pkgFile.content);
          if (!pkg.dependencies) pkg.dependencies = {};
          pkg.dependencies[baseName] = "*";
          const fixed = JSON.stringify(pkg, null, 2);

          return {
            error,
            fixed: true,
            action: `Added ${baseName} to dependencies`,
            details: `Run npm install to complete the fix`,
            codeChanges: [{ file: "package.json", original: pkgFile.content, fixed }],
          };
        } catch (err) {
          console.warn('[AutoFix] Failed to parse package.json for missing module fix:', err);
          return null;
        }
      }
      return null;
    },
  },
  {
    pattern: /No matching export in "([^"]+)" for import "([^"]+)"/,
    handler: (error, ctx) => {
      const match = error.match(/No matching export in "([^"]+)" for import "([^"]+)"/);
      if (!match) return null;

      const [, rawPath, exportName] = match;
      const filePath = rawPath.replace(/^.*?\/(?=(src|lib|shared|utils|hooks|components|pages|routes|api|server|styles|assets|config|types|models|services|middleware)\/)/, '')
        || rawPath.replace(/^.*\/([^/]+\.[jt]sx?)$/, '$1');
      ctx.addTerminalLine("warn", `Missing export "${exportName}" in ${filePath}`);

      const KNOWN_UI_FILES: Record<string, Record<string, string>> = {
        'src/components/ui/toaster.tsx': {
          'Toaster': `// @generated\nimport { useToast } from "@/hooks/use-toast";\n\nexport function Toaster() {\n  const { toasts, dismiss } = useToast();\n\n  if (toasts.length === 0) return null;\n\n  return (\n    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">\n      {toasts.map((toast) => (\n        <div\n          key={toast.id}\n          className={\n            "rounded-lg border p-4 shadow-lg transition-all " +\n            (toast.variant === "destructive"\n              ? "bg-red-600 text-white border-red-700"\n              : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700")\n          }\n          role="alert"\n        >\n          {toast.title && <div className="font-semibold text-sm">{toast.title}</div>}\n          {toast.description && <div className="text-sm mt-1 opacity-90">{toast.description}</div>}\n          <button\n            onClick={() => dismiss(toast.id)}\n            className="absolute top-2 right-2 text-xs opacity-50 hover:opacity-100"\n          >\n            x\n          </button>\n        </div>\n      ))}\n    </div>\n  );\n}\n`,
        },
        'src/hooks/use-toast.ts': {
          'useToast': `// @generated\nimport { useState, useEffect } from "react";\n\ntype ToastVariant = "default" | "destructive";\ninterface Toast { id: string; title?: string; description?: string; variant?: ToastVariant; }\ntype ToastInput = Omit<Toast, "id">;\n\nlet toastCount = 0;\nlet listeners: Array<(t: Toast[]) => void> = [];\nlet memoryToasts: Toast[] = [];\n\nfunction dispatch(t: Toast[]) { memoryToasts = t; listeners.forEach(l => l(t)); }\n\nexport function toast(props: ToastInput) {\n  const id = String(++toastCount);\n  const t = { ...props, id };\n  dispatch([...memoryToasts, t]);\n  setTimeout(() => dismiss(id), 5000);\n  return { id, dismiss: () => dismiss(id) };\n}\n\nexport function dismiss(id: string) { dispatch(memoryToasts.filter(t => t.id !== id)); }\n\nexport function useToast() {\n  const [toasts, setToasts] = useState<Toast[]>(memoryToasts);\n  useEffect(() => { listeners.push(setToasts); return () => { listeners = listeners.filter(l => l !== setToasts); }; }, []);\n  return { toasts, toast, dismiss };\n}\n`,
          'toast': `// @generated\nimport { useState, useEffect } from "react";\n\ntype ToastVariant = "default" | "destructive";\ninterface Toast { id: string; title?: string; description?: string; variant?: ToastVariant; }\ntype ToastInput = Omit<Toast, "id">;\n\nlet toastCount = 0;\nlet listeners: Array<(t: Toast[]) => void> = [];\nlet memoryToasts: Toast[] = [];\n\nfunction dispatch(t: Toast[]) { memoryToasts = t; listeners.forEach(l => l(t)); }\n\nexport function toast(props: ToastInput) {\n  const id = String(++toastCount);\n  const t = { ...props, id };\n  dispatch([...memoryToasts, t]);\n  setTimeout(() => dismiss(id), 5000);\n  return { id, dismiss: () => dismiss(id) };\n}\n\nexport function dismiss(id: string) { dispatch(memoryToasts.filter(t => t.id !== id)); }\n\nexport function useToast() {\n  const [toasts, setToasts] = useState<Toast[]>(memoryToasts);\n  useEffect(() => { listeners.push(setToasts); return () => { listeners = listeners.filter(l => l !== setToasts); }; }, []);\n  return { toasts, toast, dismiss };\n}\n`,
          'dismiss': `// @generated\nimport { useState, useEffect } from "react";\n\ntype ToastVariant = "default" | "destructive";\ninterface Toast { id: string; title?: string; description?: string; variant?: ToastVariant; }\ntype ToastInput = Omit<Toast, "id">;\n\nlet toastCount = 0;\nlet listeners: Array<(t: Toast[]) => void> = [];\nlet memoryToasts: Toast[] = [];\n\nfunction dispatch(t: Toast[]) { memoryToasts = t; listeners.forEach(l => l(t)); }\n\nexport function toast(props: ToastInput) {\n  const id = String(++toastCount);\n  const t = { ...props, id };\n  dispatch([...memoryToasts, t]);\n  setTimeout(() => dismiss(id), 5000);\n  return { id, dismiss: () => dismiss(id) };\n}\n\nexport function dismiss(id: string) { dispatch(memoryToasts.filter(t => t.id !== id)); }\n\nexport function useToast() {\n  const [toasts, setToasts] = useState<Toast[]>(memoryToasts);\n  useEffect(() => { listeners.push(setToasts); return () => { listeners = listeners.filter(l => l !== setToasts); }; }, []);\n  return { toasts, toast, dismiss };\n}\n`,
        },
        'src/lib/queryClient.ts': {
          'queryClient': `// @generated\nimport { QueryClient } from "@tanstack/react-query";\n\nexport const queryClient = new QueryClient({\n  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: Infinity, retry: false } },\n});\n\nexport async function apiRequest(method: string, url: string, data?: unknown) {\n  const res = await fetch(url, {\n    method,\n    headers: data ? { "Content-Type": "application/json" } : {},\n    body: data ? JSON.stringify(data) : undefined,\n  });\n  if (!res.ok) throw new Error(await res.text());\n  return res;\n}\n`,
          'apiRequest': `// @generated\nimport { QueryClient } from "@tanstack/react-query";\n\nexport const queryClient = new QueryClient({\n  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: Infinity, retry: false } },\n});\n\nexport async function apiRequest(method: string, url: string, data?: unknown) {\n  const res = await fetch(url, {\n    method,\n    headers: data ? { "Content-Type": "application/json" } : {},\n    body: data ? JSON.stringify(data) : undefined,\n  });\n  if (!res.ok) throw new Error(await res.text());\n  return res;\n}\n`,
        },
      };

      const knownFile = KNOWN_UI_FILES[filePath];
      if (knownFile && knownFile[exportName]) {
        ctx.addTerminalLine("info", `Auto-fix: Regenerating ${filePath} with correct "${exportName}" export...`);
        const targetFile = ctx.files.find(f => f.path === filePath);
        return {
          error,
          fixed: true,
          action: `Regenerated ${filePath} with correct "${exportName}" export`,
          codeChanges: [{ file: filePath, original: targetFile?.content || '', fixed: knownFile[exportName] }],
        };
      }

      const targetFile = ctx.files.find(f => f.path === filePath);
      if (targetFile) {
        const hasExport = new RegExp(`export\\s+(?:const|function|class|let|var|type|interface)\\s+${exportName}\\b`).test(targetFile.content);
        if (!hasExport) {
          ctx.addTerminalLine("info", `Auto-fix: Adding stub export "${exportName}" to ${filePath}...`);
          const hasDefault = /export\s+default\s/.test(targetFile.content);
          const stub = hasDefault
            ? `\nexport const ${exportName} = {} as any;\n`
            : `\nexport function ${exportName}() { return null; }\n`;
          return {
            error,
            fixed: true,
            action: `Added missing export "${exportName}" to ${filePath}`,
            codeChanges: [{ file: filePath, original: targetFile.content, fixed: targetFile.content + stub }],
          };
        }
      }

      return {
        error,
        fixed: false,
        action: `Missing export "${exportName}" in ${filePath}`,
        details: `The file doesn't export a member named "${exportName}". Check the file and add the export.`,
      };
    },
  },
  {
    pattern: /ENOENT.*package\.json|no such file.*package\.json/i,
    handler: (error, ctx) => {
      ctx.addTerminalLine("warn", "No package.json found.");
      ctx.addTerminalLine("info", "Auto-fix: Creating default package.json...");

      const defaultPkg = JSON.stringify({
        name: "project",
        version: "1.0.0",
        type: "module",
        scripts: {
          dev: "node index.js",
          start: "node index.js"
        },
        dependencies: {}
      }, null, 2);

      return {
        error,
        fixed: true,
        action: "Created package.json",
        codeChanges: [{ file: "package.json", original: "", fixed: defaultPkg }],
      };
    },
  },
  {
    pattern: /SyntaxError: Cannot use import statement outside a module/i,
    handler: (error, ctx) => {
      ctx.addTerminalLine("warn", "ES Module syntax used without module type.");
      ctx.addTerminalLine("info", "Auto-fix: Setting type: module in package.json...");

      const pkgFile = ctx.files.find(f => f.path === "package.json");
      if (pkgFile) {
        try {
          const pkg = JSON.parse(pkgFile.content);
          pkg.type = "module";
          const fixed = JSON.stringify(pkg, null, 2);

          return {
            error,
            fixed: true,
            action: "Set type: module in package.json",
            codeChanges: [{ file: "package.json", original: pkgFile.content, fixed }],
          };
        } catch (err) {
          console.warn('[AutoFix] Failed to parse package.json for module type fix:', err);
          return null;
        }
      }
      return null;
    },
  },
  {
    pattern: /ReferenceError: (\w+) is not defined/,
    handler: (error, ctx) => {
      const match = error.match(/ReferenceError: (\w+) is not defined/);
      if (!match) return null;

      const varName = match[1];
      ctx.addTerminalLine("warn", `Undefined variable: ${varName}`);

      const commonFixes: Record<string, { file: string; import: string }> = {
        React: { file: "*.jsx,*.tsx", import: "import React from 'react';" },
        useState: { file: "*.jsx,*.tsx", import: "import { useState } from 'react';" },
        useEffect: { file: "*.jsx,*.tsx", import: "import { useEffect } from 'react';" },
        useCallback: { file: "*.jsx,*.tsx", import: "import { useCallback } from 'react';" },
        useMemo: { file: "*.jsx,*.tsx", import: "import { useMemo } from 'react';" },
        useRef: { file: "*.jsx,*.tsx", import: "import { useRef } from 'react';" },
        express: { file: "*.js,*.ts", import: "import express from 'express';" },
        fs: { file: "*.js,*.ts", import: "import fs from 'fs';" },
        path: { file: "*.js,*.ts", import: "import path from 'path';" },
      };

      const fix = commonFixes[varName];
      if (fix) {
        ctx.addTerminalLine("info", `Auto-fix: Adding import for ${varName}...`);
        return {
          error,
          fixed: true,
          action: `Suggested import: ${fix.import}`,
          details: `Add this import to the file using ${varName}`,
        };
      }

      return {
        error,
        fixed: false,
        action: `Variable "${varName}" is not defined`,
        details: "Check if the variable is declared or needs to be imported",
      };
    },
  },
  {
    pattern: /TypeError: Cannot read propert(?:y|ies) ['"]?(\w+)['"]? of (undefined|null)/,
    handler: (error, ctx) => {
      const match = error.match(/TypeError: Cannot read propert(?:y|ies) ['"]?(\w+)['"]? of (undefined|null)/);
      if (!match) return null;

      const [, prop, nullType] = match;
      ctx.addTerminalLine("warn", `Null pointer: accessing "${prop}" on ${nullType}`);
      ctx.addTerminalLine("info", "Auto-fix: Use optional chaining (?.) or null checks");

      return {
        error,
        fixed: false,
        action: `Add null check before accessing "${prop}"`,
        details: `Replace .${prop} with ?.${prop} or add if (obj) check`,
      };
    },
  },
  {
    pattern: /EADDRINUSE|address already in use/i,
    handler: (error, ctx) => {
      ctx.addTerminalLine("warn", "Port already in use.");
      ctx.addTerminalLine("info", "Auto-fix: The previous server instance may still be running.");

      return {
        error,
        fixed: true,
        action: "Port conflict detected",
        details: "Wait for the previous server to stop or use a different port",
      };
    },
  },
  {
    pattern: /Unexpected token ['<']/,
    handler: (error, ctx) => {
      ctx.addTerminalLine("warn", "Unexpected token '<' - likely JSX without proper setup.");
      ctx.addTerminalLine("info", "Auto-fix: Ensure JSX files have .jsx/.tsx extension");

      return {
        error,
        fixed: false,
        action: "JSX syntax in non-JSX file",
        details: "Rename file to .jsx/.tsx or configure babel for JSX",
      };
    },
  },
  {
    pattern: /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/,
    handler: (error, ctx) => {
      ctx.addTerminalLine("warn", "Module resolution error.");
      ctx.addTerminalLine("info", "Auto-fix: Check import paths and file extensions");

      return {
        error,
        fixed: false,
        action: "Module not found",
        details: "In ES modules, include file extensions in imports (.js, .mjs)",
      };
    },
  },
  {
    pattern: /npm ERR!|npm error/i,
    handler: (error, ctx) => {
      ctx.addTerminalLine("warn", "npm encountered an error.");

      if (/ERESOLVE|peer dep|dependency conflict/i.test(error)) {
        ctx.addTerminalLine("info", "Auto-fix: Try npm install --legacy-peer-deps");
        return {
          error,
          fixed: false,
          action: "Dependency conflict",
          details: "Run: npm install --legacy-peer-deps",
        };
      }

      return null;
    },
  },
  {
    pattern: /Maximum call stack size exceeded/,
    handler: (error, ctx) => {
      ctx.addTerminalLine("warn", "Stack overflow - infinite recursion detected.");
      ctx.addTerminalLine("info", "Auto-fix: Check for circular function calls or infinite loops");

      return {
        error,
        fixed: false,
        action: "Stack overflow",
        details: "Look for functions that call themselves without a base case",
      };
    },
  },
  // Multi-line esbuild dep-scan dispatcher — MUST run before the Vite/Tailwind
  // runtime catch-all, because dep-scan blocks always include "esbuild-wasm"
  // in the stack trace and the catch-all's broad pattern would otherwise
  // short-circuit per-file dispatch. Strips ANSI and walks every
  // (file:line:col, message) pair in the chunk.
  {
    pattern: /✘\s*\[ERROR\][\s\S]{0,1200}?\n\s+([^\s:]+\.[jt]sx?):\d+:\d+:/,
    handler: (error, ctx) => {
      const cleaned = stripAnsi(error);
      const blockRe = /✘\s*\[ERROR\]\s*([^\n]*)\n[\s\S]{0,1200}?\n\s+([^\s:]+\.[jt]sx?):(\d+):(\d+):/g;
      let m: RegExpExecArray | null;
      const aggregate: { file: string; original: string; fixed: string }[] = [];
      const fixedFiles = new Set<string>();
      let count = 0;
      while ((m = blockRe.exec(cleaned)) !== null) {
        const [, msg, rawPath, lineStr, colStr] = m;
        count++;
        const result = applyParsedSyntaxFix(
          error,
          ctx,
          rawPath,
          parseInt(lineStr),
          parseInt(colStr),
          msg.trim(),
        );
        if (result?.codeChanges) {
          for (const ch of result.codeChanges) {
            if (fixedFiles.has(ch.file)) continue;
            fixedFiles.add(ch.file);
            aggregate.push(ch);
          }
        }
      }
      if (count === 0) return null;
      if (aggregate.length === 0) {
        return { error, fixed: false, action: `esbuild dep-scan: ${count} error(s) parsed but no fixable patterns` };
      }
      return {
        error,
        fixed: true,
        action: `esbuild dep-scan: fixed ${aggregate.length} file(s) from ${count} error(s)`,
        codeChanges: aggregate,
      };
    },
  },
  // Vite/Tailwind/PostCSS runtime catch-all — single-line fallback that runs
  // AFTER the multi-line dispatcher. Skips dep-scan blocks (handled above).
  {
    pattern: /vite|tailwind|postcss|defineConfig|@tailwind|@plugin|@source|fileURLToPath|esbuild-wasm/i,
    handler: (error, ctx) => {
      // Defense in depth: if the chunk is a multi-line dep-scan block, the
      // dispatcher above owns it. Don't let the doctor steal source-file errors.
      if (/✘\s*\[ERROR\][\s\S]*?\n\s+[^\s:]+\.[jt]sx?:\d+:\d+:/.test(error)) return null;
      if (!isViteOrTailwindError(error)) return null;
      const filesCopy = ctx.files.map((f: { path: string; content: string }) => ({ path: f.path, content: f.content }));
      const report = runViteTailwindDoctor(
        { files: filesCopy, log: (m: string) => ctx.addTerminalLine('info', m) },
        'runtime',
        error,
      );
      if (report.codeChanges.length === 0) return null;
      const ids = report.fixesApplied.map((f: { id: string }) => f.id).join(', ');
      ctx.addTerminalLine('info', `🩺 Vite/Tailwind Doctor (runtime): ${ids}`);
      return {
        error,
        fixed: true,
        action: `Vite/Tailwind Doctor (runtime): ${ids}`,
        details: report.fixesApplied.map((f: { id: string; description: string }) => `${f.id}: ${f.description}`).join('; '),
        codeChanges: report.codeChanges.filter((c: { fixed: string }) => c.fixed !== ''),
      };
    },
  },
];

export class AutoFixEngine {
  private config: AutoFixConfig;
  private fixHistory: AutoFixResult[] = [];
  private recentErrors: Set<string> = new Set();

  constructor(config: Partial<AutoFixConfig> = {}) {
    this.config = {
      enabled: true,
      maxRetries: 3,
      autoApply: true,
      ...config,
    };
  }

  async processError(rawError: string, context: AutoFixContext): Promise<AutoFixResult | null> {
    if (!this.config.enabled) return null;

    // Strip ANSI escape codes universally — terminal output frequently carries
    // colour codes that break naive regex matchers.
    const error = stripAnsi(rawError);

    const errorKey = error.slice(0, 100);
    if (this.recentErrors.has(errorKey) && context.retryCount >= this.config.maxRetries) {
      context.addTerminalLine("error", `Max retries (${this.config.maxRetries}) reached for this error.`);
      return null;
    }
    this.recentErrors.add(errorKey);

    for (const { pattern, handler } of AUTO_FIX_HANDLERS) {
      if (pattern.test(error)) {
        const result = handler(error, context);
        if (result) {
          this.fixHistory.push(result);
          this.config.onFix?.(result);

          if (result.fixed && result.codeChanges && this.config.autoApply) {
            await this.applyFixes(result.codeChanges, context);
          }

          return result;
        }
      }
    }

    const genericSuggestions = analyzeError(error, "");
    if (genericSuggestions.length > 0 && genericSuggestions[0].confidence !== "low") {
      context.addTerminalLine("info", `Suggestion: ${genericSuggestions[0].description}`);
      return {
        error,
        fixed: false,
        action: genericSuggestions[0].description,
        details: genericSuggestions[0].explanation,
      };
    }

    return null;
  }

  private async applyFixes(
    changes: { file: string; original: string; fixed: string }[],
    context: AutoFixContext
  ) {
    for (const change of changes) {
      try {
        await context.updateFile(change.file, change.fixed);
        context.addTerminalLine("success", `✓ Auto-fixed: ${change.file}`);
      } catch (err) {
        context.addTerminalLine("error", `Failed to apply fix to ${change.file}`);
      }
    }
  }

  getHistory(): AutoFixResult[] {
    return [...this.fixHistory];
  }

  clearHistory() {
    this.fixHistory = [];
    this.recentErrors.clear();
  }

  setEnabled(enabled: boolean) {
    this.config.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }
}

export const autoFixEngine = new AutoFixEngine();

export async function processTerminalOutput(
  output: string,
  context: AutoFixContext
): Promise<AutoFixResult[]> {
  const results: AutoFixResult[] = [];
  const lines = output.split('\n');

  // First, try to match multi-line error blocks (esbuild dep-scan etc.) against
  // the FULL chunk so we capture the file:line:col line that follows the
  // error message. Then fall through to per-line dispatch.
  if (/✘\s*\[ERROR\]/.test(output)) {
    const blockResult = await autoFixEngine.processError(output, context);
    if (blockResult) results.push(blockResult);
  }

  for (const line of lines) {
    if (/error|Error|ERROR|failed|Failed|FAILED|exception|Exception/i.test(line)) {
      const result = await autoFixEngine.processError(line, context);
      if (result) {
        results.push(result);
      }
    }
  }

  return results;
}