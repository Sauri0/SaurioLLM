// Lector de solo lectura del HEAD de git — packages/runtime/src/checkpoint/git.ts.
// Define: doc 09 §2.2 ("dos lecturas de solo lectura, git rev-parse HEAD y git rev-parse
// --abbrev-ref HEAD, tomadas en el momento del begin()") y §5.3/§5.4 (`RevertPlan.branchChanged`).
// Nunca escribe en `.git` (doc 09 §7: "el runtime nunca invoca comandos git mutantes por su
// cuenta") — únicamente `rev-parse`, dos veces, siempre de solo lectura.
import { execFile } from 'node:child_process';

export interface GitHead { sha: string; branch: string }

export interface GitHeadReader {
  /** `undefined` si el proyecto no tiene `.git`, si `git` no está en el PATH, o si cualquiera de las
   *  dos lecturas falla — nunca lanza: doc 09 §7.1 trata la ausencia de git como el caso normal (más
   *  simple, sin riesgo de interferencia), no como un error. */
  read(projectRoot: string): Promise<GitHead | undefined>;
}

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

export function createGitHeadReader(): GitHeadReader {
  return {
    async read(projectRoot: string): Promise<GitHead | undefined> {
      try {
        const [sha, branch] = await Promise.all([
          run(projectRoot, ['rev-parse', 'HEAD']),
          run(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
        ]);
        if (!sha || !branch) return undefined;
        return { sha, branch };
      } catch {
        return undefined;
      }
    },
  };
}
