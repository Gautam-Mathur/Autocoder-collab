interface GeneratedFile {
  path: string;
  content: string;
  language: string;
}

interface SymbolInfo {
  exports: Set<string>;
  imports: Map<string, Set<string>>;
}

export type SymbolTable = Map<string, SymbolInfo>;

const UI_COMPONENT_REGISTRY: Record<string, string[]> = {
  'src/components/ui/select.tsx': ['Select', 'SelectTrigger', 'SelectContent', 'SelectValue', 'SelectItem', 'SelectGroup', 'SelectLabel', 'SelectSeparator'],
  'src/components/ui/button.tsx': ['Button', 'buttonVariants'],
  'src/components/ui/input.tsx': ['Input'],
  'src/components/ui/label.tsx': ['Label'],
  'src/components/ui/card.tsx': ['Card', 'CardHeader', 'CardTitle', 'CardDescription', 'CardContent', 'CardFooter'],
  'src/components/ui/dialog.tsx': ['Dialog', 'DialogTrigger', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription', 'DialogFooter', 'DialogClose'],
  'src/components/ui/badge.tsx': ['Badge', 'badgeVariants'],
  'src/components/ui/textarea.tsx': ['Textarea'],
  'src/components/ui/checkbox.tsx': ['Checkbox'],
  'src/components/ui/switch.tsx': ['Switch'],
  'src/components/ui/tabs.tsx': ['Tabs', 'TabsList', 'TabsTrigger', 'TabsContent'],
  'src/components/ui/table.tsx': ['Table', 'TableHeader', 'TableBody', 'TableRow', 'TableHead', 'TableCell', 'TableCaption', 'TableFooter'],
  'src/components/ui/separator.tsx': ['Separator'],
  'src/components/ui/avatar.tsx': ['Avatar', 'AvatarImage', 'AvatarFallback'],
  'src/components/ui/tooltip.tsx': ['Tooltip', 'TooltipTrigger', 'TooltipContent', 'TooltipProvider'],
  'src/components/ui/dropdown-menu.tsx': ['DropdownMenu', 'DropdownMenuTrigger', 'DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuSeparator', 'DropdownMenuLabel', 'DropdownMenuGroup'],
  'src/components/ui/scroll-area.tsx': ['ScrollArea', 'ScrollBar'],
  'src/components/ui/alert-dialog.tsx': ['AlertDialog', 'AlertDialogTrigger', 'AlertDialogContent', 'AlertDialogHeader', 'AlertDialogTitle', 'AlertDialogDescription', 'AlertDialogFooter', 'AlertDialogAction', 'AlertDialogCancel'],
  'src/components/ui/popover.tsx': ['Popover', 'PopoverTrigger', 'PopoverContent'],
  'src/components/ui/accordion.tsx': ['Accordion', 'AccordionItem', 'AccordionTrigger', 'AccordionContent'],
  'src/components/ui/progress.tsx': ['Progress'],
  'src/components/ui/slider.tsx': ['Slider'],
  'src/components/ui/toast.tsx': ['Toast', 'Toaster', 'useToast'],
  'src/lib/utils.ts': ['cn', 'formatCurrency', 'formatNumber', 'formatPercent', 'formatDate', 'formatDateTime', 'safeGet', 'toTitleCase', 'toKebabCase'],
  'src/lib/queryClient.ts': ['apiRequest', 'queryClient', 'getQueryFn'],
};

const NODE_BUILTINS = new Set([
  'http', 'https', 'path', 'fs', 'crypto', 'stream', 'events', 'url', 'util',
  'os', 'child_process', 'net', 'tls', 'dns', 'dgram', 'buffer', 'assert',
  'querystring', 'zlib', 'cluster', 'worker_threads', 'perf_hooks', 'readline',
  'string_decoder', 'timers', 'v8', 'vm',
]);

function extractImportsFromContent(content: string): Map<string, Set<string>> {
  const imports = new Map<string, Set<string>>();

  const cleanName = (n: string): string => {
    let name = n.trim();
    if (name.startsWith('type ')) name = name.slice(5).trim();
    name = name.split(/\s+as\s+/)[0].trim();
    return name;
  };

  const addImport = (source: string, names: Set<string>) => {
    const existing = imports.get(source);
    if (existing) {
      for (const n of names) existing.add(n);
    } else {
      imports.set(source, names);
    }
  };

  const normalized = content.replace(/\r\n/g, '\n');

  const importRegex = /import\s+(?:(?:type\s+)?(?:\{([^}]+)\}|(\w+)(?:\s*,\s*\{([^}]+)\})?)\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(normalized)) !== null) {
    const source = match[4];
    const names = new Set<string>();

    if (match[1]) {
      for (const n of match[1].split(',')) {
        const cleaned = cleanName(n);
        if (cleaned) names.add(cleaned);
      }
    }
    if (match[2]) {
      const cleaned = cleanName(match[2]);
      if (cleaned) names.add(cleaned);
    }
    if (match[3]) {
      for (const n of match[3].split(',')) {
        const cleaned = cleanName(n);
        if (cleaned) names.add(cleaned);
      }
    }

    if (names.size === 0 && source) {
      names.add('*');
    }

    addImport(source, names);
  }

  return imports;
}

function extractExportsFromContent(content: string): Set<string> {
  const exports = new Set<string>();

  const defaultMatch = content.match(/export\s+default\s+(?:function|class|const|let|var)\s+(\w+)/);
  if (defaultMatch) {
    exports.add('default');
    exports.add(defaultMatch[1]);
  }

  const defaultExpr = content.match(/export\s+default\s+/);
  if (defaultExpr && !defaultMatch) exports.add('default');

  const namedExports = Array.from(content.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g));
  for (const m of namedExports) {
    exports.add(m[1]);
  }

  const reExports = Array.from(content.matchAll(/export\s*\{([^}]+)\}/g));
  for (const m of reExports) {
    for (const n of m[1].split(',')) {
      const name = n.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) exports.add(name);
    }
  }

  return exports;
}

export function buildSymbolTable(files: GeneratedFile[]): SymbolTable {
  const table: SymbolTable = new Map();

  for (const file of files) {
    if (file.path === 'package.json' || file.path.endsWith('.css') || file.path.endsWith('.html') || file.path.endsWith('.json') || file.path.endsWith('.md')) {
      continue;
    }

    const exports = extractExportsFromContent(file.content);
    const imports = extractImportsFromContent(file.content);
    table.set(file.path, { exports, imports });
  }

  return table;
}

function resolveImportPath(importSource: string, fromFile: string): string {
  if (importSource.startsWith('@/')) {
    return 'src/' + importSource.slice(2);
  }
  if (importSource.startsWith('@shared/')) {
    return 'shared/' + importSource.slice(8);
  }
  if (importSource === '@shared') {
    return 'shared/index';
  }
  if (importSource.startsWith('.')) {
    const dir = fromFile.split('/').slice(0, -1).join('/');
    const parts = (dir + '/' + importSource).split('/');
    const result: string[] = [];
    for (const part of parts) {
      if (part === '..') result.pop();
      else if (part !== '.' && part !== '') result.push(part);
    }
    return result.join('/');
  }
  return importSource;
}

function findFileByPath(resolvedPath: string, fileMap: Map<string, GeneratedFile>): string | undefined {
  const extensions = ['.ts', '.tsx', '.js', '.jsx', ''];
  const bases = [resolvedPath, resolvedPath + '/index'];

  for (const base of bases) {
    for (const ext of extensions) {
      const candidate = base + ext;
      if (fileMap.has(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExternalPackage(importSource: string): boolean {
  if (importSource.startsWith('.') || importSource.startsWith('/') || importSource.startsWith('@/') || importSource.startsWith('@shared')) {
    return false;
  }
  return true;
}

function getPackageName(importSource: string): string {
  if (importSource.startsWith('@')) {
    return importSource.split('/').slice(0, 2).join('/');
  }
  return importSource.split('/')[0];
}

export function canonicalizeProject(
  files: GeneratedFile[],
  symbolTable: SymbolTable,
  availableDeps: Record<string, string>
): { files: GeneratedFile[]; fixes: string[] } {
  const fixes: string[] = [];
  const fileMap = new Map<string, GeneratedFile>();
  for (const f of files) fileMap.set(f.path, { ...f });

  fixPackageJson(fileMap, symbolTable, availableDeps, fixes);

  fixSchemaImports(fileMap, symbolTable, fixes);

  fixUIComponentImports(fileMap, symbolTable, fixes);

  fixBrokenLocalImports(fileMap, symbolTable, fixes);

  fixQueryClientProvider(fileMap, symbolTable, fixes);

  fixMissingReactImports(fileMap, fixes);

  return { files: Array.from(fileMap.values()), fixes };
}

function fixPackageJson(
  fileMap: Map<string, GeneratedFile>,
  symbolTable: SymbolTable,
  availableDeps: Record<string, string>,
  fixes: string[]
): void {
  const pkgFile = fileMap.get('package.json');
  if (!pkgFile) return;

  interface PackageJson {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    [key: string]: unknown;
  }
  let pkg: PackageJson;
  try {
    const parsed = JSON.parse(pkgFile.content) as Partial<PackageJson>;
    pkg = {
      ...parsed,
      dependencies: (parsed.dependencies && typeof parsed.dependencies === 'object') ? parsed.dependencies : {},
      devDependencies: (parsed.devDependencies && typeof parsed.devDependencies === 'object') ? parsed.devDependencies : {},
    };
  } catch {
    return;
  }

  const allDeclaredDeps = new Set([
    ...Object.keys(pkg.dependencies),
    ...Object.keys(pkg.devDependencies),
  ]);

  const requiredPackages = new Set<string>();

  for (const [, info] of symbolTable) {
    for (const [source] of info.imports) {
      if (isExternalPackage(source)) {
        const pkgName = getPackageName(source);
        if (!NODE_BUILTINS.has(pkgName)) {
          requiredPackages.add(pkgName);
        }
      }
    }
  }

  const DEV_PACKAGES = new Set([
    '@vitejs/plugin-react', 'vite', 'typescript', 'tailwindcss', 'postcss', 'autoprefixer',
    '@types/react', '@types/react-dom', '@types/node', '@types/express', '@types/cors',
    'vitest', '@testing-library/react', '@testing-library/jest-dom', '@testing-library/user-event',
    'jsdom', 'drizzle-kit', 'tsx', '@types/pg', '@types/bcryptjs', '@types/passport',
    '@types/cookie-parser', '@types/morgan', '@types/compression', '@types/multer',
    '@types/passport-local', '@types/express-session', '@types/connect-pg-simple',
  ]);

  let modified = false;

  for (const pkgName of requiredPackages) {
    if (allDeclaredDeps.has(pkgName)) continue;

    const version = availableDeps[pkgName];
    if (!version) continue;

    if (DEV_PACKAGES.has(pkgName)) {
      pkg.devDependencies[pkgName] = version;
    } else {
      pkg.dependencies[pkgName] = version;
    }
    fixes.push(`[linker] Added "${pkgName}": "${version}" to package.json`);
    modified = true;
  }

  if (modified) {
    pkg.dependencies = Object.fromEntries(
      Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b))
    );
    pkg.devDependencies = Object.fromEntries(
      Object.entries(pkg.devDependencies).sort(([a], [b]) => a.localeCompare(b))
    );
    pkgFile.content = JSON.stringify(pkg, null, 2);
  }
}

function fixSchemaImports(
  fileMap: Map<string, GeneratedFile>,
  symbolTable: SymbolTable,
  fixes: string[]
): void {
  const schemaPath = findFileByPath('shared/schema', fileMap);
  if (!schemaPath) return;

  const schemaFile = fileMap.get(schemaPath);
  if (!schemaFile) return;

  const schemaExports = symbolTable.get(schemaPath)?.exports || new Set();

  for (const [filePath, info] of symbolTable) {
    if (filePath === schemaPath) continue;

    for (const [source, names] of info.imports) {
      const resolved = resolveImportPath(source, filePath);
      const resolvedFile = findFileByPath(resolved, fileMap);
      if (resolvedFile !== schemaPath) continue;

      const missingNames: string[] = [];
      for (const name of names) {
        if (name === '*' || name === 'type') continue;
        if (!schemaExports.has(name) && !caseInsensitiveMatch(name, schemaExports)) {
          missingNames.push(name);
        }
      }

      if (missingNames.length === 0) continue;

      const file = fileMap.get(filePath);
      if (!file) continue;

      const validNames = [...names].filter(n => !missingNames.includes(n));

      if (validNames.length === 0) {
        file.content = file.content.replace(
          new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\}\\s+from\\s+['"]${escapeRegex(source)}['"];?\\n?`),
          ''
        );
        fixes.push(`[linker] Removed broken schema import in ${filePath} (missing: ${missingNames.join(', ')})`);
      } else {
        const importRegex = new RegExp(
          `(import\\s+(?:type\\s+)?)\\{[^}]*\\}(\\s+from\\s+['"]${escapeRegex(source)}['"])`
        );
        file.content = file.content.replace(importRegex, `$1{ ${validNames.join(', ')} }$2`);
        fixes.push(`[linker] Fixed schema import in ${filePath}: removed ${missingNames.join(', ')}`);
      }

      symbolTable.set(filePath, {
        exports: symbolTable.get(filePath)!.exports,
        imports: extractImportsFromContent(file.content),
      });
    }
  }
}

function fixUIComponentImports(
  fileMap: Map<string, GeneratedFile>,
  symbolTable: SymbolTable,
  fixes: string[]
): void {
  for (const [filePath, info] of symbolTable) {
    for (const [source, names] of info.imports) {
      const resolved = resolveImportPath(source, filePath);

      let registryPath: string | undefined;
      for (const regPath of Object.keys(UI_COMPONENT_REGISTRY)) {
        const resolvedReg = regPath.replace(/\.\w+$/, '');
        const resolvedSrc = resolved.replace(/\.\w+$/, '');
        if (resolvedReg === resolvedSrc || regPath === resolved) {
          registryPath = regPath;
          break;
        }
      }
      if (!registryPath) continue;

      const allowedExports = new Set(UI_COMPONENT_REGISTRY[registryPath]);

      const badNames: string[] = [];
      for (const name of names) {
        if (name === '*' || name === 'type') continue;
        if (!allowedExports.has(name)) {
          badNames.push(name);
        }
      }

      if (badNames.length === 0) continue;

      const targetFilePath = findFileByPath(resolved, fileMap);
      if (targetFilePath) {
        const targetFile = fileMap.get(targetFilePath);
        if (targetFile) {
          const targetExports = symbolTable.get(targetFilePath)?.exports || new Set();
          const actuallyBad = badNames.filter(name => !targetExports.has(name));
          badNames.length = 0;
          badNames.push(...actuallyBad);
        }
      }

      if (badNames.length === 0) continue;

      const file = fileMap.get(filePath);
      if (!file) continue;

      const validNames = [...names].filter(n => !badNames.includes(n));

      if (validNames.length === 0) {
        file.content = file.content.replace(
          new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\}\\s+from\\s+['"]${escapeRegex(source)}['"];?\\n?`),
          ''
        );
        fixes.push(`[linker] Removed invalid UI import in ${filePath} from ${source}`);
      } else {
        const importRegex = new RegExp(
          `(import\\s+(?:type\\s+)?)\\{[^}]*\\}(\\s+from\\s+['"]${escapeRegex(source)}['"])`
        );
        file.content = file.content.replace(importRegex, `$1{ ${validNames.join(', ')} }$2`);
        fixes.push(`[linker] Fixed UI import in ${filePath}: removed ${badNames.join(', ')} from ${source}`);
      }
    }
  }
}

function caseInsensitiveMatch(name: string, exports: Set<string>): boolean {
  const lower = name.toLowerCase();
  for (const exp of exports) {
    if (exp.toLowerCase() === lower) return true;
  }
  return false;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fixBrokenLocalImports(
  fileMap: Map<string, GeneratedFile>,
  symbolTable: SymbolTable,
  fixes: string[]
): void {
  for (const [filePath, info] of symbolTable) {
    const file = fileMap.get(filePath);
    if (!file) continue;

    for (const [source, names] of info.imports) {
      if (isExternalPackage(source)) continue;

      const resolved = resolveImportPath(source, filePath);
      const targetPath = findFileByPath(resolved, fileMap);
      if (!targetPath) continue;

      const targetExports = symbolTable.get(targetPath)?.exports;
      if (!targetExports || targetExports.size === 0) continue;

      const namedImportMatch = file.content.match(
        new RegExp(`import\\s+(?:type\\s+)?\\{([^}]+)\\}\\s+from\\s+['"]${escapeRegex(source)}['"]`)
      );
      if (!namedImportMatch) continue;

      const namedImports = namedImportMatch[1].split(',').map(n => {
        let name = n.trim();
        if (name.startsWith('type ')) name = name.slice(5).trim();
        const asMatch = name.match(/^(\w+)\s+as\s+(\w+)$/);
        return asMatch ? { original: asMatch[1], alias: asMatch[2], raw: n.trim() } : { original: name, alias: null, raw: n.trim() };
      }).filter(n => n.original.length > 0);

      if (namedImports.length === 0) continue;

      const badImports = namedImports.filter(n =>
        !targetExports.has(n.original) && !caseInsensitiveMatch(n.original, targetExports)
      );

      if (badImports.length === 0) continue;

      const validImports = namedImports.filter(n => !badImports.includes(n));

      if (validImports.length === 0) {
        file.content = file.content.replace(
          new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\}\\s+from\\s+['"]${escapeRegex(source)}['"];?\\n?`),
          ''
        );
        fixes.push(`[linker] Removed broken named import in ${filePath} from ${source} (missing: ${badImports.map(b => b.original).join(', ')})`);
      } else {
        const validStr = validImports.map(n => n.raw).join(', ');
        const importRegex = new RegExp(
          `(import\\s+(?:type\\s+)?)\\{[^}]*\\}(\\s+from\\s+['"]${escapeRegex(source)}['"])`
        );
        file.content = file.content.replace(importRegex, `$1{ ${validStr} }$2`);
        fixes.push(`[linker] Fixed named import in ${filePath}: removed ${badImports.map(b => b.original).join(', ')} from ${source}`);
      }

      symbolTable.set(filePath, {
        exports: symbolTable.get(filePath)!.exports,
        imports: extractImportsFromContent(file.content),
      });
    }
  }
}

function fixQueryClientProvider(
  fileMap: Map<string, GeneratedFile>,
  symbolTable: SymbolTable,
  fixes: string[]
): void {
  const appPaths = ['src/App.tsx', 'client/src/App.tsx', 'app/App.tsx'];
  let appFile: GeneratedFile | undefined;
  let appPath: string | undefined;

  for (const p of appPaths) {
    const f = fileMap.get(p);
    if (f) {
      appFile = f;
      appPath = p;
      break;
    }
  }

  if (!appFile || !appPath) return;

  const usesReactQuery = Array.from(symbolTable.values()).some(info => {
    for (const [source] of info.imports) {
      if (source === '@tanstack/react-query') return true;
    }
    return false;
  });

  if (!usesReactQuery) return;
  if (appFile.content.includes('QueryClientProvider')) return;

  const hasQueryClientImport = appFile.content.includes('queryClient');

  if (!hasQueryClientImport) {
    appFile.content = `import { QueryClientProvider } from "@tanstack/react-query";\nimport { queryClient } from "@/lib/queryClient";\n${appFile.content}`;
  } else if (!appFile.content.includes('QueryClientProvider')) {
    appFile.content = `import { QueryClientProvider } from "@tanstack/react-query";\n${appFile.content}`;
  }

  const returnMatch = appFile.content.match(/return\s*\(\s*\n?\s*(<[^>]+>)/);
  const arrowMatch = !returnMatch ? appFile.content.match(/=>\s*\(\s*\n?\s*(<[^>]+>)/) : null;
  const matchToUse = returnMatch || arrowMatch;
  const patternToReplace = returnMatch ? /(return\s*\(\s*\n?\s*)/ : /(=>\s*\(\s*\n?\s*)/;

  if (matchToUse) {
    const outerTag = matchToUse[1];
    if (!outerTag.includes('QueryClientProvider')) {
      appFile.content = appFile.content.replace(
        patternToReplace,
        `$1<QueryClientProvider client={queryClient}>\n      `
      );
      const lastClosingParen = appFile.content.lastIndexOf(');');
      if (lastClosingParen > 0) {
        const beforeParen = appFile.content.lastIndexOf('\n', lastClosingParen);
        if (beforeParen > 0) {
          const indent = appFile.content.slice(beforeParen + 1, lastClosingParen).replace(/\S.*/g, '');
          appFile.content = appFile.content.slice(0, lastClosingParen) +
            `${indent}</QueryClientProvider>\n${indent}` +
            appFile.content.slice(lastClosingParen);
        }
      }
    }
  }

  fixes.push(`[linker] Wrapped App.tsx with QueryClientProvider`);
  symbolTable.set(appPath, {
    exports: extractExportsFromContent(appFile.content),
    imports: extractImportsFromContent(appFile.content),
  });
}

function fixMissingReactImports(
  fileMap: Map<string, GeneratedFile>,
  fixes: string[]
): void {
  const hookNames = ['useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useContext', 'useReducer', 'useId', 'useLayoutEffect'];

  for (const [filePath, file] of fileMap) {
    if (!filePath.endsWith('.tsx') && !filePath.endsWith('.jsx')) continue;

    const hasReactImport = /import\s+.*\bfrom\s+['"]react['"]/.test(file.content);
    if (hasReactImport) continue;

    const usedHooks: string[] = [];
    for (const hook of hookNames) {
      if (new RegExp(`\\b${hook}\\s*[(<]`).test(file.content)) {
        usedHooks.push(hook);
      }
    }

    const needsReact = usedHooks.length > 0 ||
      /\bforwardRef\b/.test(file.content) ||
      /\bcreateContext\b/.test(file.content);

    if (!needsReact) continue;

    const imports = [...usedHooks];
    if (/\bforwardRef\b/.test(file.content)) imports.push('forwardRef');
    if (/\bcreateContext\b/.test(file.content)) imports.push('createContext');

    const importLine = `import { ${imports.join(', ')} } from 'react';\n`;
    file.content = importLine + file.content;
    fixes.push(`[linker] Added React import to ${filePath}: ${imports.join(', ')}`);
  }
}
