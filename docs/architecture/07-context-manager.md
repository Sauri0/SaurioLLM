# 07. Estrategia de context management

**Propósito.** Definir cómo el `ContextManager` decide qué le entra al modelo en cada turno — repo map, memoria, historial, resultados de tools — dentro de un `numCtx` fijo y con un prefijo estable que aproveche el cache de prompt del provider, para que un modelo local de 7-8B con contexto chico pueda trabajar sobre proyectos reales sin degradarse ni desbordar.

**Leyenda:** `[COMPROBADO EN EQUIPO]` `[VERIFICADO EN DOC OFICIAL]` `[DECISIÓN DE DISEÑO]` `[HIPÓTESIS A PROBAR]`

---

## 1. Principio: progressive disclosure

`[DECISIÓN DE DISEÑO]`. El modelo nunca recibe el repositorio completo. Recibe un **mapa** (repo map) que le dice qué existe y dónde, y **herramientas** para pedir el detalle que necesite (`list_files`, `search_code`, `read_file`, `read_output`). Cada respuesta de esas tools entra recortada (§6) y queda completa en disco por si el modelo necesita más. El costo de "no saber algo" es una tool call adicional (barata en tokens, cara en latencia); el costo de "saber todo por las dudas" es un contexto lleno de texto irrelevante que empeora la calidad del modelo antes de llenar el buffer `[HIPÓTESIS A PROBAR, fuente secundaria: RULER/NoLiMa, citado en la columna vertebral §8]`. La disciplina completa se apoya en cuatro mecanismos que se explican en este documento:

1. **Repo map** (§2): qué archivos y símbolos existen, sin su contenido.
2. **Tools de exploración progresiva** (§3): pedir contenido bajo demanda, con límites duros.
3. **Prefijo estable + presupuestos** (§4-5): ordenar el prompt para que lo estático se cachee y lo dinámico entre en un presupuesto explícito.
4. **Truncado y compactación** (§6-7): degradar contenido viejo o voluminoso antes de que el contexto se llene, nunca de golpe ni en silencio.

`ContextManager` es el único responsable de que `tokens ≤ numCtx − reserveForResponse` en cada llamada a `ModelGateway.chat`; si no puede cumplirlo tras compactar, el run termina en `failed(context_overflow)` (columna vertebral §6 paso 3, §12) en vez de dejar que Ollama trunque el prompt por el frente en silencio `[HIPÓTESIS A PROBAR, fuente secundaria: issues ollama #8099/#7907, citado en columna vertebral §8]`.

---

## 2. Repo map

### 2.1 Por qué (y qué no)

`[DECISIÓN DE DISEÑO]`. Se copia el patrón de Aider (tags de tree-sitter + PageRank + presupuesto de tokens + cache por mtime) en vez de indexación semántica con embeddings. Motivos: (a) no agrega un segundo modelo ni una carga de VRAM adicional en una GPU de 8 GB `[COMPROBADO EN EQUIPO]`; (b) el ranking de Aider es el método más probado en producción para este problema puntual (dar contexto estructural, no respuestas semánticas); (c) mantiene la arquitectura hardware-agnóstica: el mismo mecanismo escala de un repo de 50 archivos a uno de 5.000 subiendo `repoMapTokens`, sin depender de un índice vectorial que haya que re-generar. Embeddings/indexación semántica queda para v0.4 (columna vertebral §16), como complemento (búsqueda "¿dónde se valida el email?") y no como reemplazo del repo map.

### 2.2 Cómo se construye

Responsable: `ProjectIndexer`, corriendo en un `utilityProcess` separado del proceso `main` (columna vertebral §2, ADR-1) para que un repo grande o una grammar que cuelga no bloqueen la UI ni el loop del agente. Habla con `ContextManager` a través de `RepoMapClient` (`index(projectPath, changedFiles)`, `rank(query)`).

Pipeline, en orden:

1. **Listado de archivos.** `rg --files` (respeta `.gitignore` de forma nativa, multiline, rápido `[VERIFICADO EN DOC OFICIAL: investigación 2 §C.5]`) combinado con `.saurioignore` (exclusiones propias de SaurioLLM: `node_modules/`, `dist/`, `.saurio/`, blobs de checkpoints, binarios y archivos > 1 MB). `.saurioignore` también filtra qué puede leer `read_file` y qué entra al repo map (columna vertebral §7 y §8): una regla `deny` por defecto en el preset `balanced` cubre `.env*`.
2. **Parseo con tree-sitter.** `web-tree-sitter 0.27` carga grammars `.wasm` compiladas por el proyecto mismo con `tree-sitter-cli ≥ 0.26` (no las de `tree-sitter-wasms 0.1.13`, con incompatibilidad reportada contra `web-tree-sitter 0.27` `[HIPÓTESIS A PROBAR, fuente secundaria; columna vertebral §11]`). MVP: TypeScript, TSX, JavaScript, Python. v0.2: Go, Rust, Java, C, C++, C#, CSS, HTML, Bash, YAML (columna vertebral §16).
3. **Extracción de tags.** Por cada archivo parseado se corre una query `queries/<lang>-tags.scm`, derivada de las queries de Aider (`aider/queries/tree-sitter-languages/*-tags.scm`, Apache-2.0, con atribución en `resources/grammars/NOTICE`). Capturas `@name.definition.{function,method,class,interface,type,enum,module}` → `kind: 'def'`; `@name.reference.{call,type,class}` → `kind: 'ref'`. Cada tag guarda `{ name, kind, line, path }`.
4. **Grafo archivo → archivo.** Una arista `A → B` con peso `w` quiere decir "A referencia símbolos definidos en B". Pesos, heredados de la heurística de Aider y ajustados a la sesión de SaurioLLM `[DECISIÓN DE DISEÑO]`:
   - `×50` si el archivo fue mencionado o tocado en el chat actual (leído, editado, o nombrado por el usuario).
   - `×10` si el identificador de la referencia fue mencionado textualmente por el usuario en el turno.
   - `×0,1` si el nombre del símbolo es genérico (contiene `_`, o está definido en más de 5 archivos — evita que `id`, `handler`, `main` dominen el ranking).
   - Peso final escalado por `sqrt(cantidad de referencias)` para no dejar que un archivo con cientos de llamadas a la misma función se coma todo el presupuesto.
5. **PageRank personalizado.** Se corre PageRank sobre ese grafo dirigido y pesado (implementación propia o `graphology`, a decidir en el scaffolding — no es una decisión de arquitectura) con "personalización" hacia los archivos mencionados en el chat, para que el ranking se sesgue hacia lo relevante al turno actual y no sea un ranking estático del repo.
6. **Selección por presupuesto.** Se ordenan los archivos por score de PageRank y se arma la salida agregando definiciones archivo por archivo (todas las de un archivo antes de pasar al siguiente) hasta agotar `repoMapTokens` (§5); si un archivo no entra completo, no entra — no se cortan definiciones a la mitad. Búsqueda binaria sobre el número de archivos incluidos para maximizar cuántos entran sin pasarse del presupuesto (mismo mecanismo que `repomap.py` de Aider).

### 2.3 Formato de salida (compacto)

`[DECISIÓN DE DISEÑO]`. Un bloque de texto plano por archivo, sin JSON ni XML (ahorra tokens y es más legible para el modelo que un árbol serializado):

```
src/context/ContextBuilder.ts:
│ export class ContextBuilder
│   build(history, agent, mode)
│ interface ContextBudgetReport
⋮
src/gateway/ModelGateway.ts:
│ export interface ModelGateway
│   chat(ref, req, ctx)
│   ensureLoaded(ref, numCtx)
⋮
```

`⋮` marca líneas omitidas dentro del mismo archivo entre definiciones no contiguas. Los archivos sin grammar disponible (§2.5) aparecen solo como ruta, sin cuerpo, en un bloque final "otros archivos del proyecto" — todavía cuentan para que el modelo sepa que existen, aunque no vea sus símbolos.

### 2.4 Presupuesto, cache y actualización incremental

- **Presupuesto en tokens:** `repoMapTokens` es un campo de `ContextPolicy` (columna vertebral §5); valores de referencia en §5 de este documento por tamaño de `numCtx`.
- **Cache:** tabla `repo_map_cache(project_id, rel_path, mtime, size, lang, tags_json)` (columna vertebral §4). Un archivo se re-parsea solo si cambió `mtime` o `size`; el resto se sirve de SQLite. Esto hace que abrir un proyecto grande la segunda vez sea casi instantáneo.
- **Actualización incremental:** `fs.watch` sobre el workspace con debounce (evita re-indexar en cada tecla si el usuario edita fuera de SaurioLLM); al detectar cambios llama `index(projectPath, changedFiles)` con la lista puntual de archivos tocados, no un re-scan completo. El mismo watcher marca en la UI "archivo modificado externamente" cuando afecta a un archivo que el run está usando (columna vertebral §13).
- **Cuándo se refresca el repo map dentro de un run:** solo en los puntos de compactación (§7), nunca a mitad de una serie de turnos — evita invalidar el prefijo cacheado por un cambio menor mientras el modelo está trabajando (columna vertebral §8).
- **Respeto de `.gitignore` y `.saurioignore`:** aplicado en el paso 1 (listado) y de nuevo al armar el repo map final, para que un archivo agregado a `.saurioignore` a mitad de sesión deje de aparecer en el próximo refresco sin reiniciar el indexer.

### 2.5 Fallback para lenguajes sin grammar

Si un archivo tiene una extensión reconocida pero no hay `.wasm` para su lenguaje (fuera de ts/tsx/js/py en el MVP), o si la carga de la grammar falla en tiempo de ejecución `[HIPÓTESIS A PROBAR: incompatibilidad de versiones, columna vertebral §11]`, el repo map degrada a **árbol plano de archivos**: solo rutas, agrupadas por carpeta, sin símbolos, tratadas como cualquier archivo `json` o de configuración. El indexer no aborta ni bloquea el resto del pipeline por un archivo o un lenguaje que falla — lo registra en log y sigue. Esto es lo que ya hace el MVP con `json` y el resto de las extensiones no cubiertas (columna vertebral §8).

---

## 3. Tools de exploración progresiva

Las cuatro tools de lectura, definidas como `ToolDefinition` en `packages/runtime/src/tools/builtin/` (columna vertebral §3 y §5), con categoría `read` → `allow` por defecto (columna vertebral §7):

| Tool | Firma | Límite duro | Qué pasa al pasarse |
|---|---|---|---|
| `list_files` | `list_files(path, depth?)` | `depth ≤ 3` | El runtime clampa el valor recibido; no es un error, se ejecuta con el máximo permitido |
| `search_code` | `search_code(query, glob?, max_results?)` | `max_results ≤ 50`, sobre `rg --json` | Resultados agrupados por archivo con 1 línea de contexto; si hay más de 50 matches, se avisa "N resultados más; refiná la búsqueda" |
| `read_file` | `read_file(path, start_line?, end_line?)` | `maxReadLines` (250 por defecto, en `ContextPolicy`) | Sin rango explícito y archivo más largo que el límite: se devuelve el tramo inicial + aviso `"[archivo de N líneas; usá start_line/end_line]"` — nunca se corta un archivo grande a la mitad sin decírselo al modelo |
| `read_output` | `read_output(toolCallId, start?, end?)` | `maxCommandLines` (`ContextPolicy`) | Relee la salida completa de un `run_command` anterior desde `tool-outputs/<toolCallId>.txt`, sin volver a ejecutar el comando |

Nota de nomenclatura: el brief de este documento nombraba una tool `list_directory` y una tool separada `read_range`; la columna vertebral no las define así — el listado real es `list_files` (§3, §5, §8) y el rango de lectura es un parámetro de `read_file`, no una tool aparte. Se usa la nomenclatura de la columna vertebral (ver "Desvíos" al final).

`read_output` es la pieza que evita el patrón más caro en tokens de un agente que explora sin disciplina: volver a correr un comando lento (`npm test`, un build) solo para ver una parte de la salida que no entró en el `result_preview` truncado. La salida completa de cualquier tool que supere 30.000 caracteres ya vive en `appData/tool-outputs/<toolCallId>.txt` (columna vertebral §4); `read_output` es la puerta de lectura a ese archivo, con los mismos límites de rango que `read_file`.

Filtrado por modo: en `plan` el modelo ve `list_files, search_code, read_file, read_output, task_update, finish` — nada que escriba o ejecute (columna vertebral §6, §7, corrección de la condición 13). En `agent` ve el set completo permitido al agente, diez builtins por defecto: `list_files, search_code, read_file, read_output, edit_file, write_file, delete_file, run_command, task_update, finish` (corrección de la condición 13 sobre el resumen ejecutivo de la columna vertebral, que decía "ocho"). La recomendación de 6-8 tools de la investigación 3 se mantiene como guía para **agentes personalizados** con `allowedTools` recortado, no como límite duro del registro.

---

## 4. Layout del prompt: prefijo estable

### 4.1 Orden fijo

```
[1] System prompt inmutable (rol + reglas + protocolo de tools)   ← nunca cambia dentro de un run
[2] Few-shot (mensajes assistant/tool reales, si agent.systemPrompt.fewShot)
[3] Repo map (primer mensaje user)
[4] Memoria de proyecto (SAURIO.md + project_memory)
[5] Resumen de compactación (si existe; mensaje user en posición fija)
[6] Historial de la conversación (append-only)
[7] Mensaje efímero del turno actual (ephemeral: true)
```

Este orden es el que arma `ContextBuilder.build(history, agent, mode)` (columna vertebral §2, §6 paso 3): system inmutable → few-shot → primer mensaje `user` con repo map + `SAURIO.md` → resumen de compactación si existe → historial → mensaje efímero final.

### 4.2 Por qué este orden (y no otro)

`[VERIFICADO EN DOC OFICIAL: cache por prefijo de llama.cpp; citado en columna vertebral §8]`. El runner de Ollama (llama.cpp por debajo) reutiliza el cómputo de las capas de atención para el prefijo de tokens que coincide byte a byte con la llamada anterior; en cuanto un token difiere, el cache se invalida desde ese punto en adelante. Un modelo local corriendo en una GPU de 8 GB no tiene margen para repagar miles de tokens de prompt en cada turno: si el system prompt, las definiciones de tools o el repo map cambian de posición o de contenido entre llamadas, se pierde el cache de todo lo que viene después, y el costo se paga en latencia (tiempo de "prompt eval") en cada turno, no solo en el primero.

Reglas concretas que sostienen el prefijo `[DECISIÓN DE DISEÑO]`:

- El **system prompt** no lleva fecha, contador de turno ni nada que cambie entre llamadas del mismo run; su hash se fija en `effective_config_json.promptHash` al iniciar el run (columna vertebral §5, `EffectiveConfig`).
- El **set de tools** (y por lo tanto sus definiciones JSON Schema, que el provider antepone al prompt) queda fijo por run — se decide en `preparing` según modo y agente, y no se vuelve a recalcular turno a turno.
- El **historial es append-only**: nada de lo que ya se mandó se reescribe in place; lo único que cambia contenido pasado es la compactación, que reemplaza un tramo completo en un solo salto (§7), no turno a turno.
- Todo lo **dinámico del turno actual** (recordatorio de "una tool o respuesta final", checklist de tasks) va al final como mensaje `ephemeral: true` — se genera pero nunca se persiste en `messages` ni pasa a formar parte del prefijo que se reutiliza en el próximo turno (columna vertebral §4, §5: `ChatMessage.ephemeral`).
- El **repo map y la memoria de proyecto solo se refrescan en los puntos de compactación** (§2.4, §7), no en cada turno, para no invalidar el prefijo por un cambio de un archivo que no le importa al turno actual.

### 4.3 Métrica y diagnóstico

`cacheHitRatio = prompt_eval_cached_count / prompt_eval_count` por turno, calculado con el campo `prompt_eval_cached_count` que expone Ollama `[HIPÓTESIS A PROBAR, fuente secundaria: disponible desde 0.33.3 según columna vertebral §8; a confirmar contra 0.34.1 en este equipo]`. Objetivo `≥ 85 %` en turnos posteriores al primero de un run `[HIPÓTESIS A PROBAR]`. Si cae por debajo de `50 %` sostenido, `Diagnostics` (§9 del documento de panel de rendimiento) muestra "el prefijo se reevalúa cada turno: template incompatible con el cache", porque la causa más común es que el `template` de Ollama para ese modelo antepone algo variable (por ejemplo una marca de tiempo) delante del contenido de SaurioLLM.

**Cómo se calibra en este equipo** `[HIPÓTESIS A PROBAR, método]`: correr un chat de 5-6 turnos con `qwen3:8b` o `qwen2.5-coder:7b` sin tocar archivos fuera del repo map inicial, leer `prompt_eval_count`/`prompt_eval_cached_count` de cada turno desde `messages.response_metrics_json`, y confirmar que el ratio sube después del primer turno. Si no sube, revisar el `template` del modelo con `ollama show --template <modelo>` antes de sospechar del `ContextBuilder`.

### 4.4 Precalentado del prefijo (previsto, opcional)

`[HIPÓTESIS A PROBAR, fuente secundaria: investigación de modelos chicos §8]`. Mitigación barata para la latencia percibida en modelos lentos: al abrir el chat (antes del primer turno real del usuario), mandar un request con el prefijo ya armado — system + tools + repo map — y `num_predict` bajo, solo para que el runner de Ollama compute y cachee ese prefijo por adelantado. Así el primer turno real del usuario ya encuentra el prefijo cacheado en vez de pagar su costo de "prompt eval" delante del usuario esperando. Queda marcado como opcional/previsto (no imprescindible para el MVP) porque depende de una hipótesis adicional sin confirmar: que `num_predict: 1` (o un valor bajo equivalente) evalúa el prompt sin generar una respuesta larga de forma confiable `[HIPÓTESIS A PROBAR; sin verificar contra 0.34.1 en este equipo]`. Verificación propuesta: al abrir un chat nuevo, mandar ese request de precalentado con `num_predict: 1`, y en el primer turno real del usuario medir `cacheHitRatio` (§4.3) — si da alto ya en ese primer turno real (en vez de recién en el segundo), el precalentado funciona como se espera.

### 4.5 Mensajes `truncated = 1` en la construcción del contexto

`[DECISIÓN DE DISEÑO]`. Un mensaje `assistant` puede quedar marcado `truncated = 1` cuando el provider se cae o se desconecta a mitad de la generación (columna vertebral §12, doc 10 §6 caso (3)): el runtime persiste el fragmento recibido hasta ese punto, pero ese fragmento no es la respuesta completa del modelo. `ContextBuilder.build` trata ese mensaje de forma distinta según qué arma:

- **Reintento inmediato del mismo turno** (el run reintenta la misma generación tras la caída, antes de que el turno cierre): el mensaje `truncated = 1` **se excluye** del prompt que arma `ContextBuilder`. Mostrarle al modelo su propia frase cortada como si fuera una respuesta completa lo induce a continuarla literalmente en vez de generar la respuesta de nuevo desde el principio.
- **Turno ya cerrado, retomado en un `run:continue` posterior:** el mensaje se **incluye**, pero con la marca `[respuesta cortada]` antepuesta a su contenido, para que el modelo sepa que ese texto no es una respuesta suya completa y pueda decidir si hace falta retomarla o si ya quedó resuelta por lo que vino después.

Esta regla se aplica en el paso `[6] Historial de la conversación` de §4.1, antes de que un mensaje `truncated = 1` entre al prompt; no cambia el orden de los demás bloques ni el prefijo estable (§4.2). Es la corrección que doc 10 §6 caso (3) señala como pendiente para este documento.

---

## 5. Presupuestos numéricos por `numCtx`

`[HIPÓTESIS A PROBAR]` en todos los valores de esta sección — son puntos de partida razonados a partir de los tamaños de bloque conocidos (system prompt, definiciones de tools, formato del repo map), no mediciones. Se calibran con el procedimiento del final de esta sección. Todos los presupuestos son campos de `ContextPolicy` (columna vertebral §5) y se pueden ajustar sin tocar código, por perfil (`profiles.config_json`, v0.2) o a mano en Settings.

| Bloque | 8k (modelos muy chicos / CPU) | 16k (`qwen3:8b`, `qwen2.5-coder:7b`, MVP) | 32k (KV q8_0, managed) | 64k+ (hardware grande) |
|---|---|---|---|---|
| System + protocolo + few-shot | 1.000–1.300 | 1.400–1.800 | 1.800–2.400 | 2.000–2.800 |
| Definiciones de tools (6-10) | 500–700 | 700–1.000 | 700–1.000 | 800–1.200 |
| Repo map | 700–1.000 | 1.500–2.000 | 3.000–4.000 | 6.000–10.000 |
| `SAURIO.md` + resumen + tasks | 200–300 | 300–500 | 500–800 | 800–1.200 |
| Historial vivo | 2.500–3.200 | 7.000–8.500 | 17.000–20.000 | 35.000–45.000 |
| Reserva de respuesta (`numPredict`) | 1.200–1.500 (2–3k en turnos `write_file`) | 2.000–2.500 (4-8k en turnos `write_file`) | 3.500–4.000 | 6.000–8.000 |
| Margen (error de estimación 10-15 %) | 500–700 | 1.000–1.500 | 2.000 | 3.000–4.000 |

Notas sobre la tabla:

- Las columnas 16k y 32k son las de la columna vertebral §8 (fuente de verdad); las columnas **8k** y **64k+** son una extrapolación con las mismas proporciones para completar el pedido de este documento — no están medidas ni estaban en la columna vertebral, y se marcan explícitamente como derivadas.
- **8k** es el piso realista para un modelo con `tools` que además necesite ver algo de repo map; por debajo de eso, el repo map deja de aportar (muy pocos archivos entran) y conviene bajar a modelos sin necesidad de tool calling complejo o aceptar más turnos de `search_code`/`read_file` puntuales en vez de un mapa amplio.
- **64k+** asume hardware con VRAM suficiente para cargar KV cache de ese tamaño sin offload (fuera del equipo de referencia de este proyecto, `[COMPROBADO EN EQUIPO]` RTX 3060 Ti 8 GiB) — es la fila que justifica la condición de hardware-agnosticidad: el mismo `ContextPolicy` escala subiendo estos números, sin tocar el `ContextBuilder` ni el resto del runtime.
- **Disparo de compactación distinto por tamaño de contexto:** a 32k+ la compactación dispara al mismo umbral de historial que a 16k **+50 %** en tokens absolutos, no al mismo porcentaje del contexto total, porque la hipótesis de trabajo es que la calidad de un modelo de 7-8B cae antes de que el contexto se llene físicamente `[HIPÓTESIS A PROBAR, fuente secundaria: RULER/NoLiMa, columna vertebral §8]`. Esto es una política, no una limitación técnica — se revisa cuando haya datos de `model_compat`/`quality_score` (Banco de pruebas, v0.3) que digan a partir de qué proporción de contexto ocupado cae la tasa de aciertos en `eval/` para cada modelo.
- **Nunca se manda más que `numCtx − reserveForResponse`.** Es el invariante que sostiene toda la tabla; `ContextManager` es el único guardián (§1). Ollama trunca el prompt por el frente en silencio si se lo pasa `[HIPÓTESIS A PROBAR, fuente secundaria: issues #8099/#7907, columna vertebral §8]` — nunca debe llegarse a ese caso.

### 5.1 Cómo se calibra `numCtx` y sus presupuestos en este equipo

`[HIPÓTESIS A PROBAR, procedimiento]`:

1. Cargar un modelo con `tools` que entre 100 % en GPU (`qwen3:8b` o `qwen2.5-coder:7b`, condición del roadmap MVP; columna vertebral §10) con `num_ctx = 16384` explícito.
2. Correr el recorrido de validación #1 (columna vertebral §15) completo una vez, y anotar por turno: `prompt_eval_count`, `eval_count`, `prompt_eval_cached_count`, y el tamaño en tokens que el propio `TokenEstimator` había calculado antes de enviar (`context.built` / `context.usage`, eventos de la columna vertebral §5).
3. Comparar la estimación pre-envío contra `prompt_eval_count` real: la diferencia porcentual es el error de calibración de ese momento; alimenta `token_calibration` (§8).
4. Repetir subiendo a `num_ctx = 32768` con KV cache en `f16` (attach; no se puede fijar `q8_0` sin modo managed, columna vertebral §9) y confirmar con `/api/ps` que `context_length` coincide con lo pedido y que `size_vram` no se disparó a un `offload_ratio` que arruine el tok/s.
5. Con esos dos puntos (16k y 32k medidos) se interpola si hace falta una fila intermedia; los valores de la tabla de 8k y 64k+ quedan como hipótesis sin medir hasta no tener un modelo instalado que los use.

---

## 6. Truncado de resultados de tool

Nivel 0 de compactación (columna vertebral §8), aplicado **siempre**, en el momento en que el resultado de la tool se genera, antes de que llegue al historial:

| Tool | Recorte | Stub que ve el modelo |
|---|---|---|
| `read_file` | 250 líneas (`maxReadLines`) | `[archivo de N líneas; usá start_line/end_line]` cuando el pedido excede el límite |
| `search_code` | 50 resultados (`maxSearchResults`) | `[N resultados más; refiná la búsqueda]` |
| `run_command` | primeras 40 + últimas 60 líneas | `[… N líneas omitidas; read_output(<toolCallId>) para ver todo …]` |
| `edit_file` (en el resumen de historial, no en el resultado inmediato) | — | `editado src/a.ts: +12 −3` (nivel 1, ver §7) |

El contenido completo de cualquier resultado que supere 30.000 caracteres se persiste igual en `appData/tool-outputs/<toolCallId>.txt` (columna vertebral §4); el `result_preview` en `tool_calls` es exactamente lo que el modelo vio, no lo completo — permite reconstruir en la UI qué tuvo el modelo delante en cada momento sin adivinar. El stub siempre incluye la instrucción de qué tool llamar para "releer" (`read_output`, o `read_file` con otro rango), en vez de simplemente decir "truncado": la disciplina de progressive disclosure exige que el modelo tenga un camino de vuelta al detalle sin tener que volver a ejecutar nada.

---

## 7. Compactación

`[DECISIÓN DE DISEÑO]`, tres niveles, ya introducidos en la columna vertebral §8; acá se detalla el algoritmo con foco en el disparador y en la preservación del prefijo.

### 7.1 Disparador

Cualquiera de estos tres eventos, evaluado al principio de cada turno (antes de construir el prompt, en `ContextBuilder.build`):

1. `tokens del historial > compactAtRatio (0,75 por defecto) × presupuesto de historial` de la `ContextPolicy` vigente.
2. Cada `compactEveryTurns` (25 por defecto), como salvaguarda si el ratio nunca se cruza pero la conversación es larga en cantidad de turnos con mensajes chicos.
3. Al detectar cambio de subtarea (heurística simple del MVP: el modelo llama `task_update` marcando una tarea `done` y otra `in_progress`; no hay clasificador semántico en el MVP).

**Nunca dispara** durante un reintento de formato (el turno de rescate con `format` de la columna vertebral §6 paso 5) — compactar a mitad de una recuperación de parseo agregaría una fuente más de inestabilidad justo cuando el runtime ya está lidiando con una.

### 7.2 Algoritmo (niveles 1 y 2 en un solo paso)

```
función compactar(historial, policy):
  candidatos = historial[:-policy.keepLastTurns]      # todo menos los últimos N turnos, verbatim
  reciente   = historial[-policy.keepLastTurns:]

  # Nivel 1: reducir tool results viejos a un renglón
  para cada mensaje en candidatos:
    si mensaje.role == 'tool' (o 'user' con <tool_result> en transporte texto):
      mensaje = reducir_a_stub(mensaje)   # ej. "editado src/a.ts: +12 −3"

  # Nivel 2: resumen estructurado con el mismo modelo del run
  resumen = llamar_modelo(
    prompt = plantilla_resumen,
    mensajes = candidatos (ya reducidos por nivel 1),
    think = false,
    format = schema_resumen,             # ver 7.3
  )

  nuevo_mensaje = { role: 'user', content: JSON.stringify(resumen), posición: fija (tras repo map) }
  marcar candidatos con compacted_by = nuevo_mensaje.id   # nunca se borran de `messages`
  devolver [system, few-shot, repo_map, memoria, nuevo_mensaje, ...reciente, efímero]
```

Niveles 1 y 2 se aplican **en la misma pasada** (columna vertebral §8) y no por separado, por una razón puntual de cache: cualquier cambio en el contenido del prompt antes del historial reciente invalida el prefijo cacheado de todos modos, así que conviene pagar esa invalidación una sola vez por compactación en vez de una vez por el recorte de nivel 1 y otra por el resumen de nivel 2.

**Corrección sobre slots de inferencia (regla correcta; reemplaza una redacción anterior repetida en cinco documentos).** `llamar_modelo(...)` en el paso de nivel 2 es una generación real: pasa obligatoriamente por `ModelGateway.chat`, no por un atajo interno. Por lo tanto **`compacting` adquiere un slot de inferencia** por la duración de esa llamada de resumen, con prioridad `interactive` y el mismo modelo del run — exactamente como cualquier otra generación del run. Solo `awaiting_permission` y `executing_tool` son estados que no ocupan slot (esperan al usuario o a un proceso externo, no al `ModelGateway`). Esta es la regla vigente: la columna vertebral ADR-5 y los documentos 05 §1/§2.6, 06 §8, 12 ADR-015 y 14 §6 deben leerse con esta corrección — antes decían que `compacting` tampoco ocupaba slot, lo cual dejaba esa generación fuera de `ModelGateway.status()`, de la cola y del panel de rendimiento, mostrando un run "compactando" sin nada en cola aunque la GPU estuviera ocupada. Con la regla corregida, `compacting` aparece en `status()` igual que `generating`, y el Scheduler y Telemetry lo contabilizan sin caso especial.

El resumen se inserta en la **posición fija** justo después del repo map (y de `SAURIO.md`) — no al final del historial ni intercalado — para que sea parte del bloque semi-estable del prompt (§4.1) y se recompacte junto con el repo map en el próximo ciclo, no se acumule un resumen tras otro sin límite.

### 7.3 Resumen estructurado

Esquema fijo (`format` de Ollama, o `argsSchema` equivalente si el modelo no soporta `format` de forma confiable):

```ts
interface CompactionSummary {
  objetivo: string;              // qué está tratando de lograr el run, en una oración
  archivos_tocados: string[];    // rutas relativas, con qué tipo de cambio si se sabe
  decisiones: string[];          // decisiones de diseño tomadas durante la conversación
  descubrimientos: string[];     // hechos sobre el código que valen para el resto del run
  pendientes: string[];          // lo que falta, en el orden en que se debería retomar
  ultimo_error: string | null;   // si el turno inmediatamente anterior a compactar falló, por qué
}
```

Se genera con `think: false` (no hace falta razonamiento largo para resumir; ahorra tokens de salida) y con el **mismo modelo del run**, no un modelo separado — evita cargar un segundo modelo en una GPU de 8 GB y mantiene la coherencia de estilo con el resto de la conversación. El mensaje resultante (`role: 'user'`) reemplaza a los mensajes compactados; estos quedan en `messages` con `compacted_by = <id del resumen>` y nunca se borran (auditoría completa, columna vertebral §4) — la UI puede mostrar "ver conversación completa" expandiendo los compactados aunque el modelo ya no los vea.

**Hipótesis adicional y piso si falla** `[HIPÓTESIS A PROBAR]`. El nivel 2 depende de que el modelo del run (7-8B) devuelva un `CompactionSummary` válido contra el `format` sin reintentos excesivos — una hipótesis de calidad de format-calling distinta (aunque relacionada) a la de tool-calling ya contemplada para el MVP. **Plan B, piso aceptable para el hito 1:** si el `format` falla repetidamente (se agotan los reintentos de rescate de la columna vertebral §6 paso 5 aplicados a esta llamada puntual), se degrada esa compactación a **nivel 1 puro**: se aplican solo los stubs de tool results (§7.2, primer bloque del algoritmo) sin generar el resumen de nivel 2, y `nuevo_mensaje` de la posición fija queda vacío o ausente en ese ciclo. Esto no bloquea el recorrido de validación #1 ni el run — el historial sigue reduciéndose (los tool results viejos igual se acortan a un renglón), solo se pierde el resumen estructurado de esa compactación puntual. Queda como hallazgo para el roadmap (fuera del alcance de este documento) agregar una fila explícita a la tabla de hipótesis a probar del hito con este caso.

### 7.4 Evento y preservación del prefijo

`context.compacted { summaryMessageId, tokensBefore, tokensAfter }` (columna vertebral §5) se emite al terminar; el próximo turno arranca con el prefijo `[system, few-shot, repo_map, memoria, resumen, últimos N turnos]` — el mismo esqueleto que antes de compactar, salvo que el historial largo se reemplazó por un bloque más corto. Esto es lo que permite que, **después** de la compactación, el prefijo vuelva a ser estable turno a turno (§4.2) hasta la próxima compactación: el resumen no cambia hasta el siguiente disparo, así que el cache vuelve a acumularse a partir de ahí.

---

## 8. Memoria de proyecto y memoria por agente

### 8.1 Memoria de proyecto

`[DECISIÓN DE DISEÑO]`. Dos mecanismos, complementarios:

- **`SAURIO.md`** en la raíz del proyecto: archivo opcional, editable por el usuario con cualquier editor (no solo desde SaurioLLM), hasta ≈ 200 líneas, inyectado en el prompt inmediatamente después del repo map (§4.1). Es el lugar para reglas persistentes del proyecto ("usamos pnpm, no npm"; "los tests van con vitest, no jest") que el usuario quiere que el agente respete siempre, sin tener que repetirlas en cada chat. MVP: solo lectura.
- **`project_memory`** (tabla SQLite, columna vertebral §4: `project_id, key, content, updated_at`): notas persistentes que el propio agente puede escribir, pensadas para hechos descubiertos durante el trabajo que conviene no tener que re-descubrir ("el endpoint de auth vive en `src/api/auth.ts`, no en `src/auth/`"). MVP: la tabla se crea (regla 8 de la columna vertebral, toda tabla existe desde la migración 1) pero no hay tool que escriba en ella todavía.
- **v0.2:** tool `remember(key, content)` con permiso `write` (ask por defecto, igual que cualquier escritura) que persiste en `project_memory`; y `.saurio/rules/*.md` con frontmatter `paths:` al estilo de las reglas por-carpeta de Claude Code, para reglas que solo aplican a una parte del repo.

### 8.2 Memoria por agente

La configuración vive en `AgentConfig.memory` (columna vertebral §5): `{ readProjectMemory: boolean; writeProjectMemory: boolean }`. Es deliberadamente chico en el MVP — dos flags booleanos, no una política rica — porque todavía no hay más de un tipo de memoria persistente que gobernar (regla 8 de la columna vertebral: una abstracción no existe hasta que algo del MVP la use). Un agente `explorer` de solo lectura, por ejemplo, tendría `readProjectMemory: true, writeProjectMemory: false`; un agente `coder` con permiso de `remember` (v0.2) tendría ambos en `true`.

No existe hoy una interfaz separada llamada `memoryPolicy`; se prefiere el campo `memory` ya definido en `AgentConfig` (ver "Desvíos" al final, sobre la nomenclatura del brief de este documento).

---

## 9. Estimación de tokens y calibración

`TokenEstimator.estimate(text, kind)` (columna vertebral §8) usa una heurística por caracteres, no un tokenizer real, para no cargar `tiktoken` WASM (que además tokeniza distinto al modelo real que está corriendo) ni depender de un endpoint `/api/tokenize` que Ollama 0.34 no expone `[VERIFICADO EN DOC OFICIAL: ausente en el `openapi.yaml` de Ollama, columna vertebral §1]`:

```
tokens ≈ chars(text) / ratio[kind]
ratio inicial = { prose: 3.8, code: 3.2, json: 2.8, path: 2.5 }
```

Después de cada respuesta, se compara la estimación pre-envío contra `prompt_eval_count` (el conteo real que devuelve Ollama) y se ajusta un factor de corrección **por modelo** con una media móvil exponencial, `α = 0,2`, persistida en `token_calibration(provider_id, model_name, ratio, samples, updated_at)` (columna vertebral §4). El conteo por mensaje se cachea (no se recalcula si el contenido no cambió). `[HIPÓTESIS A PROBAR]`: el error de estimación converge a `≤ ±5 %` después de 3-5 turnos con el mismo modelo — se verifica con el mismo procedimiento del §5.1, comparando la serie de estimaciones pre-envío contra `prompt_eval_count` turno a turno y viendo si el error decrece.

La interfaz queda abierta a un `TokenCounter` real (columna vertebral §8) para el día en que exista un endpoint de tokenización oficial de Ollama o un tokenizer embebido confiable — el resto del `ContextManager` no depende de si el conteo es heurístico o exacto, solo de que `TokenEstimator`/`TokenCounter` cumplan la misma forma `estimate(text, kind) → number`.

---

## 10. Adaptación a hardware

La condición de hardware-agnosticidad (condición 2) se resuelve en `ContextManager` sin tocar código, subiendo los números de `ContextPolicy` según lo que el equipo pueda sostener:

- **GPU chica (8 GB, este equipo `[COMPROBADO EN EQUIPO]`):** `numCtx` 16k por defecto (tabla §5), repo map de 1.500-2.000 tokens, un slot de inferencia (columna vertebral §14).
- **GPU con más VRAM o managed con KV `q8_0`:** `numCtx` 32k, repo map más grande, mismo `ContextBuilder`.
- **Hardware grande (múltiples GPUs, VRAM abundante, v0.4):** contextos de 64k+ (fila hipotética de §5), eventualmente varios agentes con `numCtx` distinto cada uno corriendo en paralelo si hay slots suficientes (columna vertebral §14) — la organización lógica (chats/agentes) ya es independiente de la concurrencia física, así que subir de 1 a N slots no cambia la máquina de estados, los eventos ni la UI, solo cuánto tarda en cola.
- **Qué NO se adapta solo:** el runtime nunca sube `numCtx` por su cuenta ni cambia de modelo para aprovechar más VRAM disponible — eso requeriría evidencia de `model_compat` (Banco de pruebas, v0.3) y sigue la misma regla que el resto de los ajustes automáticos (ADR-7, columna vertebral §1): el único ajuste automático del MVP es capear `numCtx` hacia abajo al `contextMax` real del modelo, nunca subirlo.

Esto es lo que separa "el mismo runtime corre en una notebook con 8 GB y en una estación con 80 GB" (multiplicando números de configuración) de "el runtime necesita otra arquitectura para hardware grande" (que sería una falla de diseño).

---

## Imprescindible para el MVP

- Repo map con tree-sitter para ts/tsx/js/py, PageRank con los pesos de §2.2, formato compacto de §2.3, cache por mtime en `repo_map_cache`, fallback a árbol plano para el resto de extensiones.
- Las cuatro tools de exploración (`list_files`, `search_code`, `read_file`, `read_output`) con los límites de §3, filtradas por modo.
- `ContextBuilder` con el orden de prefijo de §4.1, prefijo estable garantizado por las reglas de §4.2.
- Presupuestos de la columna 16k de §5, con el `ContextPolicy` como mecanismo de ajuste manual (no automático).
- Truncado nivel 0 (§6) siempre activo.
- Compactación niveles 0+2 en un solo paso (nivel 1 va junto, nunca solo — columna vertebral §16), con el esquema de resumen de §7.3.
- `SAURIO.md` en modo lectura (§8.1).
- `TokenEstimator` heurístico con calibración EMA contra `prompt_eval_count` (§9).

## Previsto para más adelante

- Repo map para 10 lenguajes más (v0.2).
- Presupuesto de 32k con perfiles activos y `.saurio/rules/*.md` (v0.2).
- Tool `remember` y escritura en `project_memory` (v0.2).
- Chequeo sintáctico post-edición como insumo adicional del contexto de error (v0.2).
- Embeddings/indexación semántica como complemento del repo map, nunca como reemplazo (v0.4).
- Ajuste automático de `numCtx` hacia arriba con evidencia de `model_compat` (v0.2/v0.3, ADR-7).
- `TokenCounter` real si Ollama expone tokenización exacta (sin fecha, condicionado a upstream).

---

## Nomenclatura agregada

- `ContextBudgetReport`: interfaz referenciada por el evento `context.built` en la columna vertebral (§5, `RunEvent`) pero no definida ahí. Se define acá como:
  ```ts
  export interface ContextBudgetReport {
    numCtx: number; reserveForResponse: number;
    blocks: { name: 'system' | 'tools' | 'repoMap' | 'memory' | 'summary' | 'history' | 'ephemeral'; tokens: number }[];
    totalTokens: number; fits: boolean;
  }
  ```
- `CompactionSummary`: forma del resumen estructurado de nivel 2 (§7.3), usada como `format`/`argsSchema` de la llamada de compactación; no estaba definida en la columna vertebral, que solo enumeraba sus campos en prosa (§8).
- `RepoMapClient.rank(query)`: ya nombrado en la columna vertebral (§2, componente `ContextManager`) sin firma; se documenta acá como `rank(query: string): Promise<{ path: string; score: number }[]>`, usado internamente por `ContextBuilder` para pedirle al indexer el orden de relevancia antes de aplicar el presupuesto de tokens.

## Desvíos respecto de la columna vertebral

- **Nombres de tools del brief vs. columna vertebral.** El encargo de este documento mencionaba `list_directory` y `read_range` como tools independientes. La columna vertebral no las define así: el listado es `list_files(path, depth?)` y el rango de lectura es un parámetro de `read_file(path, start_line?, end_line?)`, no una tool aparte (columna vertebral §3, §5, §8, y corrección de la condición 13). Se usó la nomenclatura real en todo el documento.
- **`memoryPolicy` vs. `AgentConfig.memory`.** El brief nombraba la memoria por agente como "memoryPolicy". La columna vertebral ya define el campo como `memory: { readProjectMemory, writeProjectMemory }` dentro de `AgentConfig` (§5). Se usó el nombre existente en vez de introducir uno nuevo, para no duplicar significado (regla de nomenclatura estricta del encargo).
- **Presupuestos de 8k y 64k+.** La columna vertebral (§8) solo detalla las columnas 16k y 32k. Las columnas 8k y 64k+ de la tabla de §5 de este documento son una extrapolación con las mismas proporciones, marcada explícitamente como no medida y no proveniente de la columna vertebral, para cumplir con el pedido del brief de cubrir "8k/16k/32k y contextos grandes en hardware grande". No contradice ni reemplaza los valores de 16k/32k de la fuente de verdad.

## Preguntas abiertas

Ninguna que cambie el diseño de este documento. Las preguntas abiertas de la columna vertebral (§20) relevantes a context management —principalmente cuál va a ser el primer modelo instalado con `tools` (pregunta 1) y si `qwen3:8b`/`qwen2.5-coder:7b` calibran igual a 16k que a 32k (parte de la pregunta 5, sobre el servidor Ollama y su contexto por defecto)— ya están planteadas ahí y no se repiten acá.
