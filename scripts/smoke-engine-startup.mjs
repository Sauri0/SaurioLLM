#!/usr/bin/env node
// Arranque administrado empaquetado sin Ollama global. Copia un portable YA verificado a un
// perfil temporal; no descarga, instala ni ejecuta inferencia. No representa Windows limpio.
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { CdpClient, assertCleanShutdown, stop, waitForRenderedRoot } from './smoke-release-functional.mjs';

const ROOT = resolve('.');
const EXE = resolve('apps/desktop/release/win-unpacked/SaurioLLM.exe');
const DESKTOP_VERSION = JSON.parse(readFileSync(resolve('apps/desktop/package.json'), 'utf8')).version;
const INSTALLER = resolve(`apps/desktop/release/SaurioLLM-Setup-${DESKTOP_VERSION}.exe`);
const SOURCE = resolve('smoke/managed-engine-023');
const OUTPUT = resolve('smoke/engine-startup-023');
const MANAGED_PORT = 11435;
const TIMEOUT = 45_000;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke de arranque administrado: ${message}`);
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolveDone, rejectDone) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', resolveDone);
    stream.once('error', rejectDone);
  });
  return hash.digest('hex');
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  assert(address && typeof address !== 'string', 'no se pudo reservar el puerto CDP');
  return address.port;
}

async function assertPortFree(port, description) {
  const server = createServer();
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, '127.0.0.1', resolveListen);
    });
  } catch (error) {
    throw new Error(`Smoke de arranque administrado: ${description}; no se usará un motor ajeno (${String(error)})`, { cause: error });
  } finally {
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function waitFor(cdp, expression, description, timeout = TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Smoke de arranque administrado: timeout esperando ${description}`);
}

async function waitForDebugger(port, child) {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (child.launchError) throw child.launchError;
    if (child.exitCode !== null) throw new Error(`el .exe terminó antes de abrir CDP (exit ${child.exitCode})`);
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Electron todavía no abrió el inspector.
    }
    await delay(100);
  }
  throw new Error('CDP no respondió');
}

function sanitizedEnvironment(root, profile) {
  const localAppData = join(root, 'localappdata');
  const home = join(root, 'home');
  const temp = join(root, 'temp');
  mkdirSync(localAppData, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(path|saurio_ollama_url|ollama_host|ollama_models|localappdata|appdata|userprofile|home|homedrive|homepath|temp|tmp)$/i.test(key)) delete env[key];
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const safePath = `${join(systemRoot, 'System32')};${systemRoot}`;
  return {
    ...env,
    PATH: safePath,
    Path: safePath,
    LOCALAPPDATA: localAppData,
    APPDATA: join(root, 'appdata'),
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    TEMP: temp,
    TMP: temp,
    SAURIO_USER_DATA: profile,
    SAURIO_NO_UPDATE: '1',
  };
}

async function launchManaged(profile, env) {
  const port = await freePort();
  const child = spawn(EXE, [`--remote-debugging-port=${port}`], { cwd: ROOT, windowsHide: true, stdio: 'ignore', env });
  child.once('error', (error) => { child.launchError = error; });
  let cdp;
  try {
    cdp = new CdpClient(await waitForDebugger(port, child));
    await cdp.ready();
    await waitFor(cdp, 'typeof window.saurio?.invoke === "function"', 'el preload');
    await waitForRenderedRoot(cdp);
    return { child, cdp, port };
  } catch (error) {
    try { await cdp?.close(); } catch { /* cierre de diagnóstico */ }
    if (child.exitCode === null) child.kill();
    throw error;
  }
}

async function healthAndTags() {
  const deadline = Date.now() + TIMEOUT;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const versionResponse = await fetch(`http://127.0.0.1:${MANAGED_PORT}/api/version`, { signal: AbortSignal.timeout(2_000) });
      if (!versionResponse.ok) throw new Error(`health HTTP ${versionResponse.status}`);
      const version = await versionResponse.json();
      const tagsResponse = await fetch(`http://127.0.0.1:${MANAGED_PORT}/api/tags`, { signal: AbortSignal.timeout(2_000) });
      if (!tagsResponse.ok) throw new Error(`tags HTTP ${tagsResponse.status}`);
      const tags = await tagsResponse.json();
      if (!Array.isArray(tags.models) || !tags.models.some((model) => model.name === 'qwen3:0.6b')) {
        throw new Error('el catálogo administrado todavía no mostró qwen3:0.6b');
      }
      return { version: version.version, tags: tags.models.map((model) => model.name) };
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error('el motor administrado no respondió con versión y catálogo a tiempo', { cause: lastError });
}

function engineMode(profile) {
  const settings = JSON.parse(readFileSync(join(profile, 'settings.local.json'), 'utf8'));
  return settings['__global__::engine.mode'];
}

function copyPortable(profile) {
  const engineSource = join(SOURCE, 'engines', 'ollama');
  const modelsSource = join(SOURCE, 'models', 'ollama');
  assert(existsSync(join(engineSource, 'installed.json')), 'no existe el manifiesto portable de fixture');
  assert(existsSync(modelsSource), 'no existe el catálogo local de fixture');
  cpSync(engineSource, join(profile, 'engines', 'ollama'), { recursive: true, dereference: true });
  cpSync(modelsSource, join(profile, 'models', 'ollama'), { recursive: true, dereference: true });
  const manifest = JSON.parse(readFileSync(join(profile, 'engines', 'ollama', 'installed.json'), 'utf8'));
  assert(typeof manifest.version === 'string' && typeof manifest.directory === 'string'
    && existsSync(join(profile, 'engines', 'ollama', manifest.directory, 'ollama.exe')),
  'la copia no preservó el ejecutable indicado por el manifiesto');
  return manifest;
}

function captureFailure(cdp, output) {
  return cdp.call('Page.captureScreenshot', { format: 'png' })
    .then((shot) => writeFileSync(join(output, 'failure.png'), Buffer.from(shot.data, 'base64')))
    .catch(() => undefined);
}

function removeSuccessfulProfile(runPath, profilePath) {
  const child = relative(resolve(runPath), resolve(profilePath));
  assert(child === 'perfil-aislado', 'la limpieza se negó: el perfil no es el directorio aislado de esta corrida');
  rmSync(profilePath, { recursive: true, force: true });
}

assert(existsSync(EXE), `no existe el ejecutable desempaquetado: ${EXE}`);
assert(existsSync(INSTALLER), `no existe el instalador empaquetado: ${INSTALLER}`);
assert(existsSync(join(SOURCE, 'engines', 'ollama', 'installed.json')), `fixture portable ausente: ${SOURCE}`);
mkdirSync(OUTPUT, { recursive: true });
const run = join(OUTPUT, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const profile = join(run, 'perfil-aislado');
mkdirSync(profile, { recursive: true });

let first;
let second;
let completed = false;
const unpackedExecutableSha256 = await sha256(EXE);
const installerSha256 = await sha256(INSTALLER);
const result = { mode: 'packaged', unpackedExecutableSha256, installerSha256, fixture: SOURCE, portableCopiedNoDownload: true, windowsClean: false };
try {
  await assertPortFree(MANAGED_PORT, 'el puerto administrado 11435 ya estaba ocupado antes del smoke');
  const manifest = copyPortable(profile);
  const env = sanitizedEnvironment(run, profile);
  writeFileSync(join(run, 'seed.json'), JSON.stringify({
    source: SOURCE, profile, manifest, portableCopiedNoDownload: true,
    isolation: 'PATH sin directorios Ollama; LOCALAPPDATA, USERPROFILE, HOME, TEMP y SAURIO_USER_DATA aislados.',
  }, null, 2));

  first = await launchManaged(profile, env);
  const initial = await first.cdp.invoke('engine:status', undefined);
  assert(initial.phase === 'installed' && initial.hasManaged === true && initial.mode === 'external',
    `estado inicial inesperado: ${JSON.stringify(initial)}`);
  const selected = await first.cdp.invoke('engine:select', { mode: 'managed' });
  assert(selected.running === true && selected.startedByApp === true, `engine:select no arrancó el motor propio: ${JSON.stringify(selected)}`);
  const firstHealth = await healthAndTags();
  const firstStatus = await first.cdp.invoke('engine:status', undefined);
  assert(firstStatus.mode === 'managed' && firstStatus.phase === 'installed' && firstStatus.hasManaged,
    `estado administrado no quedó seleccionado: ${JSON.stringify(firstStatus)}`);
  assert(engineMode(profile) === 'managed', 'engine.mode no quedó persistido en settings.local.json');
  const firstShutdown = await stop(first);
  first = undefined;
  assertCleanShutdown(firstShutdown, 'primer cierre con motor administrado');
  await assertPortFree(MANAGED_PORT, 'el motor que inició la primera app quedó escuchando después del cierre');

  second = await launchManaged(profile, env);
  const restored = await second.cdp.invoke('engine:status', undefined);
  assert(restored.mode === 'managed' && restored.phase === 'installed' && restored.hasManaged,
    `el modo administrado no sobrevivió al reinicio: ${JSON.stringify(restored)}`);
  const secondHealth = await healthAndTags();
  assert(engineMode(profile) === 'managed', 'engine.mode no persistió después de reabrir');
  const secondShutdown = await stop(second);
  second = undefined;
  assertCleanShutdown(secondShutdown, 'segundo cierre con motor administrado');
  await assertPortFree(MANAGED_PORT, 'el motor que inició la segunda app quedó escuchando después del cierre');

  const engineLog = join(profile, 'logs', 'ollama-serve.log');
  if (existsSync(engineLog)) cpSync(engineLog, join(run, 'ollama-serve.log'));
  Object.assign(result, {
    ok: true,
    manifestVersion: manifest.version,
    firstHealth,
    secondHealth,
    persistedMode: 'managed',
    cleanShutdown: { first: firstShutdown, second: secondShutdown },
    limitation: 'El portable y el catálogo fueron copiados desde un fixture descargado antes. No descarga archivos, no instala Ollama en Windows, no usa un Ollama global y no representa una PC Windows limpia.',
  });
  assert(await sha256(EXE) === unpackedExecutableSha256, 'el ejecutable desempaquetado cambió durante el smoke');
  assert(await sha256(INSTALLER) === installerSha256, 'el instalador cambió durante el smoke');
  writeFileSync(join(run, 'resultado.json'), JSON.stringify(result, null, 2));
  removeSuccessfulProfile(run, profile);
  completed = true;
  console.log(JSON.stringify({ ...result, artifacts: run }, null, 2));
} catch (error) {
  await captureFailure(first?.cdp ?? second?.cdp, run);
  writeFileSync(join(run, 'resultado-fallo.json'), JSON.stringify({
    ...result, ok: false, error: error instanceof Error ? error.message : String(error), profilePreserved: profile,
  }, null, 2));
  throw error;
} finally {
  if (first) await stop(first).catch(() => undefined);
  if (second) await stop(second).catch(() => undefined);
  if (!completed) console.error(`Smoke de arranque administrado falló; se preservó el perfil aislado: ${profile}`);
}
