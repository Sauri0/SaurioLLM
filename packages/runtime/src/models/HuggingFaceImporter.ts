import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { PullProgress } from '../gateway/types.js';

const DEFAULT_MAX_REDIRECTS = 8;
const DEFAULT_TIMEOUT_MS = 4 * 60 * 60_000;
const DEFAULT_MAX_UNKNOWN_BYTES = 100 * 1024 ** 3;
const DEFAULT_PROGRESS_INTERVAL_MS = 1_000;
const DEFAULT_PROGRESS_BYTES = 64 * 1024 ** 2;
const DEFAULT_STALE_STAGE_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_STAGING_SPACE_MULTIPLIER = 2;
const GGUF_MAGIC = Buffer.from('GGUF', 'ascii');
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface HuggingFaceImportInput {
  repoId: string;
  filename: string;
  expectedSize?: number;
  /** Digest LFS publicado por Hugging Face, con o sin el prefijo `sha256:`. */
  expectedSha256?: string;
  /** Nombre final en Ollama. Puede conservar la referencia `hf.co/...`. */
  modelName: string;
  /** URL de un Ollama local, por ejemplo `http://127.0.0.1:11435`. */
  ollamaBaseUrl: string;
  stagingRoot: string;
  signal: AbortSignal;
}

export interface OllamaGgufImportAdapter {
  uploadBlob(input: {
    digest: string;
    filePath: string;
    sizeBytes: number;
    signal: AbortSignal;
  }): Promise<void>;
  createModel(input: {
    modelName: string;
    filename: string;
    digest: string;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface HuggingFaceImporterOptions {
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
  /** Límite de la operación HTTP individual. Incluye consumir su body. */
  requestTimeoutMs?: number;
  /** Tope de seguridad cuando Hugging Face no publicó un tamaño. */
  maxBytes?: number;
  /** Máximo tiempo sin publicar progreso aunque todavía no se alcance `progressBytes`. */
  progressIntervalMs?: number;
  /** Cantidad descargada que fuerza una actualización de progreso. */
  progressBytes?: number;
  /** Reserva conservadora para staging + blob si comparten volumen. Usar 1 sólo si el host sabe que son distintos. */
  stagingSpaceMultiplier?: number;
  /** Edad mínima de un staging de este importador para considerarlo huérfano. */
  staleStageAgeMs?: number;
  freeBytes?: (directory: string) => Promise<number | undefined>;
  ollamaAdapter?: OllamaGgufImportAdapter;
}

export interface HuggingFaceImportResult {
  modelName: string;
  digest: string;
  sizeBytes: number;
}

interface DownloadResult {
  digestHex: string;
  sizeBytes: number;
  publishedDigest?: string;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} debe ser un entero positivo.`);
  return value;
}

function normalizeSha256(value: string | undefined, label = 'SHA-256 esperado'): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/^sha256:/i, '').replace(/^"|"$/g, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${label} no es un SHA-256 válido.`);
  return normalized;
}

function validateRepoId(repoId: string): string[] {
  const parts = repoId.split('/');
  if (parts.length !== 2 || parts.some((part) => !part || part === '.' || part === '..' || !/^[\w.-]+$/.test(part))) {
    throw new Error('El repositorio de Hugging Face debe tener el formato usuario/repositorio.');
  }
  return parts;
}

function validateFilename(filename: string): string[] {
  const parts = filename.split('/');
  if (!filename.toLowerCase().endsWith('.gguf') || parts.some((part) => !part || part === '.' || part === '..')
    || filename.includes('\\') || filename.includes(':')) {
    throw new Error('El archivo de Hugging Face debe ser una ruta relativa válida con extensión .gguf.');
  }
  return parts;
}

function officialDownloadUrl(repoId: string, filename: string): URL {
  const repo = validateRepoId(repoId).map(encodeURIComponent).join('/');
  const file = validateFilename(filename).map(encodeURIComponent).join('/');
  return new URL(`https://huggingface.co/${repo}/resolve/main/${file}`);
}

function isOfficialHuggingFaceHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'huggingface.co' || host.endsWith('.huggingface.co') || host === 'hf.co' || host.endsWith('.hf.co');
}

function assertOfficialDownloadUrl(url: URL): void {
  if (url.protocol !== 'https:' || url.username || url.password || !isOfficialHuggingFaceHost(url.hostname)) {
    throw new Error(`Hugging Face redirigió la descarga a un destino no permitido: ${url.origin}`);
  }
}

function localOllamaBaseUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  if (!local || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('La URL de Ollama debe apuntar a un servidor local sin credenciales ni ruta adicional.');
  }
  return url;
}

function requestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function headerSha256(headers: Headers): string | undefined {
  for (const name of ['x-linked-etag', 'etag']) {
    const value = headers.get(name);
    if (!value) continue;
    const weakless = value.replace(/^W\//i, '');
    try { return normalizeSha256(weakless, `Cabecera ${name}`); } catch { /* Un ETag Git SHA-1 no es un digest LFS. */ }
  }
  return undefined;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.text()).trim().slice(0, 500);
    return body ? `: ${body}` : '';
  } catch {
    return '';
  }
}

async function availableBytes(directory: string): Promise<number | undefined> {
  try {
    const value = await statfs(directory);
    return value.bavail * value.bsize;
  } catch {
    return undefined;
  }
}

async function assertStagingSpace(
  directory: string,
  neededBytes: number,
  probe: (directory: string) => Promise<number | undefined>,
): Promise<void> {
  const free = await probe(directory);
  if (free !== undefined && free < neededBytes) {
    throw new Error(`No hay espacio suficiente en la carpeta temporal para descargar ${neededBytes} bytes.`);
  }
}

function stagingBytes(fileBytes: number, multiplier: number): number {
  const needed = Math.ceil(fileBytes * multiplier);
  if (!Number.isSafeInteger(needed)) throw new Error('El tamaño requerido para staging excede el rango permitido.');
  return needed;
}

async function cleanupStaleStages(root: string, staleAgeMs: number): Promise<void> {
  const cutoff = Date.now() - staleAgeMs;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.hf-import-[\w-]{6,}$/.test(entry.name)) continue;
    const candidate = path.join(root, entry.name);
    try {
      const metadata = await stat(candidate);
      if (metadata.mtimeMs < cutoff) {
        assertOwnedStagingDirectory(root, candidate);
        await rm(candidate, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function fetchOfficialFile(
  initialUrl: URL,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  timeoutMs: number,
  maxRedirects: number,
): Promise<{ response: Response; publishedDigest?: string }> {
  let current = initialUrl;
  let publishedDigest: string | undefined;
  for (let redirects = 0; ; redirects += 1) {
    assertOfficialDownloadUrl(current);
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'SaurioLLM' },
      signal: requestSignal(signal, timeoutMs),
    });
    publishedDigest ??= headerSha256(response.headers);
    if (!REDIRECT_STATUSES.has(response.status)) return { response, publishedDigest };
    await response.body?.cancel();
    if (redirects >= maxRedirects) throw new Error(`La descarga excedió el máximo de ${maxRedirects} redirecciones.`);
    const location = response.headers.get('location');
    if (!location) throw new Error('Hugging Face devolvió una redirección sin destino.');
    current = new URL(location, current);
    assertOfficialDownloadUrl(current);
  }
}

async function* downloadToFile(input: {
  url: URL;
  destination: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  timeoutMs: number;
  maxRedirects: number;
  expectedSize?: number;
  expectedSha256?: string;
  maxBytes: number;
  freeBytes: (directory: string) => Promise<number | undefined>;
  stagingRoot: string;
  progressDigest: string;
  progressIntervalMs: number;
  progressBytes: number;
  stagingSpaceMultiplier: number;
}): AsyncGenerator<PullProgress, DownloadResult> {
  const { response, publishedDigest } = await fetchOfficialFile(
    input.url, input.fetchImpl, input.signal, input.timeoutMs, input.maxRedirects,
  );
  if (!response.ok || !response.body) {
    throw new Error(`No se pudo descargar el archivo de Hugging Face (HTTP ${response.status})${await responseError(response)}.`);
  }
  const lengthHeader = response.headers.get('content-length');
  const contentLength = lengthHeader === null ? undefined : Number(lengthHeader);
  const sizeLimit = input.expectedSize ?? input.maxBytes;
  try {
    if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      throw new Error('Hugging Face devolvió un tamaño de archivo inválido.');
    }
    if (input.expectedSize !== undefined && contentLength !== undefined && contentLength !== input.expectedSize) {
      throw new Error(`El tamaño publicado (${input.expectedSize}) no coincide con la descarga (${contentLength}).`);
    }
    if (contentLength !== undefined && contentLength > sizeLimit) {
      throw new Error(`La descarga excede el límite permitido de ${sizeLimit} bytes.`);
    }
    if (input.expectedSize === undefined && contentLength !== undefined) {
      await assertStagingSpace(
        input.stagingRoot, stagingBytes(contentLength, input.stagingSpaceMultiplier), input.freeBytes,
      );
    }
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw error;
  }

  const effectiveExpectedDigest = input.expectedSha256 ?? publishedDigest;
  const hash = createHash('sha256');
  const firstBytes = Buffer.alloc(GGUF_MAGIC.length);
  let captured = 0;
  let completed = 0;
  let lastReported = 0;
  let lastReportedAt = Date.now();
  const handle = await open(input.destination, 'wx');
  try {
    for await (const chunk of response.body) {
      input.signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      completed += bytes.byteLength;
      if (completed > sizeLimit) throw new Error(`La descarga excede el límite permitido de ${sizeLimit} bytes.`);
      if (captured < firstBytes.length) {
        const take = Math.min(firstBytes.length - captured, bytes.byteLength);
        bytes.copy(firstBytes, captured, 0, take);
        captured += take;
      }
      hash.update(bytes);
      await handle.writeFile(bytes);
      const total = input.expectedSize ?? contentLength;
      const now = Date.now();
      if (completed - lastReported >= input.progressBytes || now - lastReportedAt >= input.progressIntervalMs
        || (total !== undefined && completed === total)) {
        yield { status: 'downloading', digest: input.progressDigest, total, completed };
        lastReported = completed;
        lastReportedAt = now;
      }
    }
  } finally {
    await handle.close();
  }
  if (input.expectedSize !== undefined && completed !== input.expectedSize) {
    throw new Error(`La descarga quedó incompleta: se esperaban ${input.expectedSize} bytes y llegaron ${completed}.`);
  }
  if (contentLength !== undefined && completed !== contentLength) {
    throw new Error(`La descarga quedó incompleta: el servidor anunció ${contentLength} bytes y llegaron ${completed}.`);
  }
  if (captured !== GGUF_MAGIC.length || !firstBytes.equals(GGUF_MAGIC)) {
    throw new Error('El archivo descargado no tiene una cabecera GGUF válida.');
  }
  const digestHex = hash.digest('hex');
  if (effectiveExpectedDigest !== undefined && digestHex !== effectiveExpectedDigest) {
    throw new Error('La descarga no coincide con el SHA-256 publicado por Hugging Face.');
  }
  if (completed !== lastReported) {
    yield {
      status: 'downloading', digest: input.progressDigest,
      total: input.expectedSize ?? contentLength ?? completed, completed,
    };
  }
  return { digestHex, sizeBytes: completed, publishedDigest };
}

async function uploadBlobWithFetch(
  fetchImpl: typeof fetch,
  baseUrl: URL,
  filePath: string,
  digest: string,
  sizeBytes: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const body = createReadStream(filePath, { signal });
  const init = {
    method: 'POST',
    body,
    duplex: 'half',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(sizeBytes) },
    signal: requestSignal(signal, timeoutMs),
  } as unknown as RequestInit & { duplex: 'half' };
  const response = await fetchImpl(new URL(`/api/blobs/${digest}`, baseUrl), init);
  if (response.status !== 201 && !response.ok) {
    throw new Error(`Ollama rechazó el blob (HTTP ${response.status})${await responseError(response)}.`);
  }
  await response.body?.cancel();
}

async function createModelWithFetch(
  fetchImpl: typeof fetch,
  baseUrl: URL,
  modelName: string,
  filename: string,
  digest: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const response = await fetchImpl(new URL('/api/create', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model: modelName, files: { [filename]: digest }, stream: false }),
    signal: requestSignal(signal, timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Ollama no pudo crear el modelo (HTTP ${response.status})${await responseError(response)}.`);
  }
  const result = await response.json().catch(() => undefined) as { status?: unknown; error?: unknown } | undefined;
  if (result?.error !== undefined || result?.status !== 'success') {
    const detail = typeof result?.error === 'string' ? `: ${result.error}` : '';
    throw new Error(`Ollama no confirmó la creación del modelo${detail}.`);
  }
}

function assertOwnedStagingDirectory(root: string, stage: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(stage));
  if (path.isAbsolute(relative) || relative.startsWith('..') || !relative.startsWith('.hf-import-')
    || relative.includes(path.sep)) {
    throw new Error('La carpeta temporal del modelo quedó fuera del staging autorizado.');
  }
}

/**
 * Descarga un GGUF público desde Hugging Face y lo registra en Ollama mediante sus APIs de blobs y
 * create. No ejecuta inferencia, no usa credenciales y no modifica la configuración del motor.
 */
export async function* importHuggingFaceGguf(
  input: HuggingFaceImportInput,
  options: HuggingFaceImporterOptions = {},
): AsyncGenerator<PullProgress, HuggingFaceImportResult> {
  const url = officialDownloadUrl(input.repoId, input.filename);
  validateFilename(input.filename);
  if (!input.modelName.trim()) throw new Error('El nombre final del modelo no puede estar vacío.');
  if (!path.isAbsolute(input.stagingRoot)) throw new Error('La carpeta temporal debe ser una ruta absoluta.');
  const expectedSize = input.expectedSize === undefined ? undefined : positiveSafeInteger(input.expectedSize, 'El tamaño esperado');
  const expectedSha256 = normalizeSha256(input.expectedSha256);
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw new Error('El máximo de redirecciones debe estar entre 0 y 20.');
  }
  const timeoutMs = positiveSafeInteger(options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS, 'El timeout HTTP');
  const maxBytes = positiveSafeInteger(options.maxBytes ?? DEFAULT_MAX_UNKNOWN_BYTES, 'El límite de descarga');
  const progressIntervalMs = positiveSafeInteger(
    options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS, 'El intervalo de progreso',
  );
  const progressBytes = positiveSafeInteger(options.progressBytes ?? DEFAULT_PROGRESS_BYTES, 'El umbral de progreso');
  const stagingSpaceMultiplier = options.stagingSpaceMultiplier ?? DEFAULT_STAGING_SPACE_MULTIPLIER;
  if (!Number.isFinite(stagingSpaceMultiplier) || stagingSpaceMultiplier < 1 || stagingSpaceMultiplier > 2) {
    throw new Error('El multiplicador de espacio temporal debe estar entre 1 y 2.');
  }
  const requestedStaleAgeMs = positiveSafeInteger(
    options.staleStageAgeMs ?? DEFAULT_STALE_STAGE_AGE_MS, 'La antigüedad de staging huérfano',
  );
  // Cada una de las tres requests (descarga, blob y create) tiene su propio timeout. El umbral
  // efectivo evita que otro import concurrente borre una operación válida aunque el host lo amplíe.
  const staleStageAgeMs = Math.max(requestedStaleAgeMs, timeoutMs * 4);
  const fetchImpl = options.fetchImpl ?? fetch;
  const freeBytes = options.freeBytes ?? availableBytes;
  const baseUrl = options.ollamaAdapter ? undefined : localOllamaBaseUrl(input.ollamaBaseUrl);
  const progressDigest = expectedSha256 ? `sha256:${expectedSha256}` : `hf:${input.repoId}/${input.filename}`;

  await mkdir(input.stagingRoot, { recursive: true });
  await cleanupStaleStages(input.stagingRoot, staleStageAgeMs);
  if (expectedSize !== undefined) {
    await assertStagingSpace(
      input.stagingRoot, stagingBytes(expectedSize, stagingSpaceMultiplier), freeBytes,
    );
  }
  const stage = await mkdtemp(path.join(input.stagingRoot, '.hf-import-'));
  assertOwnedStagingDirectory(input.stagingRoot, stage);
  const filePath = path.join(stage, 'model.gguf');
  let latestCompleted = 0;
  let latestTotal = expectedSize;
  try {
    yield { status: 'downloading', digest: progressDigest, total: latestTotal, completed: 0 };
    const download = downloadToFile({
      url,
      destination: filePath,
      fetchImpl,
      signal: input.signal,
      timeoutMs,
      maxRedirects,
      expectedSize,
      expectedSha256,
      maxBytes,
      freeBytes,
      stagingRoot: input.stagingRoot,
      progressDigest,
      progressIntervalMs,
      progressBytes,
      stagingSpaceMultiplier,
    });
    let downloaded: DownloadResult;
    for (;;) {
      const next = await download.next();
      if (next.done) {
        downloaded = next.value;
        break;
      }
      latestCompleted = next.value.completed ?? latestCompleted;
      latestTotal = next.value.total ?? latestTotal;
      yield next.value;
    }
    latestCompleted = downloaded.sizeBytes;
    latestTotal = expectedSize ?? downloaded.sizeBytes;
    yield { status: 'verifying sha256 digest', digest: progressDigest, total: latestTotal, completed: latestCompleted };
    input.signal.throwIfAborted();

    const ollamaDigest = `sha256:${downloaded.digestHex}`;
    yield { status: 'uploading blob', digest: progressDigest, total: latestTotal, completed: latestCompleted };
    if (options.ollamaAdapter) {
      await options.ollamaAdapter.uploadBlob({
        digest: ollamaDigest, filePath, sizeBytes: downloaded.sizeBytes, signal: input.signal,
      });
    } else {
      await uploadBlobWithFetch(
        fetchImpl, baseUrl!, filePath, ollamaDigest, downloaded.sizeBytes, input.signal, timeoutMs,
      );
    }
    input.signal.throwIfAborted();

    yield { status: 'creating model', digest: progressDigest, total: latestTotal, completed: latestCompleted };
    if (options.ollamaAdapter) {
      await options.ollamaAdapter.createModel({
        modelName: input.modelName, filename: input.filename, digest: ollamaDigest, signal: input.signal,
      });
    } else {
      await createModelWithFetch(fetchImpl, baseUrl!, input.modelName, input.filename, ollamaDigest, input.signal, timeoutMs);
    }
    input.signal.throwIfAborted();
    yield { status: 'success', digest: progressDigest, total: latestTotal, completed: latestCompleted };
    return { modelName: input.modelName, digest: ollamaDigest, sizeBytes: downloaded.sizeBytes };
  } finally {
    assertOwnedStagingDirectory(input.stagingRoot, stage);
    await rm(stage, { recursive: true, force: true });
  }
}
