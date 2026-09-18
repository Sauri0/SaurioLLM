// Cliente de búsqueda de modelos GGUF en Hugging Face — packages/runtime/src/models/HuggingFaceClient.ts.
// Define: punto 3 del encargo de doc 16 §12.6: "búsqueda de modelos GGUF por texto, listado de
// archivos .gguf con tamaño y cuantización, y descarga vía Ollama con `hf.co/<user>/<repo>:<quant>`
// reutilizando DownloadManager".
//
// [VERIFICADO EN DOC OFICIAL: huggingface.co/docs/hub/en/ollama — Ollama sabe descargar directo desde
// Hugging Face con la referencia `hf.co/<usuario>/<repo>:<QUANT>`, donde `<QUANT>` es el sufijo de
// cuantización tal como aparece en el nombre del archivo .gguf (ej. Q4_K_M, IQ3_XS, F16), sin mediar el
// registry de Ollama — confirmado en vivo esta sesión contra `huggingface.co/api/models` con
// `?blobs=true`, que expone el tamaño real de cada sibling .gguf].
//
// ADR-2 (mismo criterio que RegistryClient/OllamaLibraryClient): fetch + zod, sin cliente HTTP de
// terceros ni SDK de Hugging Face.
import { z } from 'zod';

const HF_API_BASE = 'https://huggingface.co/api';

const HfSearchItemSchema = z.object({
  id: z.string(),
  likes: z.number().optional(),
  downloads: z.number().optional(),
  tags: z.array(z.string()).optional(),
  pipeline_tag: z.string().optional(),
  library_name: z.string().optional(),
  lastModified: z.string().optional(),
  createdAt: z.string().optional(),
});
const HfSearchResponseSchema = z.array(HfSearchItemSchema);

const HfSiblingSchema = z.object({
  rfilename: z.string(),
  size: z.number().optional(),
});
const HfModelDetailSchema = z.object({
  id: z.string(),
  siblings: z.array(HfSiblingSchema).optional(),
});

export interface HuggingFaceSearchResult {
  /** "usuario/repo", tal cual lo usa Ollama en `hf.co/<id>:<quant>`. */
  id: string;
  likes: number;
  downloads: number;
  tags: string[];
  pipelineTag?: string;
  libraryName?: string;
  updatedAt?: string;
}

export interface HuggingFaceGgufFile {
  filename: string;
  sizeBytes?: number;
  /** `undefined` si el nombre del archivo no sigue la convención `<...>-<QUANT>.gguf` reconocible
   *  (ej. un README.md incluido en el listado de siblings, o un .gguf sin sufijo de cuantización) —
   *  nunca se inventa un valor, el llamador decide si igual lo ofrece (con el nombre completo). */
  quant?: string;
}

/** "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf" -> "Q4_K_M"; "...-IQ3_XS.gguf" -> "IQ3_XS"; "...-f16.gguf"
 *  -> "f16". Cubre las familias de cuantización de llama.cpp/GGUF vistas en los fixtures reales
 *  (`Q\d`, `IQ\d`, `f16`/`F16`, `bf16`). No matchea archivos sin ese patrón (`.imatrix`, `README.md`,
 *  `.gitattributes`) — quedan con `quant: undefined`. */
function parseQuantFromFilename(filename: string): string | undefined {
  const m = /-((?:I?Q\d[\w]*|[Ff]16|[Bb][Ff]16))\.gguf$/.exec(filename);
  return m ? m[1] : undefined;
}

export interface HuggingFaceClientOptions {
  fetchImpl?: typeof fetch;
}

export class HuggingFaceClient {
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HuggingFaceClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status} para ${url}`);
    return (await response.json()) as T;
  }

  /** Búsqueda de texto libre, restringida a repos con archivos GGUF (`filter=gguf`, doc oficial de HF
   *  — mismo filtro que usa la búsqueda web de huggingface.co/models?library=gguf). */
  async searchModels(query: string, opts: { limit?: number } = {}): Promise<HuggingFaceSearchResult[]> {
    const limit = opts.limit ?? 20;
    const url = `${HF_API_BASE}/models?search=${encodeURIComponent(query)}&filter=gguf&limit=${limit}`;
    const raw = HfSearchResponseSchema.parse(await this.fetchJson<unknown>(url));
    return raw.map((item) => ({
      id: item.id,
      likes: item.likes ?? 0,
      downloads: item.downloads ?? 0,
      tags: item.tags ?? [],
      pipelineTag: item.pipeline_tag,
      libraryName: item.library_name,
      updatedAt: item.lastModified ?? item.createdAt,
    }));
  }

  /** Lista los archivos `.gguf` de un repo con tamaño real (`?blobs=true` — confirmado en vivo esta
   *  sesión) y la cuantización parseada del nombre. Un repo sin ningún `.gguf` devuelve `[]` (no es un
   *  error: el llamador decide qué mostrar, p. ej. "este repo no tiene variantes GGUF"). */
  async listGgufFiles(modelId: string): Promise<HuggingFaceGgufFile[]> {
    const url = `${HF_API_BASE}/models/${modelId}?blobs=true`;
    const detail = HfModelDetailSchema.parse(await this.fetchJson<unknown>(url));
    return (detail.siblings ?? [])
      .filter((s) => s.rfilename.toLowerCase().endsWith('.gguf'))
      .map((s) => ({ filename: s.rfilename, sizeBytes: s.size, quant: parseQuantFromFilename(s.rfilename) }));
  }

  /** [VERIFICADO EN DOC OFICIAL: huggingface.co/docs/hub/en/ollama] Formato vigente de referencia que
   *  entiende `POST /api/pull` de Ollama sin pasar por `registry.ollama.ai`. */
  buildOllamaRef(modelId: string, quant: string): string {
    return `hf.co/${modelId}:${quant}`;
  }
}
