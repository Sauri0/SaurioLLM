import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileHidden } from '../process/spawnHidden.js';

export const MANAGED_OLLAMA_URL = 'http://127.0.0.1:11435';
const RELEASE_URL = 'https://api.github.com/repos/ollama/ollama/releases/latest';
const ASSET_NAME = 'ollama-windows-amd64.zip';
const VERSION = /^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const GIB = 1024 ** 3;

async function removeStagingDirectory(root: string, stage: string): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(stage));
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith('.install-')) {
    throw new Error('La carpeta temporal está fuera del directorio del motor.');
  }
  await rm(stage, { recursive: true, force: true });
}

export interface EngineInstallState {
  phase: 'missing' | 'checking' | 'downloading' | 'verifying' | 'extracting' | 'installed' | 'cancelled' | 'error';
  version?: string;
  completedBytes: number;
  totalBytes?: number;
  error?: string;
}
export interface EngineRelease { version: string; url: string; size: number; sha256: string }
interface InstallManifest { version: string; directory?: string; sha256: string; installedAt: number }
interface InstallerOptions {
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  freeBytes?: (directory: string) => Promise<number>;
  extract?: (archive: string, target: string, signal: AbortSignal) => Promise<void>;
}

/** Solo selecciona el portable oficial y exige un digest verificable del release. */
export function parseEngineRelease(value: unknown): EngineRelease {
  const release = value as { tag_name?: unknown; assets?: unknown };
  if (typeof release?.tag_name !== 'string' || !VERSION.test(release.tag_name) || !Array.isArray(release.assets)) {
    throw new Error('El catálogo oficial del motor devolvió una versión inválida.');
  }
  const asset = release.assets.find((item: { name?: string }) => item.name === ASSET_NAME) as
    { browser_download_url?: string; digest?: string; size?: number } | undefined;
  const expectedUrl = `https://github.com/ollama/ollama/releases/download/${release.tag_name}/${ASSET_NAME}`;
  if (!asset || asset.browser_download_url !== expectedUrl || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '')
    || !Number.isSafeInteger(asset.size) || (asset.size ?? 0) <= 0) {
    throw new Error('No hay un paquete oficial de Windows con tamaño e integridad verificables.');
  }
  return { version: release.tag_name, url: expectedUrl, size: asset.size!, sha256: asset.digest!.slice(7).toLowerCase() };
}

// Script fijo: rutas por argumentos, nunca interpoladas como código. Rechaza traversal, links y
// archivos fuera del directorio de staging antes de escribirlos; conserva las licencias del ZIP.
const EXTRACT_SCRIPT = String.raw`param([string]$Archive, [string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
$zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('/', '\')
    if ($name.Contains(':') -or [System.IO.Path]::IsPathRooted($name)) { throw 'Ruta absoluta en el paquete' }
    $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $name))
    if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Ruta fuera del paquete' }
    if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Enlace no permitido en el paquete' }
    if ($name.EndsWith('\')) { [System.IO.Directory]::CreateDirectory($full) | Out-Null; continue }
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($full)) | Out-Null
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $full, $false)
  }
} finally { $zip.Dispose() }
`;

export async function extractEngineArchive(archive: string, target: string, signal: AbortSignal): Promise<void> {
  const script = path.join(path.dirname(archive), 'extract-engine.ps1');
  await writeFile(script, EXTRACT_SCRIPT, 'utf8');
  await execFileHidden('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, archive, target], { timeout: 10 * 60_000, signal });
}

/** Descarga bajo demanda. Nunca ejecuta instaladores globales ni cambia el Ollama del usuario. */
export class ManagedOllamaInstaller {
  readonly rootDir: string;
  readonly modelsDir: string;
  private state: EngineInstallState = { phase: 'missing', completedBytes: 0 };
  private controller?: AbortController;
  private task?: Promise<void>;
  private readonly fetchFn: typeof fetch;

  constructor(userDataDir: string, private readonly options: InstallerOptions = {}) {
    this.rootDir = path.join(userDataDir, 'engines', 'ollama');
    this.modelsDir = path.join(userDataDir, 'models', 'ollama');
    this.fetchFn = options.fetchFn ?? fetch;
    const manifest = this.manifest();
    if (manifest) this.state = { phase: 'installed', completedBytes: 0, version: manifest.version };
  }

  private manifest(): InstallManifest | undefined {
    try {
      const value = JSON.parse(readFileSync(path.join(this.rootDir, 'installed.json'), 'utf8')) as InstallManifest;
      if (typeof value.version !== 'string' || !VERSION.test(value.version) || !/^[a-f0-9]{64}$/.test(value.sha256)) return undefined;
      if (value.directory !== undefined && !/^v[0-9A-Za-z.-]+$/.test(value.directory)) return undefined;
      if (!existsSync(path.join(this.rootDir, value.directory ?? value.version, 'ollama.exe'))) return undefined;
      return value;
    } catch { return undefined; }
  }

  executablePath(): string | undefined {
    const manifest = this.manifest();
    return manifest ? path.join(this.rootDir, manifest.directory ?? manifest.version, 'ollama.exe') : undefined;
  }

  status(): EngineInstallState { return { ...this.state }; }
  cancel(): void { this.controller?.abort(); }
  async wait(): Promise<void> { await this.task; }

  start(): EngineInstallState {
    if (this.task) return this.status();
    this.controller = new AbortController();
    this.state = { phase: 'checking', completedBytes: 0 };
    this.task = this.install(this.controller.signal).catch((error: unknown) => {
      this.state = { ...this.state, phase: this.controller?.signal.aborted ? 'cancelled' : 'error',
        error: this.controller?.signal.aborted ? undefined : error instanceof Error ? error.message : String(error) };
    }).finally(() => { this.task = undefined; this.controller = undefined; });
    return this.status();
  }

  private async install(signal: AbortSignal): Promise<void> {
    if ((this.options.platform ?? process.platform) !== 'win32' || (this.options.arch ?? process.arch) !== 'x64') {
      throw new Error('El motor administrado requiere Windows x64. Podés conectar un motor existente o usar un proveedor API.');
    }
    const metadata = await this.fetchFn(RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SaurioLLM' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!metadata.ok) throw new Error(`No se pudo consultar el motor oficial (HTTP ${metadata.status}). Reintentá cuando haya conexión.`);
    const release = parseEngineRelease(await metadata.json());
    this.state = { phase: 'checking', completedBytes: 0, totalBytes: release.size, version: release.version };
    await mkdir(this.rootDir, { recursive: true });
    const previous = this.manifest();
    if (previous?.version === release.version && previous.sha256 === release.sha256) {
      this.state = { phase: 'installed', version: previous.version, completedBytes: 0 };
      return;
    }
    const free = this.options.freeBytes ? await this.options.freeBytes(this.rootDir)
      : await statfs(this.rootDir).then((space) => space.bavail * space.bsize);
    if (free < release.size + 5 * GIB) throw new Error('No hay espacio suficiente: reservá el tamaño de descarga más 5 GB para preparar el motor. El modelo necesita espacio adicional.');
    const stage = await mkdtemp(path.join(this.rootDir, '.install-'));
    try {
      const archive = path.join(stage, 'engine.zip');
      const extracted = path.join(stage, 'unpacked');
      await mkdir(extracted);
      this.state.phase = 'downloading';
      const response = await this.fetchFn(release.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(2 * 60 * 60_000)]) });
      if (!response.ok || !response.body) throw new Error(`No se pudo descargar el motor (HTTP ${response.status}).`);
      const hash = createHash('sha256');
      const handle = await open(archive, 'wx');
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          this.state.completedBytes += chunk.byteLength;
          if (this.state.completedBytes > release.size) throw new Error('La descarga excede el tamaño oficial; se descartó.');
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
      } finally { await handle.close(); }
      this.state.phase = 'verifying';
      if (this.state.completedBytes !== release.size || hash.digest('hex') !== release.sha256) {
        throw new Error('La descarga no pasó la verificación de integridad. Reintentá para obtener una copia completa.');
      }
      signal.throwIfAborted();
      this.state.phase = 'extracting';
      await (this.options.extract ?? extractEngineArchive)(archive, extracted, signal);
      signal.throwIfAborted();
      if (!existsSync(path.join(extracted, 'ollama.exe'))) throw new Error('El paquete no contiene el motor esperado.');
      const directory = `${release.version}-${randomUUID()}`;
      const destination = path.join(this.rootDir, directory);
      // No reemplazar una instalación anterior: cambio de versión atómico mediante el manifiesto.
      await rename(extracted, destination);
      await mkdir(this.modelsDir, { recursive: true });
      const manifest: InstallManifest = { version: release.version, directory, sha256: release.sha256, installedAt: Date.now() };
      const temporaryManifest = path.join(stage, 'installed.json');
      await writeFile(temporaryManifest, JSON.stringify(manifest), 'utf8');
      signal.throwIfAborted();
      await rename(temporaryManifest, path.join(this.rootDir, 'installed.json'));
      this.state = { phase: 'installed', version: release.version, totalBytes: release.size, completedBytes: release.size };
    } finally {
      await removeStagingDirectory(this.rootDir, stage);
    }
  }
}
