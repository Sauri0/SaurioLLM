// Registro único de tools (builtin/MCP/delegate) — packages/runtime/src/tools/ToolRegistry.ts.
// Define: doc 04 §4 (interfaz ToolRegistry) y columna vertebral §2.1 principio 8 ("builtin, MCP y
// delegate conviven detrás de la misma interfaz"). Implementa `ToolRegistry` de tools/types.ts.
import type { Mode } from '@saurio/shared';
import type { ToolDefinition, ToolRegistry as ToolRegistryContract } from './types.js';

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export class ToolRegistryImpl implements ToolRegistryContract {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly listeners = new Set<() => void>();

  register(def: ToolDefinition): void {
    if (!NAME_RE.test(def.name)) {
      throw new Error(`nombre de tool inválido: "${def.name}" (debe matchear ${NAME_RE})`);
    }
    this.tools.set(def.name, def);
    this.notify();
  }

  unregister(name: string): void {
    if (this.tools.delete(name)) this.notify();
  }

  list(filter?: { names?: string[]; mode?: Mode }): ToolDefinition[] {
    let out = [...this.tools.values()];
    if (filter?.names) {
      const wanted = new Set(filter.names);
      out = out.filter((t) => wanted.has(t.name));
    }
    if (filter?.mode) {
      out = out.filter((t) => t.allowedInModes.includes(filter.mode as Mode));
    }
    return out;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Match tolerante de nombre (doc 05 §2.5 paso 22): exacto -> case-insensitive -> snake/camel ->
   *  Levenshtein <= 2. Se usa desde los protocolos (parse) cuando el modelo emite un nombre desconocido. */
  resolveTolerant(name: string): ToolDefinition | undefined {
    if (this.tools.has(name)) return this.tools.get(name);
    const lower = name.toLowerCase();
    for (const t of this.tools.values()) if (t.name.toLowerCase() === lower) return t;
    const asSnake = toSnakeCase(name);
    for (const t of this.tools.values()) if (t.name === asSnake) return t;
    let best: { tool: ToolDefinition; dist: number } | undefined;
    for (const t of this.tools.values()) {
      const dist = levenshtein(lower, t.name.toLowerCase());
      if (dist <= 2 && (!best || dist < best.dist)) best = { tool: t, dist };
    }
    return best?.tool;
  }

  onChanged(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }
}

function toSnakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prevDiag + cost);
      prevDiag = temp;
    }
  }
  return dp[n] ?? Math.max(m, n);
}

export function createToolRegistry(): ToolRegistryImpl {
  return new ToolRegistryImpl();
}
