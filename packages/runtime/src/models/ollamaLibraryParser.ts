// Parser tolerante de ollama.com/library (biblioteca completa) y ollama.com/library/<familia> (tags
// con tamaño/contexto por variante) — packages/runtime/src/models/ollamaLibraryParser.ts.
// Define: doc 16 §12.6 ("scraper tolerante de ollama.com/library + /tags", pendiente declarado de la
// sesión anterior) y punto 1/2 del encargo de esta sesión.
//
// [VERIFICADO EN DOC OFICIAL: doc 13 §3 ya dejó registrado que no existe un endpoint de catálogo/
// búsqueda documentado en la API de Ollama — `https://ollama.com/api/tags` no sirve como catálogo].
// Por eso el catálogo completo solo se puede armar leyendo el HTML público de ollama.com/library
// (listado de familias) y ollama.com/library/<familia> (tags de esa familia, con tamaño/contexto por
// variante) — las mismas dos páginas cuyos fixtures reales ya se investigaron y guardaron en
// ./fixtures/ (`ollama-library-list.sample.html`, `ollama-tags-gemma3.sample.html`).
//
// [DECISIÓN DE DISEÑO]: regex tolerante sobre el HTML, no un DOM parser — no hay ninguna librería de
// parseo de HTML en el repo (ADR-2: sin dependencias nuevas para hablar con un servicio externo si
// fetch + regex alcanza) y el layout de ambas páginas es simple, repetitivo y ya confirmado contra los
// fixtures reales. "Tolerante" acá significa: cada campo se extrae de forma independiente — un campo
// que no matchea no aborta el registro entero, solo lo deja `undefined` (mismo criterio que el resto
// del catálogo curado: nunca inventar un número, `undefined` cuando no se pudo confirmar) — y una
// familia/variante sin ningún dato reconocible simplemente no se agrega a la lista en vez de tirar.
//
// Mismo parser lo usan `scripts/build-model-catalog.mjs` (vía tsx, para el snapshot commiteado) y
// `OllamaLibraryClient` (en vivo, con caché) — un solo lugar con la lógica de parseo, como pide el
// encargo ("mismo parser").

export interface OllamaLibraryFamilySummary {
  name: string;
  description?: string;
  /** Badges de fondo índigo del listado: "embedding" | "tools" | "vision" | "thinking" (texto tal cual
   *  lo publica el sitio, sin normalizar acá — normalizar es responsabilidad del llamador). */
  capabilityHints: string[];
  /** Badges de fondo celeste del listado: tamaños de PARÁMETROS ("2b", "7b", "22m"...), no bytes — el
   *  listado nunca trae tamaño de descarga real, eso solo está en la página de tags de la familia. */
  sizeHints: string[];
  pulls?: string;
  tagsCount?: number;
  updatedText?: string;
}

export interface OllamaLibraryVariant {
  family: string;
  tag: string;
  sizeBytes?: number;
  contextMax?: number;
  /** `true` si la fila menciona "Image" (input de imagen) — proxy de `capabilities.vision` para una
   *  variante puntual, más preciso que el hint de familia (una familia puede tener variantes de texto
   *  puro y variantes con visión, ej. familias "-vl"). */
  vision: boolean;
  digest?: string;
  updatedText?: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "3.3GB" / "292MB" / "1.2TB" -> bytes (potencias de 1024, mismo criterio que el resto del catálogo
 *  curado). `undefined` si el texto no trae un tamaño reconocible. */
export function parseHumanSize(text: string): number | undefined {
  const m = /([\d.]+)\s*(TB|GB|MB|KB)\b/i.exec(text);
  if (!m) return undefined;
  const value = Number.parseFloat(m[1]!);
  if (!Number.isFinite(value)) return undefined;
  const unit = m[2]!.toUpperCase();
  const mult = unit === 'TB' ? 1024 ** 4 : unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : 1024;
  return Math.round(value * mult);
}

/** "128K" -> 131072 (128 × 1024); "32K" -> 32768. Mismo criterio de potencias de 1024 que usa Ollama
 *  para `context_length` real (ej. 32768, 40960, 131072 ya vistos en el catálogo curado). */
export function parseContextWindow(text: string): number | undefined {
  const m = /([\d.]+)\s*K\b/i.exec(text);
  if (!m) return undefined;
  const value = Number.parseFloat(m[1]!);
  if (!Number.isFinite(value)) return undefined;
  return Math.round(value * 1024);
}

/** Parsea `https://ollama.com/library` (listado completo, ~240 familias reales verificadas en vivo,
 *  doc 16 §12.6): cada familia es un bloque `<a href="/library/<nombre>" class="group w-full
 *  space-y-5">...` (ver fixture `ollama-library-list.sample.html`). Corta el HTML en el punto donde
 *  empieza cada ancla y trata todo hasta la siguiente ancla (o el final del documento) como el bloque
 *  de esa familia — tolera que el resto del markup interno cambie, mientras la ancla se mantenga. */
export function parseLibraryListHtml(html: string): OllamaLibraryFamilySummary[] {
  const anchorRe = /<a href="\/library\/([a-zA-Z0-9._-]+)"\s+class="group w-full space-y-5">/g;
  const starts: { name: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    starts.push({ name: match[1]!, index: match.index });
  }

  const families: OllamaLibraryFamilySummary[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const current = starts[i]!;
    const start = current.index;
    const end = i + 1 < starts.length ? starts[i + 1]!.index : html.length;
    const chunk = html.slice(start, end);

    const descMatch = /<p class="max-w-lg break-words text-neutral-800 text-md">([\s\S]*?)<\/p>/.exec(chunk);
    const capabilityHints = [...chunk.matchAll(/bg-indigo-50[^>]*>\s*([^<]+?)\s*<\/span>/g)].map((m) => m[1]!.trim());
    const sizeHints = [...chunk.matchAll(/bg-\[#ddf4ff\][^>]*>\s*([^<]+?)\s*<\/span>/g)].map((m) => m[1]!.trim());
    const pullsMatch = /<span\s*>([\d.]+[MKB]?)<\/span>\s*<span class="hidden sm:flex">&nbsp;Pulls<\/span>/.exec(chunk);
    const tagsMatch = /<span\s*>(\d+)<\/span>\s*<span class="hidden sm:flex">&nbsp;Tags<\/span>/.exec(chunk);
    const updatedMatch = /Updated&nbsp;<\/span>\s*<span\s*>([^<]+)<\/span>/.exec(chunk);

    families.push({
      name: current.name,
      description: descMatch ? decodeEntities(descMatch[1]!) : undefined,
      capabilityHints,
      sizeHints,
      pulls: pullsMatch ? pullsMatch[1] : undefined,
      tagsCount: tagsMatch ? Number(tagsMatch[1]) : undefined,
      updatedText: updatedMatch ? decodeEntities(updatedMatch[1]!) : undefined,
    });
  }
  return families;
}

/** Parsea `https://ollama.com/library/<familia>` (tags de una familia, con tamaño/contexto real por
 *  variante — ver fixture `ollama-tags-gemma3.sample.html`). Cada fila trae DOS bloques redundantes
 *  (uno para mobile `md:hidden`, uno para desktop `hidden md:flex`); se usa la ancla del bloque mobile
 *  (siempre presente primero) para no duplicar filas, y se leen los campos de cualquiera de los dos
 *  bloques (tamaño/contexto están en ambos, en formatos ligeramente distintos: "3.3GB • 128K context
 *  window" en el texto corrido del bloque mobile, o celdas `<p class="col-span-2...">` separadas en el
 *  bloque desktop — se intenta el primero y se cae al segundo). */
export function parseTagsPageHtml(html: string, family: string): OllamaLibraryVariant[] {
  const escapedFamily = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // [DECISIÓN DE DISEÑO] "tolerante" real, no solo declarado: el fixture guardado usaba
  // `class="md:hidden ..."` para el bloque mobile de cada fila; una relectura en vivo de esta misma
  // sesión (`ollama.com/library/gemma3`) encontró que el sitio ya cambió a `class="sm:hidden ..."` —
  // el breakpoint de Tailwind cambió, no la estructura. El regex acepta cualquier prefijo `xx:hidden`
  // en vez de fijar uno solo, así sobrevive a ese tipo de cambio menor sin volver a romperse.
  const anchorRe = new RegExp(`href="\\/library\\/${escapedFamily}:([a-zA-Z0-9._-]+)"\\s+class="[a-z]+:hidden flex flex-col space-y-\\[6px\\]`, 'g');
  const starts: { tag: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    starts.push({ tag: match[1]!, index: match.index });
  }

  // Techo del bloque de la ÚLTIMA variante de la página (hallazgo real de esta sesión, confirmado con
  // DOS relecturas en vivo de la misma URL que devolvieron contenido de longitud distinta entre sí —
  // la página no es 100% estática byte a byte entre requests): sin un límite, ese bloque se extendía
  // hasta el final del documento (nada más marca dónde termina la lista de variantes), y el detector
  // de visión (`/Image/i`) a veces matcheaba el widget "subí una imagen" del chat de la propia página
  // más abajo — falso positivo real observado con `llama3.1:405b`/`deepseek-r1:671b` marcados
  // `vision: true` sin serlo. En vez de un límite de caracteres fijo (frágil: la distancia real al
  // widget varía entre requests, un cap fijo a veces alcanza y a veces no) se busca el marcador
  // "id=\"readme\"" — la sección de variantes SIEMPRE termina justo antes de la sección "Readme" de la
  // ficha del modelo, confirmado en vivo — y se corta ahí. Si el marcador no aparece (fixture viejo
  // truncado, o el sitio cambia nombres) se cae a un techo de caracteres generoso como red de
  // seguridad secundaria, nunca al final del documento completo.
  const README_MARKER = 'id="readme"';
  const FALLBACK_MAX_BLOCK_LENGTH = 6000;
  const readmeIdx = html.indexOf(README_MARKER);
  const variants: OllamaLibraryVariant[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const current = starts[i]!;
    const start = current.index;
    const nextAnchorEnd = i + 1 < starts.length ? starts[i + 1]!.index : html.length;
    const readmeEnd = readmeIdx !== -1 && readmeIdx > start ? readmeIdx : html.length;
    const end = Math.min(nextAnchorEnd, readmeEnd, start + FALLBACK_MAX_BLOCK_LENGTH);
    const chunk = html.slice(start, end);

    // Separador visto en vivo: "·" (middle dot, U+00B7) hoy; el fixture guardado usaba "•" (bullet,
    // U+2022, con el digest antes: "<digest> • 3.3GB • 128K...") — se aceptan ambos. Solo se exige el
    // separador DESPUÉS del tamaño (antes puede o no haber un digest — el layout en vivo de esta
    // sesión ya no lo trae, ver test de tolerancia dedicado).
    const sizeInline = /([\d.]+\s*(?:TB|GB|MB|KB))\s*[•·]/i.exec(chunk);
    const sizeCell = /<p\s+class="col-span-2[^"]*">\s*([\d.]+\s*(?:TB|GB|MB|KB))\s*<\/p>/i.exec(chunk);
    const ctxInline = /([\d.]+K)\s*context window/i.exec(chunk);
    const ctxCell = /<p class="col-span-2[^"]*">\s*([\d.]+K)\s*<\/p>/i.exec(chunk);
    const digestMatch = /<span class="font-mono text-\[11px\]">\s*([a-f0-9]+)\s*<\/span>/.exec(chunk);
    const updatedMatch = /·&nbsp;([^<]+)<\/div>/.exec(chunk);
    const vision = /Image/i.test(chunk);

    variants.push({
      family,
      tag: current.tag,
      sizeBytes: parseHumanSize((sizeInline ?? sizeCell)?.[1] ?? ''),
      contextMax: parseContextWindow((ctxInline ?? ctxCell)?.[1] ?? ''),
      vision,
      digest: digestMatch ? digestMatch[1] : undefined,
      updatedText: updatedMatch ? decodeEntities(updatedMatch[1]!) : undefined,
    });
  }
  return variants;
}
