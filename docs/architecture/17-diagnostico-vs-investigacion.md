# 17 — Diagnóstico del repo frente a la investigación de producto

**Fecha:** 2026-09-18 · **Autor:** sesión de Claude Code, a pedido del usuario · **Alcance:** contrastar `Investigacion_App_IA_Local.md` (en adelante "la investigación") y su mensaje de entrega contra el estado real de `N:\SaurioLLM`, sin tocar código.

**Leyenda:** `[COMPROBADO EN EQUIPO]` `[VERIFICADO EN DOC OFICIAL]` `[DECISIÓN DE DISEÑO]` `[HIPÓTESIS A PROBAR]` — se reutiliza la de los docs 00–16, no se inventa una nueva.

**Método.** Se leyó el código real (`packages/runtime/src`, `apps/desktop/src`, `packages/shared/src`), no solo los documentos 00–16 y el MANUAL, y se corrió `grep`/lectura de archivos puntuales para confirmar o descartar la existencia de cada pieza. Donde el código y el documento coinciden, se cita el código. Donde solo hay documento, se dice explícitamente.

---

## 0. Veredicto en una línea

El repo **no es un boceto vacío**: hay un runtime local (`@saurio/runtime`) con persistencia SQLite real, permisos, checkpoints y un ModelGateway ya agnóstico en su interfaz, validado de punta a punta contra Ollama real (`eval/harness.ts`, 6/6 pasos, dos corridas consecutivas, `docs/architecture/16-estado-de-implementacion.md` §6). Pero **todo lo que la investigación llama "Mis agentes"** — identidad personal persistente, equipos, delegación desde el chat, proactividad — **está ausente por completo**, no simulado ni parcial: no hay una sola línea de `AgentDefinition`, `Team` ni rutina en el código. El core actual resuelve bien el recorrido A (proyecto → chat → trabajo); los recorridos B, C y D de la investigación son trabajo nuevo, no ajustes sobre algo que ya exista.

---

## 1. Inventario R01–R14 con evidencia de código

### R01 — Simpleza por defecto: **implementado (parcial por diseño, no por atajo)**
Abrir carpeta → elegir modelo → conversar → aplicar cambio funciona sin crear nada adicional (`eval/harness.ts` lo ejecuta sin agentes ni equipos; `docs/MANUAL.md` §3 lo documenta paso a paso). Ojo con la trampa: esto es simple hoy **porque agentes y equipos todavía no existen para complicarlo**, no porque haya una arquitectura que los mantenga opcionales bajo carga real. La prueba T01 de la investigación (trabajar sin completar un asistente de equipos) todavía no se puede fallar, porque no hay asistente de equipos que evitar.

### R02 — Proyecto y chat como centro: **implementado, con límite conocido**
`Project`/`Chat`/`Message`/`ToolCall`/`Checkpoint` persisten en SQLite (migración 1, `docs/architecture/03-modelo-de-datos.md`); `project:open` en `apps/desktop/src/main/ipc/project.ts` persiste el proyecto y crea el `ProjectRuntime`. Límite real: **un solo proyecto abierto a la vez** (`docs/MANUAL.md` §4), lo cual no bloquea R02 pero sí compite con la idea de "equipos asignados a proyectos" de la investigación si en algún momento se quiere tener más de un proyecto vivo en simultáneo.

### R03 — Agentes personales persistentes: **ausente**
No existe `AgentDefinition` en el código. `packages/runtime/src/agent/defaults.ts` define un único **agente builtin hardcodeado** del MVP (`DEFAULT_AGENT_ID`, `numCtx` 8192, `thinking: off`, preset `balanced`, las 10 tools) — es configuración de ejecución, no una identidad de usuario creable/editable/duplicable. `grep` sobre `packages/` para `AgentDefinition|Team\b|proactiv|rutina` no devuelve nada salvo un archivo de soporte de tests (`agent/testSupport.ts`). No hay CRUD, no hay perfil, no hay dos usuarios con equipos distintos.

### R04 — Conversación directa con un agente concreto: **ausente**
Consecuencia directa de R03: no hay "Mis agentes" ni cabecera que distinga chat personal de chat de proyecto. Todo chat de hoy es chat de proyecto contra el agente builtin único.

### R05 — Equipos y grupos: **ausente**
No hay entidad `Team` ni chat grupal. Lo único que toca el tema es un **placeholder de esquema**: `tool_calls.category` incluye `'delegate'` en su `CHECK` desde la migración 1, y `runs.parent_run_id` existe como columna "pagada por adelantado" (`docs/architecture/06-permisos-y-modos.md` §2, `docs/architecture/12-decisiones.md`), pero sin tool `delegate` implementada ni lectura de esos campos en `RunController`. Es una columna reservada, no una funcionalidad simulada — no hay UI que la use ni la dibuje.

### R06 — Delegación desde el chat: **ausente**
Mismo hallazgo que R05: el diseño de v0.4 (`docs/architecture/16-estado-de-implementacion.md` §3) contempla "delegación a subagentes (`parentRunId`)" como subruns temporales del mismo motor, **no** como convocar a un agente personal persistente. Es una diferencia de fondo con la investigación, que se desarrolla en la sección 3 de este documento.

### R07 — Control sobre la automatización (tres controles independientes): **parcial**
Lo que sí existe es sólido: `packages/runtime/src/permissions/engine.ts` implementa un motor de permisos completo con invariantes duros, reglas por `scope` (`session`/`project`/`global`), presets `strict`/`balanced`/`trusting` y algoritmo de precedencia documentado (`docs/architecture/06-permisos-y-modos.md` §6), probado en `engine.test.ts`, `critical.test.ts`, `patterns.test.ts`. Pero eso cubre **un solo eje** — permisos de ejecución de herramientas —, no los tres controles independientes que pide la investigación (colaboración / selección de modelo / proactividad). Selección de modelo es manual y fija por chat, no "automático dentro de lo autorizado" (no existe política de auto-selección); colaboración no existe porque no hay delegación (R06); proactividad no existe (R08). Clasificar como implementado sería engañoso: hay una pieza excelente de un sistema de tres, no las tres.

### R08 — Proactividad opcional: **ausente**
No hay motor de eventos, rutinas, horarios ni bandeja de notificaciones en el código. Tampoco hay comportamiento de bandeja del sistema: `apps/desktop/src/main/index.ts` solo registra `app.on('before-quit', ...)` para liberar el runtime y cerrar la terminal — no hay `Tray`, no hay "minimizar a bandeja", no hay distinción entre cerrar ventana y salir del proceso. Cerrar la ventana hoy termina el proceso sin más. Esto también significa que la advertencia central de la investigación ("no prometer trabajo local con la PC apagada") todavía no aplica porque no hay ninguna promesa de continuidad en bandeja que corregir — pero tampoco hay la explicación de estado que la investigación pide en la sección 9.

### R09 — Gestión inteligente de modelos: **parcial**
Lo real: `ModelManager` (`packages/runtime/src/models/`) consulta `/api/tags`, `/api/show`, `/api/ps`, expone `capabilities`, corre un único poller de `/api/ps` (5 s/30 s, sin duplicar), y `MemoryEstimator.fits()` etiqueta cada número `measured`/`estimated` (`docs/architecture/08-model-manager-y-scheduler.md` §5, con la fórmula completa y su procedimiento de calibración pendiente). `HardwareProbe` lee `nvidia-smi` bajo demanda. Lo que falta: descarga de modelos (`models:pull`/`models:delete`) es v0.2, catálogo curado y motor de recomendación son v0.3 (`docs/architecture/16-estado-de-implementacion.md` §3) — hoy "instalar un modelo" significa correr `ollama pull` a mano fuera de la app (`docs/MANUAL.md` §4). No hay nada simulado: donde no hay dato medido, la UI dice `unavailable`, no inventa un número (principio explícito de doc 08 §5.4).

### R10 — Recursos coordinados: **parcial, diseño correcto pero subprobado**
El punto más importante de la investigación —"muchos agentes guardados, concurrencia limitada"— está bien resuelto **en diseño**: `docs/architecture/00-resumen-ejecutivo.md` §2 separa explícitamente organización lógica (ilimitada) de capacidad física (slots), y `InferenceScheduler` vive dentro de `ModelGateway` con cola por `(providerId, modelName)` y agrupamiento por modelo (`docs/architecture/08-model-manager-y-scheduler.md` §7, `Scheduler.test.ts`). El límite real: en este equipo el slot queda fijo en 1 por VRAM < 24 GiB `[COMPROBADO EN EQUIPO: RTX 3060 Ti 8 GiB]`, y como todavía no hay múltiples agentes (R03 ausente), el escenario "cinco agentes guardados, uno infiriendo" nunca se ejerció de punta a punta — solo se probó con un run a la vez.

### R11 — Medición y actividad: **parcial**
Hay métricas reales por respuesta (`prompt_eval_count`, `eval_count`, tok/s medido: 59–68 tok/s con `qwen3:8b`/`qwen2.5-coder:7b` en este equipo, `docs/MANUAL.md` §7) y el principio de etiquetar `measured`/`estimated`/`unavailable` está aplicado consistentemente (doc 08, doc 14). Falta el muestreo continuo con historial y la vista avanzada con series temporales — son v0.2 (`docs/architecture/16-estado-de-implementacion.md` §3).

### R12 — Local primero y transparente: **implementado para lo que existe hoy**
`ModelGateway.chat()` rechaza cualquier locality no autorizada con un `ChatChunk` de error **sin llamar al provider**, nunca hay fallback silencioso — está probado explícitamente: *"chat(): locality no autorizada nunca cae a nube — emite ChatChunk de error y no llama al provider"* (`packages/runtime/src/gateway/ModelGateway.test.ts`). El matiz honesto: hoy solo existe un provider (`OllamaProvider`), así que el invariante está codeado y testeado, pero el escenario real "un provider remoto disponible que casi se usa por error" todavía no tiene con qué ejercitarse.

### R13 — Trabajo inspeccionable: **parcial, con huecos nombrados por el propio equipo**
Lo fuerte: checkpoints content-addressed, diff exacto, revert byte a byte probado (`docs/MANUAL.md` §3 y §5, `docs/architecture/16-estado-de-implementacion.md` §6), historial persistente que sobrevive a reinicios (`eval/harness.ts` paso f: cerrar y reabrir la base en otra instancia y leer el historial). Los huecos, documentados por el propio equipo, no descubiertos ahora: **(1)** el permiso `ask` ("preguntar siempre") nunca se ejerció contra un modelo real — el preset por defecto (`balanced`, `write = allow` en el workspace) nunca disparó `awaiting_permission` en las pruebas (`docs/architecture/16-estado-de-implementacion.md` §5, `docs/MANUAL.md` §4); **(2)** reanudar un run que quedó `awaiting_permission` después de reiniciar la app **no funciona** — `answerPermission` solo resuelve runs vivos en el proceso actual (`docs/architecture/16-estado-de-implementacion.md` §4, ítem 10); **(3)** el escenario exacto que pide la investigación en su "prueba crítica" (§14: cambios del usuario + del agente + de un tercero, deshacer sin perder nada ajeno) no aparece ejercitado en ninguna corrida registrada — hay revert de un checkpoint puntual probado, no el escenario de conflicto de tres actores.

### R14 — Continuidad del desarrollo: **implementado como método, no como feature**
Es un requisito de proceso, no de producto, y se cumple: siete commits incrementales sin reescrituras (`git log`), documentos 00–16 que se corrigen entre sí sin descartarse (`docs/architecture/06-permisos-y-modos.md` §12 "Desvíos" es el ejemplo más claro: dice explícitamente qué cambió respecto de la columna vertebral y por qué), y este mismo documento es la instancia número 17 de ese método aplicado a la investigación nueva.

---

## 2. Matriz de brechas

| Requisito | Estado | Brecha principal | Bloquea a |
|---|---|---|---|
| R03/R04 Agentes personales | Ausente | No existe `AgentDefinition` ni CRUD; solo un agente builtin hardcodeado | R05, R06, buena parte de R07 |
| R05/R06 Equipos y delegación | Ausente | `delegate`/`parent_run_id` son columnas reservadas sin implementación; el diseño de v0.4 (subagentes temporales) no es lo mismo que "Mis agentes" persistentes | R07 (eje colaboración) |
| R07 Tres controles independientes | Parcial | Solo el eje de permisos de ejecución está resuelto; selección de modelo automática y proactividad no existen | — |
| R08 Proactividad | Ausente | Sin motor de eventos/rutinas; sin `Tray`, sin distinción ventana/bandeja/salida/suspensión | R07 (eje iniciativa) |
| R09 Modelos: descarga/recomendación | Parcial | `models:pull`, catálogo curado y `RecommendationEngine` son v0.2/v0.3, no MVP | Onboarding sin terminal |
| R10 Recursos coordinados | Parcial (diseño correcto) | Nunca probado con más de un agente real compitiendo por el slot | Validación con R03 resuelto |
| R11 Medición | Parcial | Falta muestreo continuo e historial (v0.2) | Panel de rendimiento completo |
| R13 Trabajo inspeccionable | Parcial | Permiso `ask` no probado e2e; reanudar `awaiting_permission` tras reinicio no funciona; conflicto de tres actores no probado | Próxima entrega (§5) |
| R01/R02/R12/R14 | Implementados | Límites conocidos y documentados (un solo proyecto, un solo provider) | — |

---

## 3. Decisiones de arquitectura: conservar, corregir, evaluar

### (a) La dependencia de Ollama — el temor de "estar muy cerrados"

**Lo que ya es agnóstico, en código, hoy:**

- `Provider` (`packages/runtime/src/gateway/Provider.ts`) es una interfaz con `kind: 'ollama' | 'openai-compat' | 'cloud'` — el comentario del propio archivo dice explícitamente: *"Un Provider habla con UN backend de inferencia (Ollama, LM Studio, llama.cpp server, cloud)"*.
- `ModelGateway` es el único punto de entrada de inferencia; `ModelManager` recibe la lista de providers **del Gateway**, nunca instancia `OllamaProvider` por su cuenta (doc 08 §1) — no hay lógica de Ollama filtrada en `RunController` ni en el resto del runtime.
- Ya existe un stub reservado para el segundo provider: `packages/runtime/src/gateway/providers/openai-compat/index.ts` — hoy es literalmente `export {}`, pero el lugar, el nombre de archivo y el comentario ("mismo patrón que ollama/ para LM Studio / llama-server OpenAI-compatible") ya están puestos.
- El documento 08 §8 ya tiene la tabla completa de degradación para un provider OpenAI-compatible (qué se pierde: `/api/ps`, duraciones separadas de `eval_count`, `keep_alive`) — no es una idea nueva de la investigación, es trabajo de diseño ya hecho y sin implementar.

**Lo que falta, concretamente, y su costo:**

- Implementar `OpenAICompatProvider` de verdad (LM Studio, `llama-server` con `/v1`, vLLM con API compatible): costo bajo-medio, porque el contrato ya está definido y la degradación ya está especificada; es la tarea de v0.2 que ya estaba en el roadmap antes de esta investigación (`docs/architecture/16-estado-de-implementacion.md` §3). No es una corrección de arquitectura: es completar un casillero ya reservado.
- Recomendación: **no es necesario adelantar esto de urgencia por el temor a "estar cerrados en Ollama"** — el acoplamiento real hoy es de una sola pieza concreta (`OllamaProvider`), no de la interfaz. El riesgo de lock-in existiría si `RunController`, `PermissionEngine` o `ContextManager` conocieran algo de Ollama — no es el caso; toda la especificidad de Ollama vive detrás de `Provider.chat()`. Sí conviene subir la prioridad de `OpenAICompatProvider` en el roadmap si el usuario quiere probar LM Studio pronto, porque es barato y ya está diseñado.

**Motor embebido (llama.cpp / node-llama-cpp) como provider adicional:**

Evaluado y **no recomendado por ahora**. Costo: requiere bindings nativos propios (mismo tipo de riesgo que ya complicó `better-sqlite3`/`node-pty` en Electron 44, ver `docs/architecture/16-estado-de-implementacion.md` §4 "Módulos nativos... la app no arranca"), y obliga a reimplementar gestión de memoria/hilos que Ollama ya resuelve. Beneficio real: distribución sin depender de que el usuario instale Ollama aparte — es un beneficio genuino para onboarding, pero no resuelve ningún requisito R01–R14 que no esté ya cubierto por el modo *attach* a Ollama. `[DECISIÓN DE DISEÑO]` Queda como candidato de evaluación para E5, no como parte del núcleo — encaja en la interfaz `Provider` sin cambios si se decide más adelante.

### (b) Integración con Codex u otro runtime

Tal como pide la investigación, se trata como opción a evaluar, no como obligación. El propio documento 19 de la investigación (§"Tres caminos") ya lo dice: Codex App Server es experimental y su documentación oficial advierte contra exponerlo como interfaz de confianza [VERIFICADO EN DOC OFICIAL, citado en la investigación, fuente S15]. SaurioLLM ya tiene, funcionando y validado end-to-end, su propio motor de conversación, permisos, checkpoints y recuperación (`eval/harness.ts`, doc 16 §6) — adoptar Codex hoy significaría mantener dos motores de ejecución de código en paralelo sin necesidad demostrada. Recomendación: **no integrar ahora**. Revisar en E5 solo si aparece un caso concreto que el runtime propio no resuelva razonablemente (por ejemplo, worktrees de git para tareas paralelas) y donde el costo de replicarlo internamente sea mayor que el de adaptar un protocolo experimental externo.

### (c) La arquitectura de la investigación es una recomendación, no código interno de Grok Bot

Se deja constancia explícita, como pide el mensaje del usuario: el esquema `AgentDefinition`/`Team`/`Task` de la sección 06 de la investigación se presenta ahí mismo como *"contrato ilustrativo, no API existente"* (investigación, líneas 202-215) — el propio documento de investigación ya se cuida de esto. Este diagnóstico no reproduce esa estructura como si fuera el diseño interno conocido de Grok Bot; la usa como punto de partida a validar contra lo que el repositorio ya modela (`AgentConfig`, `PermissionPolicy`, `run_events`) antes de nombrar tablas nuevas.

---

## 4. Backlog por recorridos funcionales y plan incremental E0–E5

El roadmap interno ya existente (`docs/architecture/11-roadmap.md`: Etapa 0 → MVP → v0.2 → v0.3 → v0.4) no se descarta — se **mapea** contra el E0–E5 de la investigación, porque no son la misma cosa: el roadmap interno ordena por dependencia técnica dentro del núcleo ya construido; el E0–E5 de la investigación ordena por recorrido de producto completo, incluyendo agentes personales y equipos que el roadmap interno todavía no modela como entidad propia (los confunde parcialmente con los "subagentes" de v0.4, que son un concepto distinto — ver el hallazgo de R05/R06 en §1 y el conflicto documentado en §6).

| Etapa investigación | Qué es | Relación con el roadmap interno | Dependencias | Riesgo principal |
|---|---|---|---|---|
| **E0** | Contrastar boceto (este documento) | Nuevo, no existía | Ninguna | Que se lea como autorización para reescribir — no lo es |
| **E1** | Primer recorrido local completo | Ya construido en un ~85%: MVP actual + cierre de los huecos de R13 (§5) | E0 | Cerrar `ask` y `awaiting_permission` tras reinicio sin tocar lo que ya funciona |
| **E2** | Agentes personales + biblioteca de modelos | **Trabajo nuevo real**, no está en v0.2/v0.3 del roadmap interno tal cual. Requiere una entidad `AgentDefinition` distinta del "subagente" (`parent_run_id`) ya reservado para v0.4 | E1 estable | Confundir "subagente temporal" (delegación de una tarea) con "agente personal persistente" (identidad) es el error de diseño más probable si se arranca sin un doc propio |
| **E3** | Equipos y colaboración coordinada | Nuevo; usa el protocolo de entrega entre agentes que la investigación especifica (objetivo/límites/entregable/criterio) | E2 | Que el chat grupal dispare N inferencias simultáneas sin pasar por el `InferenceScheduler` ya construido (R10) |
| **E4** | Skills y proactividad acotada | Nuevo; requiere motor de eventos y `Tray` de Electron, ninguno existe hoy (`apps/desktop/src/main/index.ts` no tiene `Tray`) | E1 (estabilidad), diseño de eventos previo | Prometer continuidad en bandeja antes de implementarla — la investigación lo marca como riesgo explícito (§9) |
| **E5** | Ampliación basada en evidencia | Coincide en gran parte con v0.3/v0.4 ya planeados: `OpenAICompatProvider`, cliente MCP (`packages/runtime/src/mcp/index.ts`, hoy `export {}`), N slots | E2–E4 según el ítem | Adelantar conectores antes de tener permisos de equipos maduros |

**Recorridos funcionales, en orden de valor entregable:**

1. **Recorrido A (proyecto → chat → trabajo).** Consolidar lo que ya funciona: cerrar los tres huecos de R13, agregar `files:tree` (falta el canal IPC, `docs/architecture/16-estado-de-implementacion.md` §4 ítem 11), evaluar si conviene levantar el límite de un solo proyecto abierto.
2. **Recorrido B (Mis agentes).** Diseñar `AgentDefinition` como documento propio (probablemente doc 18) antes de tocar código — no reutilizar el esquema `agents` actual sin revisarlo, porque hoy esa tabla modela configuración de ejecución de un run, no identidad persistente de usuario.
3. **Recorrido C (equipos).** Depende de B; reutiliza el `InferenceScheduler` sin cambios (ya separa organización lógica de capacidad física, R10).
4. **Recorrido D (proactividad).** Depende de tener un motor de eventos, que hoy no existe en ninguna forma (ni siquiera como stub reservado, a diferencia de `delegate` o `mcp`).
5. **Recorrido E (multi-provider y conectores).** Bajo costo, alto valor simbólico contra el temor de lock-in: completar `OpenAICompatProvider`.

---

## 5. Próxima entrega verificable

**Qué.** Cerrar los tres huecos nombrados en R13 sobre el recorrido ya validado (proyecto → chat → lectura → propuesta → aprobación → aplicación → diff → recuperación), sin tocar `apps/desktop/src/renderer` (en edición paralela) y sin abrir trabajo de R03–R08:

1. Ejercitar el permiso `ask` de punta a punta contra un modelo real (`qwen3:8b`), con preset `strict` o una regla explícita `write: ask`, verificando que `awaiting_permission` se dispare, se muestre la tarjeta con los cinco campos de doc 06 §8, y que responder `allow_once`/`deny` se registre en `permission_decisions`.
2. Ejercitar el transporte de texto (`TextToolProtocol`, Hermes `<tool_call>`) de punta a punta con `qwen2.5-coder:7b` en modo `agent` con una tool mutante real — hoy solo está confirmado que el modelo no usa tool calling nativo pese a declarar `tools: true` (`docs/MANUAL.md` §7), pero no hay una corrida completa de `eval/harness.ts` con ese transporte.
3. Reproducir el escenario de recuperación sin pérdida que pide la investigación (§14, "prueba crítica"): cambio previo del usuario + cambio del agente + cambio manual de un tercer archivo mientras el run está activo + revert — y documentar si el resultado conserva lo ajeno o si corresponde ajustar `CheckpointService`.

**Cómo se prueba.** Extender `eval/harness.ts` (mismo patrón: fixture temporal, SQLite en otra carpeta temporal, contra Ollama real, sin Electron) con tres pasos nuevos correspondientes a los puntos 1–3, siguiendo el mismo formato de `report(step, ok, evidence)` ya usado. Cada paso debe quedar en verde en al menos dos corridas consecutivas, igual que el criterio ya aplicado al recorrido #1 (`docs/architecture/16-estado-de-implementacion.md` §6). El reanudar `awaiting_permission` tras reinicio (ítem 10 de doc 16 §4) se deja fuera de esta entrega porque requiere cambios de `RunController`/`recover()`, no solo de prueba — se documenta como pendiente explícito, no se oculta.

---

## 6. Incertidumbres, simulaciones y limitaciones de hardware

- **Nada en el runtime actual está simulado** en el sentido que la investigación advierte (números inventados, "agente" sin identidad, "monitor" con datos de ejemplo): donde falta un dato medido, el código dice `unavailable`, no lo inventa (doc 08 §5.4, confirmado en `ModelGateway.test.ts` y en el propio MANUAL). Esto es una fortaleza real del proyecto, no una afirmación de marketing — está probado en test unitarios y en la corrida end-to-end.
- **Hardware del equipo de desarrollo:** RTX 3060 Ti, 8 GiB VRAM, 32 GiB RAM `[COMPROBADO EN EQUIPO]` — coincide con el perfil provisional que la investigación toma "de la conversación previa" (investigación §11), pero la investigación aclara correctamente que no es una detección propia suya; acá sí es medición real y repetida (`docs/MANUAL.md` §7).
- **1 slot de inferencia es un límite físico medido, no una decisión conservadora sin fundamento**: con esta GPU, `qwen3:8b` a `num_ctx` 16384 ya no entra 100% en GPU (offload ≈19.5%, 17–20 tok/s vs 59–65 tok/s a 8192) `[COMPROBADO EN EQUIPO]`. Cualquier plan que asuma "varios agentes infiriendo a la vez" en este equipo específico es `[HIPÓTESIS A PROBAR]` sin sustento hoy.
- **La fórmula de estimación de VRAM (`MemoryEstimator.fits`) sigue sin calibrar contra mediciones reales** — el propio doc 08 §5.2 la marca `[HIPÓTESIS A PROBAR]` y describe el procedimiento de calibración (Banco de pruebas, v0.3) que todavía no corrió.
- **El empaquetado de la app está roto**: `SaurioLLM-build.cmd` falla al armar la carpeta desempaquetada por una ruta mal resuelta de `electron-builder` (`docs/MANUAL.md` §2, error literal documentado). Cualquier plan de distribución (E5, motor embebido, instalador) depende de resolver esto primero — no es parte de esta entrega pero condiciona cuánto se puede prometer sobre "instalación simple para el usuario final".
- **Conflicto detectado entre el documento de investigación y el estado real del proyecto:** la investigación pide (§04, R03) que "dos instalaciones nuevas no estén obligadas a tener el mismo equipo" de agentes — pero el roadmap interno ya tiene reservado, con ese mismo nombre conceptual ("subagentes"), un mecanismo distinto (`parent_run_id`, delegación temporal de v0.4) que no sirve para modelar identidad persistente. **Alternativa propuesta:** tratar "agentes personales" (R03/R04) y "subagentes de delegación" (v0.4 ya planeado) como dos entidades separadas desde el diseño de E2, en vez de forzar una sobre la otra — conserva el trabajo ya hecho en `parent_run_id`/`delegate` para lo que fue pensado (delegación dentro de un run) sin bloquear la identidad persistente que pide el usuario.
- **No se ejecutaron pruebas ni builds durante este diagnóstico** — es lectura de código y documentos únicamente, tal como pidió el encargo; los números citados como `[COMPROBADO EN EQUIPO]` provienen de `docs/architecture/16-estado-de-implementacion.md` y `docs/MANUAL.md`, fechados el mismo día, no de una medición nueva de esta sesión.

---

**Cierre.** No se tocó código ni configuración. El único archivo nuevo de esta entrega es este documento.
