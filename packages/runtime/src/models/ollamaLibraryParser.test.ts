// Tests del parser tolerante contra los fixtures REALES investigados en la sesión anterior (doc 16
// §12.6) — packages/runtime/src/models/ollamaLibraryParser.test.ts. No hay red acá: son los mismos
// HTML guardados que ya se verificaron en vivo contra ollama.com.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseContextWindow, parseHumanSize, parseLibraryListHtml, parseTagsPageHtml,
} from './ollamaLibraryParser.js';

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');
const listHtml = readFileSync(path.join(FIXTURES_DIR, 'ollama-library-list.sample.html'), 'utf-8');
const tagsHtml = readFileSync(path.join(FIXTURES_DIR, 'ollama-tags-gemma3.sample.html'), 'utf-8');

describe('parseHumanSize', () => {
  it('convierte GB/MB a bytes (potencias de 1024)', () => {
    expect(parseHumanSize('3.3GB')).toBe(Math.round(3.3 * 1024 ** 3));
    expect(parseHumanSize('292MB')).toBe(Math.round(292 * 1024 ** 2));
    expect(parseHumanSize('17GB')).toBe(17 * 1024 ** 3);
  });
  it('undefined si no hay tamaño reconocible', () => {
    expect(parseHumanSize('sin dato')).toBeUndefined();
  });
});

describe('parseContextWindow', () => {
  it('convierte "128K"/"32K" a tokens (× 1024)', () => {
    expect(parseContextWindow('128K')).toBe(131072);
    expect(parseContextWindow('32K')).toBe(32768);
  });
  it('undefined si no hay contexto reconocible', () => {
    expect(parseContextWindow('n/d')).toBeUndefined();
  });
});

describe('parseLibraryListHtml (fixture real ollama.com/library)', () => {
  const families = parseLibraryListHtml(listHtml);

  it('encuentra las 6 familias del fixture', () => {
    expect(families.map((f) => f.name)).toEqual([
      'all-minilm', 'codegemma', 'snowflake-arctic-embed', 'mistral-small', 'deepseek-coder-v2', 'orca-mini',
    ]);
  });

  it('extrae descripción, capability hints y size hints de all-minilm', () => {
    const allMinilm = families.find((f) => f.name === 'all-minilm')!;
    expect(allMinilm.description).toContain('Embedding models');
    expect(allMinilm.capabilityHints).toEqual(['embedding']);
    expect(allMinilm.sizeHints).toEqual(['22m', '33m']);
    expect(allMinilm.pulls).toBe('3.6M');
    expect(allMinilm.tagsCount).toBe(10);
  });

  it('codegemma no tiene capability hint pero sí size hints de parámetros', () => {
    const codegemma = families.find((f) => f.name === 'codegemma')!;
    expect(codegemma.capabilityHints).toEqual([]);
    expect(codegemma.sizeHints).toEqual(['2b', '7b']);
    expect(codegemma.tagsCount).toBe(85);
  });

  it('nunca tira si un campo no matchea: cada familia siempre tiene al menos `name`', () => {
    for (const family of families) {
      expect(family.name.length).toBeGreaterThan(0);
    }
  });
});

describe('parseTagsPageHtml (fixture real ollama.com/library/gemma3)', () => {
  const variants = parseTagsPageHtml(tagsHtml, 'gemma3');

  it('encuentra variantes reales con tamaño/contexto/visión', () => {
    expect(variants.length).toBeGreaterThan(0);
    const latest = variants.find((v) => v.tag === 'latest')!;
    expect(latest).toBeDefined();
    expect(latest.sizeBytes).toBe(Math.round(3.3 * 1024 ** 3));
    expect(latest.contextMax).toBe(131072);
    expect(latest.vision).toBe(true);
    expect(latest.digest).toBe('a2af6cc3eb7f');
  });

  it('una variante de solo texto no marca vision', () => {
    const mini = variants.find((v) => v.tag === '270m')!;
    expect(mini).toBeDefined();
    expect(mini.sizeBytes).toBe(292 * 1024 ** 2);
    expect(mini.contextMax).toBe(32768);
    expect(mini.vision).toBe(false);
  });

  it('todas las variantes traen `family` correcto', () => {
    for (const v of variants) expect(v.family).toBe('gemma3');
  });
});

describe('parseTagsPageHtml (tolerancia a un cambio real de layout, verificado en vivo)', () => {
  // ollama.com/library/gemma3 en vivo (esta sesión, 2026-09-18) usa `class="sm:hidden ...` en vez de
  // `class="md:hidden ...` (el fixture guardado es de una sesión anterior) y "·" (middle dot) en vez de
  // "•" (bullet) como separador — el sitio cambió de breakpoint de Tailwind, no de estructura. Este
  // mini-HTML reproduce esa variante real sin depender de la red para el test.
  const liveLikeHtml = `
    <a href="/library/qwen3:8b" class="sm:hidden flex flex-col space-y-[6px] group text-[13px] px-4 py-3">
      <p class="flex text-neutral-500">5.2GB · 40K context window · Text · 1 year ago</p>
    </a>
  `;

  it('acepta "sm:hidden" y el separador "·" sin perder la variante', () => {
    const variants = parseTagsPageHtml(liveLikeHtml, 'qwen3');
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ family: 'qwen3', tag: '8b', vision: false, contextMax: 40 * 1024 });
    expect(variants[0]!.sizeBytes).toBe(Math.round(5.2 * 1024 ** 3));
  });
});

describe('parseTagsPageHtml (falso positivo de visión, hallazgo real en vivo esta sesión)', () => {
  // ollama.com/library/llama3.1 en vivo: la ÚLTIMA variante de la página (405b, sin visión real) quedó
  // marcada `vision: true` porque su bloque se extendía sin límite hasta un widget "subí una imagen"
  // del chat de la propia ficha, más abajo en el documento — dos relecturas en vivo de la misma URL
  // devolvieron HTML de longitud distinta entre sí, así que un límite de caracteres fijo no alcanza
  // siempre. El fix real es cortar en `id="readme"` (la sección de variantes SIEMPRE termina justo
  // antes de esa sección, confirmado en vivo) en vez de un límite arbitrario.
  const htmlWithFarUploadWidget = `
    <a href="/library/llama3.1:405b" class="sm:hidden flex flex-col space-y-[6px] group text-[13px] px-4 py-3">
      <p class="flex text-neutral-500">243GB · 128K context window · Text · 1 year ago</p>
    </a>
    <div id="readme">
      <input type="file" onchange="uploadImages(event)" accept="Image" />
    </div>
  `;

  it('no marca vision:true por contenido después de "id=\\"readme\\""', () => {
    const variants = parseTagsPageHtml(htmlWithFarUploadWidget, 'llama3.1');
    expect(variants).toHaveLength(1);
    expect(variants[0]!.vision).toBe(false);
  });

  it('sin el marcador "readme" (fixture viejo/sitio distinto), sigue detectando "Image" real dentro del bloque', () => {
    const withoutReadmeMarker = `
      <a href="/library/gemma3:4b" class="sm:hidden flex flex-col space-y-[6px] group text-[13px] px-4 py-3">
        <p class="flex text-neutral-500">3.5GB · 128K context window · Text, Image · 1 year ago</p>
      </a>
    `;
    const variants = parseTagsPageHtml(withoutReadmeMarker, 'gemma3');
    expect(variants[0]!.vision).toBe(true);
  });
});
