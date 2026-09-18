# Eval — harness de evaluación de agentes

Harness independiente de la app empaquetada, corre `packages/runtime` en modo headless contra tareas con
fixtures (`docs/architecture/02-estructura-de-carpetas.md` §1). Criterio de "listo" del hito 1: 5 tareas.

Estructura:
- `fixtures/` — repos miniatura usados como workspace de las tareas.
- `tasks/` — una tarea por carpeta: prompt, criterio de éxito, fixture asociado.
- `harness.ts` — corredor de tareas (pendiente, fase posterior).
- `eval_runs` — base SQLite propia del harness, separada de `saurio.db` (se crea en runtime, no versionada).

Placeholder de esqueleto: `harness.ts` y las 5 tareas del hito 1 se agregan en una fase posterior; este
scaffolding solo deja la estructura de carpetas fijada por el doc 02.
