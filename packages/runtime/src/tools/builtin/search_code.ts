// Tool builtin search_code(query, glob?, max_results?) — packages/runtime/src/tools/builtin/search_code.ts.
// Define: doc 07 §3 (rg --json, respeta .gitignore, límite duro max_results<=50, "N resultados más;
// refiná la búsqueda") y columna vertebral §1.2 fila "Búsqueda" (@vscode/ripgrep, rg --json/--files).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';

const ArgsSchema = z.object({
  query: z.coerce.string().min(1),
  glob: z.coerce.string().optional(),
  max_results: z.coerce.number().int().min(1).max(50).optional(),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

interface RgMatch { path: string; line: number; text: string }

interface RgJsonMatch {
  type: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

function runRipgrep(cwd: string, query: string, glob: string | undefined, saurioIgnorePath: string | undefined, signal: AbortSignal): Promise<RgMatch[]> {
  return new Promise((resolve, reject) => {
    // --no-require-git: .gitignore se respeta aunque el workspace no tenga .git todavía
    // (doc 07 §3: "rg --files, respeta .gitignore de forma nativa"), sin exigir un repo real.
    const args = ['--json', '--hidden', '--no-messages', '--no-require-git'];
    if (glob) args.push('--glob', glob);
    if (saurioIgnorePath) args.push('--ignore-file', saurioIgnorePath);
    args.push('--', query, '.');
    const child = spawn(rgPath, args, { cwd, windowsHide: true, signal });
    const matches: RgMatch[] = [];
    let buf = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as RgJsonMatch;
          if (evt.type === 'match' && evt.data?.path?.text && evt.data.line_number !== undefined) {
            matches.push({
              path: evt.data.path.text,
              line: evt.data.line_number,
              text: (evt.data.lines?.text ?? '').replace(/\r?\n$/, ''),
            });
          }
        } catch {
          // línea NDJSON incompleta o de otro tipo (begin/end/summary): se ignora.
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      // rg devuelve 1 cuando no hay matches: no es un error.
      if (code === 0 || code === 1) resolve(matches);
      else reject(new Error(`ripgrep terminó con código ${code}: ${stderr}`));
    });
  });
}

export function createSearchCodeTool(deps: BuiltinToolsDeps): ToolDefinition<Args> {
  return {
    name: 'search_code',
    description: 'Busca un patrón de texto en el código del workspace (rg --json, respeta .gitignore/.saurioignore).',
    inputSchema: z.toJSONSchema(ArgsSchema),
    argsSchema: ArgsSchema,
    category: 'read',
    mutating: false,
    idempotent: true,
    allowedInModes: ['plan', 'ask', 'edit', 'agent'],
    source: { kind: 'builtin' },
    async handler(args: Args, ctx: ToolContext) {
      const cap = Math.min(args.max_results ?? deps.maxSearchResults, deps.maxSearchResults);
      const saurioIgnore = path.join(ctx.projectRoot, '.saurioignore');
      const matches = await runRipgrep(ctx.projectRoot, args.query, args.glob, saurioIgnore, ctx.signal);
      const truncated = matches.length > cap;
      const shown = matches.slice(0, cap);
      const byFile = new Map<string, RgMatch[]>();
      for (const m of shown) {
        const list = byFile.get(m.path) ?? [];
        list.push(m);
        byFile.set(m.path, list);
      }
      const lines: string[] = [];
      for (const [file, ms] of byFile) {
        lines.push(`${file}:`);
        for (const m of ms) lines.push(`  ${m.line}: ${m.text}`);
      }
      if (truncated) lines.push(`\n… ${matches.length - cap} resultados más; refiná la búsqueda`);
      return {
        content: [{ type: 'text', text: shown.length > 0 ? lines.join('\n') : '(sin resultados)' }],
        isError: false,
        structured: shown,
        truncated,
      };
    },
  };
}
