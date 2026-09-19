# Evaluación del runtime

`pnpm test:eval` ejecuta `harness.ts` contra Ollama real, con workspace y base temporal separados de los datos del usuario. Comprueba proyecto/chat, plan, herramientas, permisos, diff/revert, persistencia, contexto y delegación. Necesita Ollama disponible y los modelos previstos (`qwen3:8b` y `qwen2.5-coder:7b`); `SAURIO_EVAL_MODEL` cambia el modelo principal y `SAURIO_EVAL_TIMEOUT_MS` el tiempo total.

`pnpm test:eval:unit` prueba el observador de eventos sin inferencia ni red. Está incluido en `pnpm test`. `runWatcher.ts` consume permisos sucesivos una sola vez, recupera eventos previos y espera el resultado final. Una prueba unitaria no sustituye la evaluación real.

El resultado histórico v0.2.2 fue 16/20. La revisión encontró un defecto en el observador que repetía el primer permiso y podía causar falsos timeouts. La base de estabilización de v0.2.3 alcanzó 20/20; las corridas fallidas y correcciones se conservan en `../PROYECTO.md` §12.2. Ese resultado no certifica automáticamente cambios posteriores de la ampliación (§13).

`pnpm exec tsx eval/team-smoke.ts` comprueba Director→Tester con colaboradores existentes, permiso y lectura real de un archivo aislado; usa Ollama local. Los smokes `scripts/smoke-ui-023.mjs` y `scripts/smoke-files-023.mjs` comprueban interacción con el renderer real y actualización de archivos; `--dev` usa el build local y, sin esa opción, el ejecutable empaquetado. Guardan evidencia y perfiles separados en `smoke/`. `scripts/smoke-release-functional.mjs --upgrade-from <exe-anterior>` comprueba migración de un perfil sintético respaldado, nunca del perfil personal. El script `scripts/smoke-managed-engine.mts` descarga un modelo pequeño y ejecuta inferencia local con el motor administrado; requiere red para la descarga inicial, sin API paga.

Las pruebas opcionales de proveedores externos requieren `SAURIO_TEST_EXTERNAL=1` y sus credenciales/requisitos. No activarlas sin autorización de datos y costos. Este harness local es independiente de Jev/Evaluaciones, que sigue solo en planificación.

`pnpm exec tsx eval/text-tool-smoke.ts` repite tres veces una edición con `qwen2.5-coder:7b` y protocolo textual, verificando herramientas y contenido final del archivo. `pnpm exec tsx eval/team-smoke.ts --auto` comprueba además la resolución automática local del equipo. Ejecutar estas inferencias y el harness en serie, sin otras pruebas que carguen modelos al mismo tiempo. Los resultados actuales y los fallos conservados están en `PROYECTO.md` §13; no sustituirlos por una corrida histórica exitosa.
