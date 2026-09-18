// Tests de protected paths — doc 06 §5.
import { describe, expect, it } from 'vitest';
import { isProtectedPath } from './protected.js';

describe('isProtectedPath', () => {
  const protectedCases = [
    '.git/config', '.git/hooks/pre-commit', '.saurio/db.sqlite', '.env', '.env.local',
    'server.pem', 'id_rsa', 'id_rsa.pub', '.vscode/settings.json', '.idea/workspace.xml',
    'config/.env.local',
  ];
  it.each(protectedCases)('%s está protegido', (p) => {
    expect(isProtectedPath(p)).toBe(true);
  });

  const openCases = ['src/app/router.ts', 'README.md', 'node_modules/foo/index.js', 'package.json'];
  it.each(openCases)('%s NO está protegido', (p) => {
    expect(isProtectedPath(p)).toBe(false);
  });

  it('node_modules/** no es protected (doc §5: patch-package es un caso legítimo)', () => {
    expect(isProtectedPath('node_modules/.package-lock.json')).toBe(false);
  });
});
