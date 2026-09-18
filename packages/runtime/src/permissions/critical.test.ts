// Tests de comandos críticos y bloqueos de git — doc 06 §5.
import { describe, expect, it } from 'vitest';
import { commandParser } from './command-parser.js';
import { hasProtectedPathTarget, isBlockedByDefault, isCriticalCommand } from './critical.js';

function parse(raw: string) {
  return commandParser.parse(raw, 'pwsh');
}

describe('isCriticalCommand', () => {
  const critical = [
    'Remove-Item C:\\ -Recurse',
    'Remove-Item ~ -Recurse -Force',
    'Remove-Item .. -Recurse',
    'rm -rf /',
    'rm -rf ..',
    'rm -rf ../..',
    'git push --force',
    'git push --force-with-lease',
    'Format-Volume -DriveLetter D',
    'diskpart',
    // hallazgo #3: abreviaturas de -Recurse y alias de Remove-Item / cmd.exe.
    'Remove-Item -r C:\\',
    'Remove-Item -Rec ~',
    'ri -Recurse C:\\',
    'rd /s /q C:\\',
    'rmdir /s /q C:\\',
    'del /f /s /q C:\\',
    'erase /s /q C:\\',
  ];
  it.each(critical)('%s es crítico', (raw) => {
    expect(isCriticalCommand(parse(raw))).toBe(true);
  });

  const notCritical = [
    'Remove-Item dist -Recurse',        // subdirectorio del proyecto, no raíz/home/padres
    'rm -rf dist',
    'rm file.txt',                       // sin -rf, no es "recursivo"
    'git push origin main',              // push simple, no --force (categoría git_push separada)
    'npm test',
  ];
  it.each(notCritical)('%s NO es crítico', (raw) => {
    expect(isCriticalCommand(parse(raw))).toBe(false);
  });
});

describe('isBlockedByDefault', () => {
  it('git reset --hard sin paths: bloqueado', () => {
    expect(isBlockedByDefault(parse('git reset --hard'), new Set())).toBe(true);
  });

  it('git checkout -- <path> tocado por el run: no bloqueado', () => {
    const touched = new Set(['src/app.ts']);
    expect(isBlockedByDefault(parse('git checkout -- src/app.ts'), touched)).toBe(false);
  });

  it('git checkout -- <path> NO tocado por el run: bloqueado', () => {
    expect(isBlockedByDefault(parse('git checkout -- src/app.ts'), new Set())).toBe(true);
  });

  it('git clean sin paths: bloqueado', () => {
    expect(isBlockedByDefault(parse('git clean -fd'), new Set())).toBe(true);
  });

  it('git remote add: siempre bloqueado', () => {
    expect(isBlockedByDefault(parse('git remote add origin https://example.com'), new Set(['x']))).toBe(true);
  });

  it('modificar .git/config: siempre bloqueado', () => {
    expect(isBlockedByDefault(parse('git config --file .git/config user.name x'), new Set())).toBe(true);
  });

  it('git status: no bloqueado (no es una operación guardada)', () => {
    expect(isBlockedByDefault(parse('git status'), new Set())).toBe(false);
  });
});

describe('hasProtectedPathTarget (hallazgo #4: run_command borrando protected paths)', () => {
  const protectedTargets = [
    'Remove-Item .git/config',
    'rm -rf .git',
    'del .env',
    'rm .env.local',
    'Remove-Item id_rsa',
    'rm secrets/id_rsa.pub',
    'del server.pem',
    'rm .saurio/state.json',
  ];
  it.each(protectedTargets)('%s -> protegido', (raw) => {
    expect(hasProtectedPathTarget(parse(raw))).toBe(true);
  });

  const notProtected = [
    'rm dist/app.js',
    'del build\\output.txt',
    'npm test',
    'rm envfile.txt',       // no matchea el patrón .env* (no empieza con .env)
  ];
  it.each(notProtected)('%s -> no protegido', (raw) => {
    expect(hasProtectedPathTarget(parse(raw))).toBe(false);
  });
});
