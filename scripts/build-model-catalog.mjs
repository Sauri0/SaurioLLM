#!/usr/bin/env node
// Genera resources/model-catalog.snapshot.json recorriendo la biblioteca completa de Ollama
// (ollama.com/library + la página de cada familia) — scripts/build-model-catalog.mjs.
// Define: punto 1 del encargo de doc 16 §12.6. Uso: `node scripts/build-model-catalog.mjs`
// (también expuesto como `pnpm run build:model-catalog`, ver package.json raíz).
//
// [DECISIÓN DE DISEÑO] Este archivo es un bootstrap fino: registra el loader de `tsx` (ya es
// devDependency de la raíz, doc 02 — no se agrega ninguna dependencia nueva) para poder importar
// `./build-model-catalog.impl.ts`, que a su vez reutiliza el MISMO parser que consume
// `OllamaLibraryClient` en runtime (`packages/runtime/src/models/ollamaLibraryParser.ts`) — un solo
// lugar con la lógica de parseo, como pide el encargo ("mismo parser").
import { register } from 'tsx/esm/api';

// `register()` devuelve la función `unregister` directamente (no un objeto con un método
// `.unregister`, como sugeriría el nombre "api") — confirmado corriendo esto de verdad, tsx 4.23.13.
const unregister = register();
try {
  const impl = await import('./build-model-catalog.impl.ts');
  await impl.main();
} finally {
  unregister();
}
