// Hash de contenido, detección de EOL/BOM y clasificación binaria — packages/runtime/src/checkpoint/hash.ts.
// Define: doc 09 §3.2 (before(): bytes crudos, EOL dominante por mayoría de línea, BOM, detección de
// binario en los primeros 8 KB). El hash es siempre sobre los bytes tal cual están en disco, sin
// normalizar EOL ni BOM (doc 09 §2.1).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Hashea sin cargar el archivo entero en memoria — usado para archivos > 20 MB (doc 09 §3.2),
 *  donde se necesita el hash para detectar cambios pero no se guarda el contenido como blob. */
export function hashFileStreaming(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export type Eol = 'LF' | 'CRLF';

export interface ContentProfile {
  eol: Eol;
  bom: boolean;
  /** BOM desconocido, NUL en los primeros 8 KB, o UTF-8 inválido (doc 09 §3.2). */
  binary: boolean;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SNIFF_BYTES = 8192;

export function detectContentProfile(content: Buffer): ContentProfile {
  const head = content.subarray(0, SNIFF_BYTES);
  const bom = content.subarray(0, 3).equals(UTF8_BOM);
  const body = bom ? content.subarray(3) : content;
  const sniffBody = bom ? head.subarray(3) : head;

  const hasNul = head.includes(0);
  const validUtf8 = hasNul ? true : isValidUtf8(sniffBody);
  const binary = hasNul || !validUtf8;

  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === 0x0a) {
      if (i > 0 && body[i - 1] === 0x0d) crlf++;
      else lf++;
    }
  }
  const eol: Eol = crlf > 0 && crlf >= lf ? 'CRLF' : 'LF';

  return { eol, bom, binary };
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}
