#!/usr/bin/env node
// release-local.mjs — punto 3 del encargo de auto-actualización.
//
// Hoy los releases de SaurioLLM se publican A MANO con `gh` (docs/INSTALAR.md, README): no hay ningún
// paso automático que le recuerde a quien publica CUÁLES son los archivos que hacen falta para que
// electron-updater funcione después. Antes de este script, ya pasó una vez (Release v0.1.0) que faltó
// pensar en esto: el instalador se subió con espacios en el nombre y GitHub los reescribió a puntos al
// subirlo — ver electron-builder.yml (nsis.artifactName) para el detalle completo del bug.
//
// Este script NO publica nada (no toca la red, no llama a `gh`): solo lee `apps/desktop/release/`
// (generada por `pnpm --filter @saurio/desktop run build:installer`) y a `apps/desktop/package.json`
// para decir, en base al mismo criterio que usa electron-updater:
//   1. cuáles de los 3 archivos necesarios (instalador .exe, .exe.blockmap, latest.yml) están y cuáles
//      faltan;
//   2. si el `path`/`sha512` que trae `latest.yml` coincide con el instalador real en disco (mismo
//      chequeo que hace electron-updater al bajar la actualización, adelantado acá antes de publicar);
//   3. el comando `gh release upload` exacto para subir los tres, listo para copiar/pegar.
//
// Uso: `node scripts/release-local.mjs` (o `node scripts/release-local.mjs v0.2.0` para especificar el
// tag si no coincide con la versión de package.json, p. ej. release candidates).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const desktopDir = path.join(rootDir, 'apps', 'desktop');
const releaseDir = path.join(desktopDir, 'release');

function readDesktopVersion() {
  const pkgPath = path.join(desktopDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

function parseYamlScalar(yamlText, key) {
  // latest.yml es YAML simple (generado por electron-builder, sin anidar listas complejas en las
  // claves que nos interesan); un parser de línea alcanza y evita sumar una dependencia de YAML solo
  // para este script de un solo uso.
  const line = yamlText.split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  if (!line) return undefined;
  return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
}

function sha512Base64(filePath) {
  return createHash('sha512').update(readFileSync(filePath)).digest('base64');
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function main() {
  const version = process.argv[2]?.replace(/^v/, '') ?? readDesktopVersion();
  const tag = `v${version}`;
  const installerName = `SaurioLLM-Setup-${version}.exe`;
  const blockmapName = `${installerName}.blockmap`;
  const latestYmlName = 'latest.yml';

  console.log(`SaurioLLM — archivos necesarios para el Release ${tag} (auto-actualización)\n`);

  if (!existsSync(releaseDir)) {
    console.error(`No existe ${releaseDir}.`);
    console.error('Corré primero: pnpm --filter @saurio/desktop run build:installer');
    process.exitCode = 1;
    return;
  }

  const expected = [
    { name: installerName, required: true, description: 'instalador NSIS (lo que descarga/instala un usuario nuevo)' },
    { name: blockmapName, required: true, description: 'blockmap (electron-updater lo usa para descargas diferenciales)' },
    { name: latestYmlName, required: true, description: 'metadata de versión (electron-updater lo lee primero para saber si hay una versión nueva)' },
  ];

  let allPresent = true;
  const presentPaths = {};
  for (const file of expected) {
    const filePath = path.join(releaseDir, file.name);
    const present = existsSync(filePath);
    allPresent &&= present;
    presentPaths[file.name] = present ? filePath : undefined;
    const size = present ? formatBytes(statSync(filePath).size) : '';
    console.log(`  [${present ? 'x' : ' '}] ${file.name}${present ? ` (${size})` : ' — FALTA'}`);
    console.log(`      ${file.description}`);
  }

  if (!allPresent) {
    console.error('\nFaltan archivos — no se puede armar el comando de subida. Revisá el build:installer de arriba.');
    process.exitCode = 1;
    return;
  }

  // Punto 4 del encargo ("build:installer genera latest.yml coherente"): mismo chequeo que hace
  // electron-updater al bajar la actualización, adelantado acá antes de publicar nada.
  console.log('\nVerificando coherencia de latest.yml contra el instalador real...');
  const latestYmlText = readFileSync(presentPaths[latestYmlName], 'utf-8');
  const yamlPath = parseYamlScalar(latestYmlText, 'path');
  const yamlSha512 = parseYamlScalar(latestYmlText, 'sha512');
  const yamlVersion = parseYamlScalar(latestYmlText, 'version');

  const problems = [];
  if (yamlVersion !== version) problems.push(`version en latest.yml ("${yamlVersion}") no coincide con package.json ("${version}")`);
  if (yamlPath !== installerName) problems.push(`path en latest.yml ("${yamlPath}") no coincide con el nombre real del instalador ("${installerName}")`);
  const realSha512 = sha512Base64(presentPaths[installerName]);
  if (yamlSha512 !== realSha512) problems.push('sha512 en latest.yml no coincide con el sha512 real del instalador (¿se regeneró el .exe sin regenerar latest.yml?)');

  if (problems.length > 0) {
    console.error('\nlatest.yml NO es coherente con el instalador en disco:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('\nNo subas estos archivos así — volvé a correr build:installer de punta a punta.');
    process.exitCode = 1;
    return;
  }
  console.log('  OK: version/path/sha512 de latest.yml coinciden con el instalador real.');

  console.log('\nIntegridad de artefactos aprobada. Esto no certifica instalación, funcionamiento ni aceptación de la versión.');
  console.log('Antes de publicar, completá los criterios pendientes registrados en PROYECTO.md y docs/INSTALAR.md.');
  console.log(`\nComando de publicación para usar después de cerrar la aceptación (agregá --notes-file para las notas):\n`);
  console.log(
    `  gh release create ${tag} --repo Sauri0/SaurioLLM --target main --generate-notes \\\n` +
      `    "${path.join('apps', 'desktop', 'release', installerName)}" \\\n` +
      `    "${path.join('apps', 'desktop', 'release', blockmapName)}" \\\n` +
      `    "${path.join('apps', 'desktop', 'release', latestYmlName)}"`,
  );
  console.log(
    `\n(si el Release ${tag} ya existe, usá "gh release upload ${tag} <los mismos 3 archivos> --clobber" en vez de "release create")`,
  );
}

main();
