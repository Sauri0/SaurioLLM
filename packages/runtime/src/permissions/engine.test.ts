// Tests de PermissionEngine.evaluate — doc 06 §2 (defaults), §5 (invariantes), §6 (algoritmo).
import { describe, expect, it } from 'vitest';
import type { PermissionDecision } from '@saurio/shared';
import { DefaultPermissionEngine, type EvaluateCall } from './engine.js';
import type { PermissionPolicy, PermissionRule } from './types.js';

function policy(rules: PermissionRule[] = [], preset: PermissionPolicy['preset'] = 'balanced', terminalAllowlist: string[] = []): PermissionPolicy {
  return { preset, rules, terminalAllowlist };
}

function call(partial: Partial<EvaluateCall> & Pick<EvaluateCall, 'category' | 'toolName'>): EvaluateCall {
  return { risk: 'low', summary: 's', toolCallId: 'tc1', ...partial };
}

function decisionKind(d: PermissionDecision): 'allow' | 'deny' | 'ask' {
  return d.decision;
}

const engine = new DefaultPermissionEngine();

describe('defaults por categoría (preset balanced)', () => {
  const rows: [category: EvaluateCall['category'], toolName: string, expected: 'allow' | 'ask'][] = [
    ['read', 'read_file', 'allow'],
    ['write', 'edit_file', 'allow'],   // decisión del usuario 2026-09-18: write = allow en workspace
    ['delete', 'delete_file', 'ask'],
    ['git_commit', 'run_command', 'ask'],
    ['network', 'run_command', 'ask'],
    ['mcp', 'mcp__server__tool', 'ask'],
  ];
  it.each(rows)('%s (%s) -> %s por default', (category, toolName, expected) => {
    const d = engine.evaluate(call({ category, toolName, paths: category === 'write' || category === 'read' || category === 'delete' ? ['src/app.ts'] : undefined }), 'agent', policy());
    expect(decisionKind(d)).toBe(expected);
  });
});

describe('preset strict', () => {
  it('write -> ask (no ofrece allow por default)', () => {
    const d = engine.evaluate(call({ category: 'write', toolName: 'edit_file', paths: ['src/app.ts'] }), 'agent', policy([], 'strict'));
    expect(decisionKind(d)).toBe('ask');
  });
  it('read fuera de src/** -> ask', () => {
    const d = engine.evaluate(call({ category: 'read', toolName: 'read_file', paths: ['docs/readme.md'] }), 'agent', policy([], 'strict'));
    expect(decisionKind(d)).toBe('ask');
  });
  it('read dentro de src/** -> allow', () => {
    const d = engine.evaluate(call({ category: 'read', toolName: 'read_file', paths: ['src/app.ts'] }), 'agent', policy([], 'strict'));
    expect(decisionKind(d)).toBe('allow');
  });
});

describe('preset trusting', () => {
  it('delete -> allow desde el día 1', () => {
    const d = engine.evaluate(call({ category: 'delete', toolName: 'delete_file', paths: ['src/app.ts'] }), 'agent', policy([], 'trusting'));
    expect(decisionKind(d)).toBe('allow');
  });
  it('git_push sigue en ask (invariante, ningún preset lo destraba)', () => {
    const d = engine.evaluate(call({ category: 'git_push', toolName: 'run_command', command: 'git push origin main' }), 'agent', policy([], 'trusting'));
    expect(decisionKind(d)).toBe('ask');
    if (d.decision === 'ask') {
      expect(d.request.rememberOptions).toEqual([]);
      expect(d.request.noAllowOption).toBe(true);
      expect(d.request.forceWarning).toBeUndefined();
    }
  });
});

describe('invariantes (§5)', () => {
  it('escritura en protected path -> deny', () => {
    const d = engine.evaluate(call({ category: 'write', toolName: 'edit_file', paths: ['.env'] }), 'agent', policy());
    expect(decisionKind(d)).toBe('deny');
  });
  it('escritura en protected path anidado -> deny', () => {
    const d = engine.evaluate(call({ category: 'write', toolName: 'write_file', paths: ['.git/config'] }), 'agent', policy());
    expect(decisionKind(d)).toBe('deny');
  });
  it('comando crítico -> ask con noAllowOption real + forceWarning (rememberOptions vacío)', () => {
    const d = engine.evaluate(call({ category: 'delete', toolName: 'run_command', command: 'Remove-Item C:\\ -Recurse' }), 'agent', policy());
    expect(decisionKind(d)).toBe('ask');
    if (d.decision === 'ask') {
      expect(d.request.rememberOptions).toEqual([]);
      expect(d.request.risk).toBe('high');
      expect(d.request.triggeredBy).toMatch(/CRÍTICO/);
      expect(d.request.noAllowOption).toBe(true);
      expect(d.request.forceWarning).toBe(true);
    }
  });
  it('git reset --hard sin paths tocados -> deny (bloqueado por defecto)', () => {
    const d = engine.evaluate(call({ category: 'terminal', toolName: 'run_command', command: 'git reset --hard' }), 'agent', policy());
    expect(decisionKind(d)).toBe('deny');
  });
  it('git reset --hard sobre paths ya tocados por el run -> no bloqueado (cae a ask por git_commit/terminal default)', () => {
    const touched = new Set(['src/app.ts']);
    const d = engine.evaluate(
      call({ category: 'terminal', toolName: 'run_command', command: 'git checkout -- src/app.ts', touchedPaths: touched }),
      'agent', policy(),
    );
    expect(decisionKind(d)).not.toBe('deny');
  });
  it('git push (sin --force) -> ask siempre, sin allow posible', () => {
    const allowPush: PermissionRule = { scope: 'global', toolName: '*', pattern: 'git push *', decision: 'allow', source: 'user' };
    const d = engine.evaluate(call({ category: 'git_push', toolName: 'run_command', command: 'git push origin main' }), 'agent', policy([allowPush]));
    expect(decisionKind(d)).toBe('ask');
  });
});

describe('modo -> deny (hallazgo #1, doc §1: el modo es el primer filtro)', () => {
  const modes: Array<'plan' | 'ask'> = ['plan', 'ask'];
  const deniedRows: Array<EvaluateCall['category']> = ['write', 'delete', 'terminal', 'git_commit', 'git_push', 'network'];

  for (const mode of modes) {
    it.each(deniedRows)(`modo ${mode}: categoría %s -> deny aunque el preset la permita (trusting)`, (category) => {
      const d = engine.evaluate(
        call({ category, toolName: category === 'write' ? 'edit_file' : 'run_command', paths: ['src/app.ts'], command: 'echo hola' }),
        mode, policy([], 'trusting'),
      );
      expect(decisionKind(d)).toBe('deny');
      if (d.decision === 'deny') expect(d.reason).toBe('mode_denied');
    });

    it(`modo ${mode}: read sigue permitido`, () => {
      const d = engine.evaluate(call({ category: 'read', toolName: 'read_file', paths: ['src/app.ts'] }), mode, policy());
      expect(decisionKind(d)).toBe('allow');
    });
  }

  it('modo agent: no aplica el corte por modo (comportamiento previo intacto)', () => {
    const d = engine.evaluate(call({ category: 'write', toolName: 'edit_file', paths: ['src/app.ts'] }), 'agent', policy());
    expect(decisionKind(d)).toBe('allow');
  });
});

describe('invariantes: protected path también cubre delete y run_command (hallazgo #4)', () => {
  it('delete_file sobre protected path -> deny (antes solo write lo cubría)', () => {
    const d = engine.evaluate(call({ category: 'delete', toolName: 'delete_file', paths: ['.env'] }), 'agent', policy());
    expect(decisionKind(d)).toBe('deny');
    if (d.decision === 'deny') expect(d.reason).toBe('protected_path');
  });

  it('run_command borrando .git (directorio) -> deny protected_path (no depende del bloqueo de git config/hooks)', () => {
    const d = engine.evaluate(call({ category: 'delete', toolName: 'run_command', command: 'rm -rf .git' }), 'agent', policy());
    expect(decisionKind(d)).toBe('deny');
    if (d.decision === 'deny') expect(d.reason).toBe('protected_path');
  });

  it('run_command borrando .env -> deny incluso con regla allow amplia', () => {
    const rules: PermissionRule[] = [{ scope: 'global', toolName: '*', pattern: '*', decision: 'allow', source: 'user' }];
    const d = engine.evaluate(call({ category: 'delete', toolName: 'run_command', command: 'rm -rf .env' }), 'agent', policy(rules));
    expect(decisionKind(d)).toBe('deny');
  });
});

describe('reglas: prioridad deny > ask > allow dentro de un mismo nivel', () => {
  it('una regla deny en el mismo nivel gana aunque otra diga allow', () => {
    const rules: PermissionRule[] = [
      { scope: 'project', toolName: 'edit_file', pattern: 'src/**', decision: 'allow', source: 'user' },
      { scope: 'project', toolName: 'edit_file', pattern: 'src/secrets/**', decision: 'deny', source: 'user' },
    ];
    const d = engine.evaluate(call({ category: 'write', toolName: 'edit_file', paths: ['src/secrets/key.ts'] }), 'agent', policy(rules));
    expect(decisionKind(d)).toBe('deny');
  });

  it('ask gana sobre allow si no hay deny', () => {
    const rules: PermissionRule[] = [
      { scope: 'project', toolName: 'edit_file', pattern: 'src/**', decision: 'allow', source: 'user' },
      { scope: 'project', toolName: 'edit_file', pattern: 'src/**', decision: 'ask', source: 'user' },
    ];
    const d = engine.evaluate(call({ category: 'write', toolName: 'edit_file', paths: ['src/app.ts'] }), 'agent', policy(rules));
    expect(decisionKind(d)).toBe('ask');
  });
});

describe('reglas: orden de scope session > project > global', () => {
  it('una regla session gana sobre una project contradictoria', () => {
    const rules: PermissionRule[] = [
      { scope: 'global', toolName: 'edit_file', pattern: 'src/**', decision: 'allow', source: 'preset' },
      { scope: 'project', toolName: 'edit_file', pattern: 'src/**', decision: 'ask', source: 'settings' },
      { scope: 'session', toolName: 'edit_file', pattern: 'src/**', decision: 'deny', source: 'user' },
    ];
    const d = engine.evaluate(call({ category: 'write', toolName: 'edit_file', paths: ['src/app.ts'] }), 'agent', policy(rules));
    expect(decisionKind(d)).toBe('deny');
  });

  it('sin regla session, gana project sobre global', () => {
    const rules: PermissionRule[] = [
      { scope: 'global', toolName: 'edit_file', pattern: 'src/**', decision: 'allow', source: 'preset' },
      { scope: 'project', toolName: 'edit_file', pattern: 'src/**', decision: 'ask', source: 'settings' },
    ];
    const d = engine.evaluate(call({ category: 'write', toolName: 'edit_file', paths: ['src/app.ts'] }), 'agent', policy(rules));
    expect(decisionKind(d)).toBe('ask');
  });
});

describe('run_command: agregación de subcomandos (doc §3)', () => {
  it('todos los subcomandos con allow -> allow', () => {
    const rules: PermissionRule[] = [
      { scope: 'project', toolName: 'run_command', pattern: 'npm *', decision: 'allow', source: 'user' },
    ];
    const d = engine.evaluate(call({ category: 'terminal', toolName: 'run_command', command: 'npm install; npm test' }), 'agent', policy(rules));
    expect(decisionKind(d)).toBe('allow');
  });

  it('un subcomando sin match de allow -> ask (nunca allow por defecto en caso de duda)', () => {
    const rules: PermissionRule[] = [
      { scope: 'project', toolName: 'run_command', pattern: 'npm *', decision: 'allow', source: 'user' },
    ];
    const d = engine.evaluate(call({ category: 'terminal', toolName: 'run_command', command: 'npm install; pnpm test' }), 'agent', policy(rules));
    expect(decisionKind(d)).toBe('ask');
  });

  it('un subcomando delete sin regla -> el conjunto pasa a ask, aunque el resto matchee allow', () => {
    const rules: PermissionRule[] = [
      { scope: 'project', toolName: 'run_command', pattern: 'npm *', decision: 'allow', source: 'user' },
    ];
    const d = engine.evaluate(call({ category: 'terminal', toolName: 'run_command', command: 'npm test; rm -rf dist' }), 'agent', policy(rules));
    expect(decisionKind(d)).toBe('ask');
  });

  it('comando no confiable (Invoke-Expression) -> ask siempre', () => {
    const rules: PermissionRule[] = [
      { scope: 'global', toolName: '*', pattern: '*', decision: 'allow', source: 'user' },
    ];
    const d = engine.evaluate(call({ category: 'terminal', toolName: 'run_command', command: 'Invoke-Expression "npm test"' }), 'agent', policy(rules));
    expect(decisionKind(d)).toBe('ask');
  });

  it('terminalAllowlist permite un comando sin regla explícita', () => {
    const d = engine.evaluate(
      call({ category: 'terminal', toolName: 'run_command', command: 'npm test' }),
      'agent', policy([], 'balanced', ['npm test']),
    );
    expect(decisionKind(d)).toBe('allow');
  });
});

describe('rememberOptions sugeridas', () => {
  it('run_command sugiere el comando exacto', () => {
    const d = engine.evaluate(call({ category: 'terminal', toolName: 'run_command', command: 'npm test' }), 'agent', policy());
    expect(decisionKind(d)).toBe('ask');
    if (d.decision === 'ask') {
      expect(d.request.rememberOptions).toEqual([
        { scope: 'project', suggestedPattern: 'npm test' },
        { scope: 'global', suggestedPattern: 'npm test' },
      ]);
      // Un ask "normal" (default de categoría, no invariante) nunca marca noAllowOption/forceWarning
      // — esos dos campos son exclusivos de comando crítico / git_push (doc 06 §5).
      expect(d.request.noAllowOption).toBeUndefined();
      expect(d.request.forceWarning).toBeUndefined();
    }
  });

  it('edit_file sugiere el directorio contenedor', () => {
    const d = engine.evaluate(call({ category: 'delete', toolName: 'delete_file', paths: ['src/app/router.ts'] }), 'agent', policy());
    expect(decisionKind(d)).toBe('ask');
    if (d.decision === 'ask') {
      expect(d.request.rememberOptions[0]?.suggestedPattern).toBe('src/app/**');
    }
  });
});
