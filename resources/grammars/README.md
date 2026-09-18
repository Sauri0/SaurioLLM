# Grammars .wasm

GRAMMARS = `@vscode/tree-sitter-wasm` (decisión aplicada; ver `N:\saurio-smoke\RESULTADOS-electron.md` §5-6
y ADR-008 en `docs/architecture/12-decisiones.md`). `tree-sitter-wasms` se descartó porque sus `.wasm` no
traen la sección `dylink.0` que exige `web-tree-sitter@0.27` (falla medida, no hipotética).

Archivos copiados desde `node_modules/@vscode/tree-sitter-wasm@0.3.1/wasm/` (licencia MIT, Microsoft
Corporation) y renombrados a `<lang>.wasm` para que `packages/repomap/src/loader.ts` los resuelva por
nombre de lenguaje:

| Archivo aquí | Origen en el paquete |
|---|---|
| `typescript.wasm` | `tree-sitter-typescript.wasm` |
| `tsx.wasm` | `tree-sitter-tsx.wasm` |
| `javascript.wasm` | `tree-sitter-javascript.wasm` |
| `python.wasm` | `tree-sitter-python.wasm` |

Lenguajes del MVP (doc 02 §2): TypeScript, TSX, JavaScript, Python. El resto (10 lenguajes más) se agrega
en v0.2.

Nota de licencias: estos `.wasm` (MIT, Microsoft) son independientes de las queries `*-tags.scm` de
`packages/repomap/queries/` (Apache-2.0, derivadas de Aider, atribución pendiente en `NOTICE` cuando se
copien — ver `packages/repomap/queries/README.md`).
