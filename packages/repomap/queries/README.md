# Queries `*-tags.scm`

Un archivo `*-tags.scm` por lenguaje soportado en el MVP (`typescript`, `tsx`, `javascript`,
`python`), derivado de las queries de [Aider](https://github.com/Aider-AI/aider)
(licencia Apache-2.0, atribución completa en `resources/grammars/NOTICE`; ver
`docs/architecture/12-decisiones.md`, ADR-008).

Capturas usadas por `src/tags.ts`:

- `@name.definition.{function,method,class,interface,type,enum}` → tag `kind: 'def'`.
- `@name.reference.{call,class,type}` → tag `kind: 'ref'`.

Simplificadas respecto del original de Aider (menos capturas por lenguaje) para el alcance del
MVP; alcanza para el grafo archivo→archivo y el render compacto de §2 de `07-context-manager.md`.
