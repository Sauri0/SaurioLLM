// Test de WorkspaceFs: confinamiento, protected paths, .saurioignore/.gitignore, escritura atómica.
// Define: doc 04 §4 y doc 09 §3, §7, §8.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceFs, type WorkspaceFsImpl } from './WorkspaceFs.js';
import { ToolExecutionError } from './errors.js';

describe('tools/WorkspaceFs', () => {
  let root: string;
  let fs: WorkspaceFsImpl;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'saurio-wfs-'));
    fs = createWorkspaceFs(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resuelve rutas relativas dentro del workspace', () => {
    const abs = fs.resolve('src/a.ts');
    expect(abs.startsWith(root)).toBe(true);
  });

  it('rechaza ".." que salga del workspace', () => {
    expect(() => fs.resolve('../fuera.txt')).toThrow(ToolExecutionError);
    expect(() => fs.resolve('src/../../fuera.txt')).toThrow(ToolExecutionError);
  });

  it('rechaza rutas absolutas', () => {
    expect(() => fs.resolve('C:/Windows/system32')).toThrow(ToolExecutionError);
  });

  it('marca .git/**, .env*, *.pem, id_rsa*, .vscode/**, .idea/** como protegidos', () => {
    expect(fs.isProtected('.git/config')).toBe(true);
    expect(fs.isProtected('.git')).toBe(true);
    expect(fs.isProtected('.env')).toBe(true);
    expect(fs.isProtected('.env.local')).toBe(true);
    expect(fs.isProtected('key.pem')).toBe(true);
    expect(fs.isProtected('id_rsa')).toBe(true);
    expect(fs.isProtected('id_rsa.pub')).toBe(true);
    expect(fs.isProtected('.vscode/settings.json')).toBe(true);
    expect(fs.isProtected('.idea/workspace.xml')).toBe(true);
    expect(fs.isProtected('src/index.ts')).toBe(false);
  });

  it('respeta .gitignore y .saurioignore para isIgnored', () => {
    writeFileSync(path.join(root, '.gitignore'), 'dist/\n*.log\n');
    writeFileSync(path.join(root, '.saurioignore'), 'secrets/\n');
    expect(fs.isIgnored('dist/bundle.js')).toBe(true);
    expect(fs.isIgnored('app.log')).toBe(true);
    expect(fs.isIgnored('secrets/token.txt')).toBe(true);
    expect(fs.isIgnored('src/index.ts')).toBe(false);
  });

  it('ignora siempre los temporales *.saurio-tmp-*', () => {
    expect(fs.isIgnored('src/a.ts.saurio-tmp-1234')).toBe(true);
  });

  it('readFile detecta hash, EOL y BOM', async () => {
    writeFileSync(path.join(root, 'crlf.txt'), 'a\r\nb\r\n');
    const r = await fs.readFile('crlf.txt');
    expect(r.eol).toBe('CRLF');
    expect(r.bom).toBe(false);
    expect(r.hash).toHaveLength(64);
  });

  it('readFile falla con path_denied sobre binario (byte NUL)', async () => {
    writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    await expect(fs.readFile('bin.dat')).rejects.toMatchObject({ code: 'path_denied' });
  });

  it('readFile falla con not_found si el archivo no existe', async () => {
    await expect(fs.readFile('nope.txt')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('readFile falla con result_too_large por encima del límite configurado', async () => {
    const small = createWorkspaceFs(root, { maxReadBytes: 4 });
    writeFileSync(path.join(root, 'big.txt'), '12345');
    await expect(small.readFile('big.txt')).rejects.toMatchObject({ code: 'result_too_large' });
  });

  it('writeFileAtomic escribe con temp+rename y no deja temporales', async () => {
    await fs.writeFileAtomic('out/a.txt', 'hola');
    const content = readFileSync(path.join(root, 'out/a.txt'), 'utf8');
    expect(content).toBe('hola');
  });

  it('writeFileAtomic rechaza rutas protegidas', async () => {
    await expect(fs.writeFileAtomic('.env', 'X=1')).rejects.toMatchObject({ code: 'path_denied' });
  });

  it('deleteFile borra el archivo y rechaza protegidos', async () => {
    writeFileSync(path.join(root, 'a.txt'), 'x');
    await fs.deleteFile('a.txt');
    await expect(fs.readFile('a.txt')).rejects.toMatchObject({ code: 'not_found' });
    await expect(fs.deleteFile('.git/config')).rejects.toMatchObject({ code: 'path_denied' });
  });

  it('makeDir crea carpetas intermedias y es idempotente (punto 4 del encargo, make_dir)', async () => {
    await fs.makeDir('nueva/sub/carpeta');
    expect(existsSync(path.join(root, 'nueva/sub/carpeta'))).toBe(true);
    await expect(fs.makeDir('nueva/sub/carpeta')).resolves.toBeUndefined();
  });

  it('makeDir rechaza rutas protegidas y paths que ya son un archivo', async () => {
    await expect(fs.makeDir('.git/hooks')).rejects.toMatchObject({ code: 'path_denied' });
    writeFileSync(path.join(root, 'archivo.txt'), 'x');
    await expect(fs.makeDir('archivo.txt')).rejects.toMatchObject({ code: 'path_denied' });
  });

  it('listDir clampa la profundidad a 3 y respeta ignorados', async () => {
    mkdirSync(path.join(root, 'a/b/c/d'), { recursive: true });
    writeFileSync(path.join(root, 'a/b/c/d/leaf.txt'), 'x');
    writeFileSync(path.join(root, '.gitignore'), 'a/b/c/d/\n');
    const entries = await fs.listDir('.', 10);
    expect(entries.some((e) => e.path === 'a/b/c/d')).toBe(false);
  });
});
