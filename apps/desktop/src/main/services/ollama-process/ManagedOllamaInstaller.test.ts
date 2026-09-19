import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedOllamaInstaller, parseEngineRelease } from './ManagedOllamaInstaller.js';

const body = Buffer.from('verified engine archive');
const digest = createHash('sha256').update(body).digest('hex');
function release(version = 'v0.34.2') {
  return { tag_name: version, assets: [{ name: 'ollama-windows-amd64.zip', size: body.length,
    digest: `sha256:${digest}`, browser_download_url: `https://github.com/ollama/ollama/releases/download/${version}/ollama-windows-amd64.zip` }] };
}
const directories: string[] = [];
async function fixture(options: { corrupt?: boolean; free?: number; version?: string; noExecutable?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'saurio-engine-test-'));
  directories.push(directory);
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes('/releases/latest')
    ? Response.json(release(options.version)) : new Response(options.corrupt ? Buffer.from('corrupt') : body));
  const extract = vi.fn(async (_archive: string, target: string) => {
    if (!options.noExecutable) await writeFile(path.join(target, 'ollama.exe'), 'test executable');
    await writeFile(path.join(target, 'LICENSE'), 'upstream license');
  });
  const installer = new ManagedOllamaInstaller(directory, { platform: 'win32', arch: 'x64', fetchFn,
    freeBytes: async () => options.free ?? 10 * 1024 ** 3, extract });
  return { directory, installer, fetchFn, extract };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const relative = path.relative(os.tmpdir(), directory);
    if (!relative.startsWith('saurio-engine-test-') || relative.includes(path.sep)) throw new Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('official managed engine', () => {
  it('rejects untrusted asset URLs, missing hashes and traversal versions', () => {
    const bad = release();
    bad.assets[0]!.browser_download_url = 'https://example.com/engine.zip';
    expect(() => parseEngineRelease(bad)).toThrow();
    expect(() => parseEngineRelease(release('../escape'))).toThrow();
    const noHash = release(); noHash.assets[0]!.digest = '';
    expect(() => parseEngineRelease(noHash)).toThrow();
    expect(parseEngineRelease(release()).sha256).toBe(digest);
  });
  it('installs verified files and licenses, persists across restart and coalesces requests', async () => {
    const { directory, installer, fetchFn, extract } = await fixture();
    installer.start(); installer.start(); await installer.wait();
    expect(installer.status().phase).toBe('installed');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenCalledTimes(1);
    const restarted = new ManagedOllamaInstaller(directory);
    expect(restarted.executablePath()).toBe(installer.executablePath());
    expect(await readFile(path.join(path.dirname(installer.executablePath()!), 'LICENSE'), 'utf8')).toBe('upstream license');
    expect((await readdir(installer.rootDir)).some((name) => name.startsWith('.install-'))).toBe(false);
    installer.start(); await installer.wait();
    expect(extract).toHaveBeenCalledTimes(1);
  });
  it('rejects corrupted downloads before extraction and cleans staging', async () => {
    const { installer, extract } = await fixture({ corrupt: true });
    installer.start(); await installer.wait();
    expect(installer.status().phase).toBe('error');
    expect(extract).not.toHaveBeenCalled();
    expect(installer.executablePath()).toBeUndefined();
    expect(await readdir(installer.rootDir)).toEqual([]);
  });
  it('checks free space before downloading', async () => {
    const { installer, fetchFn } = await fixture({ free: 100 });
    installer.start(); await installer.wait();
    expect(installer.status().error).toContain('espacio');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('recovers from an orphan version without overwriting it', async () => {
    const { installer } = await fixture();
    const orphan = path.join(installer.rootDir, 'v0.34.2');
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, 'ollama.exe'), 'previous incomplete installation');
    installer.start(); await installer.wait();
    expect(installer.status().phase).toBe('installed');
    expect(await readFile(path.join(orphan, 'ollama.exe'), 'utf8')).toBe('previous incomplete installation');
    expect(installer.executablePath()).not.toBe(path.join(orphan, 'ollama.exe'));
  });
  it('keeps the previous working engine when an update has no executable', async () => {
    const { installer, directory } = await fixture();
    installer.start(); await installer.wait();
    const oldPath = installer.executablePath();
    const updated = new ManagedOllamaInstaller(directory, { platform: 'win32', arch: 'x64', freeBytes: async () => 10 * 1024 ** 3,
      fetchFn: vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes('/releases/latest') ? Response.json(release('v0.34.3')) : new Response(body)),
      extract: async () => undefined });
    updated.start(); await updated.wait();
    expect(updated.status().phase).toBe('error');
    expect(updated.executablePath()).toBe(oldPath);
  });
  it('atomically replaces an existing manifest on this filesystem during a successful update', async () => {
    const { installer, directory } = await fixture();
    installer.start(); await installer.wait();
    const oldPath = installer.executablePath();
    const updated = new ManagedOllamaInstaller(directory, { platform: 'win32', arch: 'x64', freeBytes: async () => 10 * 1024 ** 3,
      fetchFn: vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes('/releases/latest') ? Response.json(release('v0.34.3')) : new Response(body)),
      extract: async (_archive, target) => { await writeFile(path.join(target, 'ollama.exe'), 'new engine'); } });
    updated.start(); await updated.wait();
    expect(updated.status()).toMatchObject({ phase: 'installed', version: 'v0.34.3' });
    expect(updated.executablePath()).not.toBe(oldPath);
    expect(await readFile(oldPath!, 'utf8')).toBe('test executable');
    expect(new ManagedOllamaInstaller(directory).executablePath()).toBe(updated.executablePath());
  });
  it('cancels without making a partial engine executable', async () => {
    const { installer } = await fixture();
    installer.start(); installer.cancel(); await installer.wait();
    expect(installer.status().phase).toBe('cancelled');
    expect(installer.executablePath()).toBeUndefined();
  });
});
