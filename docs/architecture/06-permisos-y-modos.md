# 06. Sistema de permisos y modos

Cómo SaurioLLM decide qué puede hacer el agente en cada momento: modos de trabajo, categorías de acción, reglas, algoritmo de evaluación, memoria de decisiones, UI del permiso, auditoría y su relación con checkpoints y subagentes.

**Leyenda:** `[COMPROBADO EN EQUIPO]` `[VERIFICADO EN DOC OFICIAL]` `[DECISIÓN DE DISEÑO]` `[HIPÓTESIS A PROBAR]`

---

## 1. Modos

`[DECISIÓN DE DISEÑO]` Cuatro modos, cada uno define el `Mode` (`packages/shared/src/enums.ts`, `z.enum(['plan','ask','edit','agent'])`) que usa el `AgentRuntime` para filtrar el set de `ToolDefinition` **antes** de renderizar el prompt (`ToolRegistry.list({ mode })`). El modo no es una capa de permisos adicional: es el primer filtro, más restrictivo que cualquier regla — una tool que el modo excluye no llega a describirse al modelo, y si el modelo la nombra igual (alucinada o por un transporte de texto que la reconoce), `ToolProtocol.parse` la trata como tool desconocida y el runtime la rechaza sin pasar por `PermissionEngine`.

| Modo | Tools habilitadas (de las 10 builtin del registro; condición 13.a) | Qué puede modificar | `thinking` por defecto | Uso típico |
|---|---|---|---|---|
| `plan` | `list_files`, `search_code`, `read_file`, `read_output`, `task_update`, `finish` (6 tools) | Nada. Ninguna tool de esta lista es `mutating: true` | `true` si el modelo soporta `thinking` `[DECISIÓN DE DISEÑO]` | Explorar y proponer un plan antes de tocar código |
| `ask` | Las de `plan` + `finish` conversacional (sin `Plan` estructurado obligatorio) | Nada | `false` | Preguntar sobre el código sin generar checklist ni tocar archivos |
| `edit` | Lectura (`list_files`, `search_code`, `read_file`, `read_output`) + `edit_file`, `write_file`, `delete_file`, `task_update`, `finish` | Archivos del workspace. Nunca `run_command` | `false` | Ediciones dirigidas sin ejecutar comandos |
| `agent` | Todas las permitidas al agente (`AgentConfig.allowedTools`; por defecto las 10 builtin) | Archivos y comandos del workspace, dentro de lo que autorice `PermissionEngine` | `false` `[HIPÓTESIS A PROBAR, fuente secundaria: aider polyglot Qwen3]` | Loop completo: explora, edita, ejecuta, itera |

**MVP:** `plan` y `agent` (§6 y §7 de la columna vertebral los marcan como los dos modos del hito 1). `ask` y `edit` son filtros triviales sobre el mismo mecanismo — no requieren nuevo código en `PermissionEngine` ni en el `ToolRegistry`, solo la entrada en la tabla de arriba y su UI de selección — y entran en v0.2 junto con su selector en la barra del chat.

**Relación con `AgentConfig.defaultMode`.** Cada agente tiene un modo por defecto (`agents.default_mode` / `AgentConfig.defaultMode`); el chat puede cambiarlo por run (`run:start({ mode })`). El modo efectivo de un run queda congelado en `EffectiveConfig` al entrar en `preparing` y no cambia durante la ejecución; para cambiar de modo hay que iniciar un run nuevo.

---

## 2. Clases de acción y política por defecto

`PermissionCategory` (`packages/shared/src/enums.ts`) tiene ocho valores en la columna vertebral: `read`, `write`, `delete`, `terminal`, `git_commit`, `git_push`, `network`, `mcp`. Este documento agrega una novena, `delegate`, para cubrir la tool `delegate` de subagentes (v0.4; ver §9) — se documenta como adición de nomenclatura en §12, no como cambio del MVP.

**Decisión sobre el `CHECK` de `tool_calls.category` (doc 03).** `delegate` se agrega al `CHECK (category IN (...))` de `tool_calls` **desde la migración 1**, igual que otras columnas "pagadas por adelantado" del Principio 8 (`runs.parent_run_id`, `tool_calls.status = 'awaiting_input'`): sin uso real hasta que la tool `delegate` exista en v0.4, pero sin requerir una migración de esquema para agregarlo después. `[DECISIÓN DE DISEÑO]` Esto evita romper la regla de "todas las tablas se crean en la migración 1" cuando `delegate` se active. **Nota de coordinación (resuelta):** el `CHECK` de `tool_calls.category` vive en el doc 03 (§4 de la columna vertebral); 03-modelo-de-datos.md **ya** tiene `CHECK (category IN ('read','write','delete','terminal','git_commit','git_push','network','mcp','delegate'))` en su DDL y **ya** documenta `delegate` en su propia sección de Desvíos/Nomenclatura agregada — la coordinación entre ambos documentos está cerrada, no queda pendiente ningún cambio en 03.

| Categoría | Qué cubre | Política por defecto (preset `balanced`) | Disponible desde |
|---|---|---|---|
| `read` | `list_files`, `search_code`, `read_file`, `read_output` | `allow` | MVP |
| `write` | `edit_file`, `write_file` | `ask`, hasta que el usuario elija "permitir ediciones en este proyecto" (crea `PermissionRule` con `pattern: 'edit_file(**)'` y otra con `pattern: 'write_file(**)'`, `scope: 'project'`) | MVP |
| `delete` | `delete_file`; `run_command` clasificado como borrado (`rm`, `del`, `Remove-Item`) | `ask` | MVP |
| `terminal` | `run_command` no clasificado en otra categoría | `ask`, salvo que el comando matchee `PermissionPolicy.terminalAllowlist` o una regla `allow` | MVP |
| `git_commit` | `run_command` clasificado como `git commit` | `ask` | v0.2 (tool dedicada; en MVP es `run_command` genérico bajo `terminal` si el usuario lo ejecuta desde la terminal manual, no desde el agente) |
| `git_push` | `run_command` clasificado como `git push` | `ask` **siempre**, sin regla `allow` posible (invariante, §4) | v0.2 |
| `network` | `run_command` clasificado como `curl`/`wget`/`Invoke-WebRequest`; llamadas de providers no locales (`locality ≠ 'local'`) | `ask` | v0.3 |
| `mcp` | Cualquier tool con `source.kind = 'mcp'` | `ask` por tool la primera vez; después según regla | v0.3 |
| `delegate` *(agregada, §12)* | Tool `delegate` que crea un subrun (`parent_run_id`) | `ask`, y además acotada por el invariante de herencia de permisos (§9) | v0.4 |

El **preset** (`PermissionPolicy.preset: 'strict' | 'balanced' | 'trusting'`) desplaza esta tabla completa hacia más `ask` (`strict`) o más `allow` (`trusting`) salvo los invariantes de §4, que ningún preset destraba. `balanced` es el preset inicial `[DECISIÓN DE DISEÑO]`; `strict` sube `read` de archivos fuera de `src/**` a `ask` y no ofrece "permitir siempre" para `write`; `trusting` pasa `write`/`delete` a `allow` dentro del workspace desde el día 1 pero deja `git_push` y los invariantes intactos.

**Nota de alcance.** `git_commit` y `git_push` como categorías distinguibles de `terminal` genérico dependen de tools dedicadas (v0.2, condición implícita: por ahora el agente solo tiene `run_command`). En el MVP, si el modelo ejecuta `git commit`/`git push` vía `run_command`, `classify()` ya los reconoce y les aplica la categoría correcta (§3) aunque no exista una tool `git_commit`/`git_push` separada — la categorización es por contenido del comando, no por nombre de tool.

---

## 3. Clasificación por argumentos (`classify`)

`ToolDefinition.classify(args)` (interfaz en `packages/runtime/src/tools/types.ts`) devuelve `{ category, risk, summary, paths?, command? }`. Para `run_command`, `CommandParser` (interfaz genérica por shell, `CommandParser.forShell(shell)`) descompone el comando en subcomandos y clasifica cada uno. **MVP: solo `pwsh`** (separadores `;`, `|`, `&&`, `||`, `& { }`, `Invoke-Expression`, `-Command`) — es el único shell relevado en la máquina del usuario (Windows sin bash/WSL) y el único que necesita el recorrido de validación #1. El parser `bash` (`&&`, `||`, `;`, `|`, `$( )`, subshells) queda **previsto para más adelante** (se activa cuando exista un entorno real con bash — WSL, mac o Linux — para probarlo); no implica rediseñar `CommandParser`, que ya es genérico por shell, así que agregar `bash` después es una extensión, no un cambio de interfaz `[DECISIÓN DE DISEÑO]`.

| Patrón detectado | Categoría | Ejemplo |
|---|---|---|
| `rm`, `del`, `Remove-Item` | `delete` | `Remove-Item .\dist -Recurse` |
| `git commit` | `git_commit` | `git commit -m "fix"` |
| `git push` | `git_push` | `git push origin main` |
| `curl`, `wget`, `Invoke-WebRequest` | `network` | `curl https://api.example.com` |
| cualquier otro | `terminal` | `npm test`, `pnpm build` |

**Regla de agregación:** si el comando tiene varios subcomandos, la categoría del conjunto es la **más restrictiva** de todas (orden `delete`/`git_push` > `git_commit`/`network` > `terminal`), y **todos** los subcomandos deben matchear una regla `allow` para que el conjunto se apruebe automáticamente; si uno solo no matchea o el parser no está seguro de haber separado bien la cadena, la decisión es `ask` `[DECISIÓN DE DISEÑO]` — nunca `allow` por default en caso de duda.

`edit_file`, `write_file` y `delete_file` no pasan por `CommandParser`: declaran `paths` directamente en su `classify()` a partir del argumento `path`, normalizado y resuelto contra el workspace (sin `..` que escape la raíz).

---

## 4. Reglas: sintaxis, patrones y ejemplos

`PermissionRule` (`packages/runtime/src/agent/types.ts`):

```ts
interface PermissionRule {
  id?: string;
  scope: 'session' | 'project' | 'global';   // "este run" | "este proyecto" | "siempre"
  toolName: string;                           // nombre exacto de la tool, o '*' para run_command con patrón de comando
  pattern?: string;
  decision: 'allow' | 'ask' | 'deny';
  source: 'user' | 'preset' | 'mode' | 'settings';
}
```

**Sintaxis de `pattern` por tipo de tool** `[DECISIÓN DE DISEÑO]`:

- **`run_command`**: prefijo de tokens, coincide con el comando ya tokenizado (no con la cadena cruda). `*` al final matchea cualquier continuación con el mismo prefijo de tokens; sin `*` es coincidencia exacta de comando+argumentos fijos.
  - `run_command(npm test)` → permite exactamente `npm test`, no `npm test -- --watch`.
  - `run_command(npm run *)` → permite `npm run build`, `npm run lint`, etc.
  - `run_command(git status)` → permite solo el status, de solo lectura.
  - `run_command(rm -rf *)` → **nunca** se ofrece como sugerencia de "permitir siempre" (ver invariantes, §5); si un usuario la crea a mano desde Settings, la regla existe pero el invariante de comandos críticos la intercepta antes si el objetivo es una ruta protegida.
  - `run_command(git push --force*)` → igual: el invariante de `git_push` (§5) ignora cualquier regla `allow` para esta categoría.
- **`edit_file` / `write_file` / `read_file`**: glob sobre `paths` relativos al workspace.
  - `edit_file(src/**)` → permite editar cualquier archivo bajo `src/`.
  - `write_file(!.env*)` (prefijo `!`) → fuerza `deny`/`ask` sobre archivos que matchean el glob, se usa para excepciones dentro de un `allow` más amplio.
  - `read_file(!.env*)` → regla `deny` por defecto en preset `balanced` (invariante blando, ver §5).
- **`delete_file`**: mismo glob que `edit_file`, casi nunca con `allow` amplio por defecto (categoría `delete` parte en `ask`).
- **`mcp` (v0.3)**: `toolName` es el nombre completo `mcp__<server>__<tool>`; `pattern` opcional sobre argumentos serializados en JSON, comparación de subcadena — sin glob estructurado por ahora `[DECISIÓN DE DISEÑO]`, se revisa si aparecen casos de uso concretos en v0.3.

**Cómo se genera el patrón sugerido.** Cuando el usuario responde "Permitir siempre", la UI no ofrece el comodín más amplio posible: `PermissionEngine` calcula el **patrón más específico que cubre la llamada actual** (`suggestedPattern` en `PermissionRequest.rememberOptions`), editable antes de guardar. Para `run_command(npm test)` sugiere `npm test`, no `npm *`; para `edit_file` de `src/app/router.ts` sugiere `src/app/**`, no `src/**` ni `**`. El usuario puede ampliar el glob a mano en el diálogo, pero el default nunca es el más laxo.

---

## 5. Invariantes (denylist mínima y bloqueos no configurables)

Ningún preset, regla `allow` ni respuesta del usuario en el diálogo del chat destraba lo siguiente `[DECISIÓN DE DISEÑO]`. Se evalúan **antes** que cualquier `PermissionRule` (paso 2 del algoritmo, §6):

**Protected paths (escritura, `deny` duro):** `.git/**`, `.saurio/**`, `.env*`, `*.pem`, `id_rsa*`, `.vscode/**`, `.idea/**`. `node_modules/**` no es protected — queda en `ask` por defecto porque `patch-package` es un caso legítimo.

**Critical commands (`ask` obligatorio, tarjeta con advertencia roja, nunca se puede subir a `allow` desde el chat):**
- `rm -rf` / `Remove-Item -Recurse` apuntando a la raíz de una unidad, `home` del usuario, la raíz del proyecto o alguno de sus padres.
- `git push --force` (y variantes `--force-with-lease`).
- `git push` en general (categoría `git_push`, política fija `ask`).
- Formateo de discos, particionado o comandos equivalentes (`Format-Volume`, `diskpart`, `mkfs`) — se agregan al `CommandParser` como patrón reconocido de categoría `delete` + marca `critical: true` aunque no muevan archivos del workspace, porque el riesgo es al sistema del usuario, no al proyecto.

**Bloqueados por defecto (`deny` no configurable desde el chat; solo una regla explícita creada en Settings → Permisos puede habilitarlos, nunca desde el diálogo de permiso en el chat):**
- `git reset --hard`, `git checkout -- <path>`, `git restore`, `git clean`, `git stash` — **excepto** sobre archivos que el run actual ya tocó (ahí son parte del flujo normal de checkpoints/revert y no tienen sentido bloquear algo que el propio agente puede deshacer con `CheckpointService`).
- Cualquier comando de `git` que modifique `.git/config`, `.git/hooks/**` o remotos (`git remote add|set-url`).

**Lectura:** `.saurioignore` filtra qué entra al repo map y qué puede leer `list_files`/`search_code`; `read_file(!.env*)` es regla `deny` en el preset `balanced` (blanda: un preset `trusting` o una regla explícita del usuario en Settings sí puede levantarla, a diferencia de los bloqueos de arriba que son duros).

---

## 6. Algoritmo de decisión

`PermissionEngine.evaluate(call, mode, policy): PermissionDecision` se ejecuta en el paso 8 del flujo de ejecución (columna vertebral §6), **después** de registrar la tool call como `pending` (paso 7) y **antes** de cualquier ejecución. Orden de evaluación, de más a menos prioritario:

```
function evaluate(call, mode, agentPolicy, sessionRules, projectRules, globalRules):
  # (pseudocodigo: el parametro `policy` de la firma publica evaluate(call, mode, policy) se descompone aca en
  #  agentPolicy + reglas por scope session/project/global, ya resueltas por el runtime antes de llamar)
  # 0. El modo ya filtró qué tools existen; si call.name no está en el set del modo,
  #    esto no llega a evaluate(): es un error de parseo, no un permiso denegado.

  # 1. Invariantes (denylist mínima, §5) — no configurables
  if isProtectedPath(call.paths) and call.category == 'write':
      return deny(reason: 'protected_path')
  if isCriticalCommand(call.command):
      return ask(request, forceWarning: true, noAllowOption: true)
  if isBlockedGitOperation(call.command) and not touchedByThisRun(call.paths):
      return deny(reason: 'blocked_git_operation')
  if call.category == 'git_push':
      return ask(request, noAllowOption: true)   # invariante: nunca allow

  # 2. Reglas del agente (AgentConfig.permissions.rules — el propio agente
  #    puede acotar lo que hace, nunca ampliar más allá de lo que sigue)
  match = firstMatch(agentPolicy.rules, call)
  if match: return applyDecisionPriority(match)

  # 3. Reglas de sesión (scope: 'session', "este run") — prioridad sobre
  #    'project' porque son más específicas en el tiempo aunque no en el patrón
  match = firstMatch(sessionRules, call)
  if match: return applyDecisionPriority(match)

  # 4. Reglas del proyecto (scope: 'project')
  match = firstMatch(projectRules, call)
  if match: return applyDecisionPriority(match)

  # 5. Reglas globales (scope: 'global', "siempre")
  match = firstMatch(globalRules, call)
  if match: return applyDecisionPriority(match)

  # 6. Default de la categoría según el preset activo (§2)
  return decision(defaultFor(call.category, agentPolicy.preset))
```

`applyDecisionPriority(matches)`: dentro de un mismo nivel (agente, proyecto o global) puede haber más de una regla que matchea (por ejemplo `edit_file(src/**)` en `allow` y `edit_file(src/secrets/**)` en `deny`); ahí se aplica el orden fijo **`deny` → `ask` → `allow`**, sin especificidad `[VERIFICADO EN DOC OFICIAL: code.claude.com/docs/en/permissions]` — si cualquier regla que matchea en ese nivel dice `deny`, gana `deny`; si ninguna dice `deny` pero alguna dice `ask`, gana `ask`; `allow` gana solo si todas las que matchean en ese nivel son `allow`. Esto es intencionalmente conservador: agregar una regla nunca abre una puerta que otra regla del mismo nivel cerró.

**Nota de scope "este run".** La columna vertebral define `PermissionRule.scope: 'session' | 'project' | 'global'`, que corresponde uno a uno con "este run" / "este proyecto" / "siempre" de la condición del usuario — se usa `session` en el tipo y "este run" en la UI porque una `session` de `PermissionEngine` dura lo mismo que el run donde se creó la regla (no persiste entre runs de un mismo chat). El paso 3 del algoritmo de arriba es la única fuente de verdad sobre el orden: las reglas `session` se evalúan antes que `project` (más específicas en el tiempo aunque no en el patrón). Queda como **decisión de implementación abierta, no bloquea el MVP** dónde viven esas reglas mientras el run está activo: se descartan de la tabla `permission_rules` al terminar el run (`DELETE ... WHERE scope = 'session' AND run_id = ?`), o bien nunca se insertan en SQLite y viven solo en memoria del `RunController` — cualquiera de las dos cumple la semántica de "este run" y ninguna cambia el paso 3 del algoritmo.

**Por qué "reglas del agente" y no una capa aparte.** La condición pide el orden `modo → deny → reglas del agente → reglas del proyecto → reglas globales → default`. La columna vertebral no define un `scope: 'agent'` en `PermissionRule` — las reglas de un agente viven embebidas en `AgentConfig.permissions: PermissionPolicy` (columna `agents.permission_policy_json`), no en la tabla `permission_rules` compartida. Este documento resuelve la aparente falta de nivel tratando `agentPolicy.rules` (las reglas propias del `AgentConfig` del run actual) como el primer nivel de reglas, antes que `permission_rules` con `scope IN ('project','global')`. Es una aclaración de diseño, no una tabla nueva: se documenta en §12 (Desvíos).

---

## 7. "Recordar decisión": alcance y persistencia

Cuando el usuario responde a una `PermissionRequest`, `PermissionAnswer.answer` puede ser `allow_once`, `allow_always` o `deny`:

- **`allow_once`**: no crea `PermissionRule`; solo escribe `permission_decisions(decision, decided_by: 'user')` y deja pasar esta tool call. La próxima llamada idéntica vuelve a preguntar.
- **`allow_always`** con `rememberScope: 'project'`: inserta `PermissionRule(scope: 'project', pattern: rememberOptions.suggestedPattern o el editado por el usuario, decision: 'allow', source: 'user')` ligada a `project_id` vía la fila de `permission_rules` (`project_id` no nulo); persiste entre runs y reinicios de la app mientras el proyecto exista.
- **`allow_always`** con `rememberScope: 'global'`: igual pero `project_id = NULL`, aplica a cualquier proyecto abierto con SaurioLLM.
- Alcance **"este run"** (`scope: 'session'`): no está en la lista de opciones por defecto de `PermissionRequest.rememberOptions` (que solo ofrece `project` y `global`, según la interfaz de la columna vertebral) — se ofrece como opción adicional solo cuando el usuario la pide explícitamente desde el menú contextual de la tarjeta ("permitir solo en este run"), pensado para desbloquear una secuencia de comandos repetitivos sin dejar rastro permanente. Ver nota de scope en §6.
- **`deny`**: siempre escribe `permission_decisions`; opcionalmente, si el usuario marca "denegar siempre este patrón", crea `PermissionRule(decision: 'deny')` con el mismo mecanismo de scope.

Toda fila de `permission_rules` queda visible y borrable en **Settings → Permisos**, agrupada por `scope` y con su `source` (para distinguir una regla creada por el usuario de una que vino de un preset). Borrar una regla no revierte las tool calls ya ejecutadas bajo ella — para eso está `CheckpointService` (§10).

---

## 8. UI de la solicitud de permiso

Evento `tool.permission` (`RunEvent`, payload `PermissionRequest`) dispara una tarjeta **bloqueante** en el chat (bloqueante para ese run, no para la UI entera: otros chats/runs siguen operando, principio de concurrencia lógica de la columna vertebral §14). Contenido de la tarjeta, tomado directamente de `PermissionRequest`:

- **`summary`**: descripción legible generada por `classify()`, ej. *"Ejecutar `npm test` en `N:\SaurioLLM`"* o *"Editar `src/app/router.ts` (+12 −3)"*.
- **`category`** con color (mapeo fijo: `read` gris, `write`/`delete` ámbar, `terminal` azul, `git_commit`/`git_push` violeta con ícono de advertencia si es `git_push`, `network`/`mcp` rojo suave).
- **`risk`**: `low` | `medium` | `high`, calculado por `classify()` (por ejemplo `delete_file` sobre un archivo con historial reciente es `high`; `edit_file` sobre un archivo nunca tocado es `medium`; sobre uno ya tocado en este run es `low`).
- **`triggeredBy`**: qué regla o default disparó el pedido (ej. *"categoría `write` → `ask` (preset balanced)"* o *"regla de proyecto `edit_file(src/secrets/**)` → `ask`"*), para que el usuario entienda por qué se le pregunta esto y no otra cosa.
- **`preview`**: para `write` — diff calculado **en seco** (`old_string`/`new_string` aplicados en memoria contra el contenido leído, sin tocar disco) mostrado con el mismo componente CodeMirror `@codemirror/merge` que el diff de checkpoints; para `terminal`/`delete`/`git_*` — el comando exacto ya parseado por `CommandParser` (tokens resaltados) y el `cwd` de ejecución; para `mcp` — los argumentos serializados.
- **Botones**: *Permitir una vez* / *Permitir siempre en este proyecto* / *Permitir siempre* / *Denegar* (con motivo opcional en texto libre que se le devuelve al modelo como parte del `ToolResult` de error). Cuando el invariante de §5 aplica (`noAllowOption`), los botones "Permitir siempre" no se muestran — la tarjeta deja solo *Permitir una vez* y *Denegar*, con la advertencia roja fija.

**Timeout y cancelación.** No hay timeout: el run queda en `awaiting_permission` indefinidamente (columna vertebral §6, paso 8) y **no ocupa slot de inferencia** — el `InferenceScheduler` no tiene una generación en curso para ese run mientras espera. El usuario puede cancelar el run entero con `run:cancel` en cualquier momento (la tool call pasa a `cancelled`, ver máquina de estados §12 de la columna vertebral) en lugar de responder al permiso. Si la app se cierra con un run en `awaiting_permission`, `recover()` lo deja tal cual al reiniciar — no pasa a `interrupted`, porque no había ninguna acción en curso, solo una pregunta pendiente (columna vertebral §12, `recover()` punto 2); la tarjeta se reconstruye desde el evento persistido, no se re-pregunta al modelo ni se re-genera el pedido.

---

## 9. Interacción con checkpoints

Toda tool `mutating: true` (`edit_file`, `write_file`, `delete_file`; también `run_command` **no** dispara checkpoint porque no es determinístico qué toca — ver limitación en §13 de la columna vertebral) que llega a `approved` pasa, **antes** de ejecutar el handler, por `CheckpointService.begin(runId, toolCallId, paths)`, que guarda la pre-imagen exacta de cada archivo declarado en `paths` (bytes, EOL, BOM, modo) como blob content-addressed. El vínculo queda en `tool_calls.checkpoint_id`. No existe camino para que una escritura autorizada evite este paso: el runtime lo invoca desde el paso 9 del flujo (columna vertebral §6), no el propio handler de la tool, así que ninguna tool nueva (builtin, MCP futura) puede saltárselo mientras declare `mutating: true` correctamente en su `ToolDefinition`.

Consecuencia para permisos: **denegar** una tool call nunca crea checkpoint (nada se ejecutó); **permitir** siempre lo crea si la tool es mutante, incluso si el resultado termina en `failed` (la pre-imagen ya se guardó, así que un fallo a mitad de escritura sigue siendo diagnosticable y revertible — ver casos de fallo en §12 de la columna vertebral). `run_command` no tiene esta red de seguridad: es la razón por la que su categoría (`terminal`, `delete` si el comando lo amerita, `git_commit`/`git_push`) parte en `ask` por defecto y por la que la tarjeta de permiso para comandos es más explícita en mostrar el comando exacto — es la única ventana de control antes de un efecto que los checkpoints no cubren.

---

## 10. Permisos en subagentes

*(Previsto para v0.4, junto con `delegate` y `parent_run_id` — se documenta el diseño para que las interfaces del MVP no necesiten romperse cuando esto se active; no se implementa ahora.)*

`[DECISIÓN DE DISEÑO]` Un subrun creado por la tool `delegate` (categoría agregada `delegate`, §12) tiene su propio `AgentConfig` con su propia `PermissionPolicy`, pero esa política **solo puede restringir**, nunca ampliar, lo que autoriza el run padre. Regla concreta:

- Al evaluar un `PermissionRule` de un subagente en el paso 2 del algoritmo (§6, "reglas del agente"), el resultado efectivo es el **más restrictivo** entre la decisión del subagente y la que hubiera tomado `evaluate()` para el mismo `call` con la política del run padre (`decision(sub) = mostRestrictive(decision(sub.policy), decision(parent.policy))`, con el mismo orden `deny > ask > allow`).
- Los invariantes de §5 se heredan sin excepción — no son parte de `PermissionPolicy`, así que no hay forma de que un subagente los relaje ni aunque su propio `AgentConfig` lo permitiera.
- `git_push` y comandos críticos siguen preguntando al usuario **del chat del run padre** (la UI de permisos vive en el chat, no en un subrun sin interfaz propia); el subrun queda en `awaiting_permission` igual que cualquier run.
- Un `Adjustment`/regla `allow_always` creada durante un subrun se guarda con el `scope` que corresponda (`project`/`global`), igual que en cualquier run — no hay un scope `subagent` separado; lo que la limita es la intersección con la política del padre en cada evaluación futura, no el origen de la regla.

Esto evita el caso de que delegar una tarea a un "Reviewer" con permisos mal configurados termine ejecutando algo que el usuario nunca hubiera autorizado desde el chat principal.

---

## 11. Auditoría

`permission_decisions` (columna vertebral §4) es el registro primario: una fila por cada decisión tomada sobre una tool call, con `tool_call_id`, `decision`, `rule_id` (si vino de una regla), `decided_by` (`'user' | 'rule' | 'mode'`), `reason` y `decided_at`. Junto con `permission_rules` (qué reglas existen, quién las creó y cuándo) alcanza para reconstruir, por cada tool call del historial, exactamente por qué se ejecutó o no.

`audit_log` (`id, ts, kind, payload_json`) se usa para eventos de auditoría que no son "una decisión sobre una tool call" pero sí afectan permisos o alcance del agente `[DECISIÓN DE DISEÑO]`, agregando estos valores de `kind` a los ya previstos por localidad (columna vertebral §17, "toda llamada no local se registra en `audit_log`"):

- `permission_rule_created` / `permission_rule_deleted`: espejo de alto nivel de cambios en `permission_rules` hechos desde Settings (no desde una tarjeta de permiso puntual), útil para un futuro "historial de cambios de configuración" sin tener que diferenciar por `source`.
- `locality_blocked`: un run intentó usar un provider fuera de `authorizedLocality` y el Gateway lo rechazó (columna vertebral §17).
- `critical_command_confirmed`: cada vez que el usuario confirma un comando crítico (§5), independientemente de que no se pueda crear una regla `allow` para él — para que quede rastro aunque no haya "decisión recordada".

Esto es una extensión menor de lo ya definido para `audit_log`, no una tabla nueva; se anota en §12.

**MVP:** `permission_decisions` y `permission_rules` completos, con su vista en Settings → Permisos. **Después:** los tres `kind` de `audit_log` agregados arriba entran junto con network/mcp (v0.3) y delegate (v0.4), porque antes de eso no hay eventos que loguear en esas categorías.

---

## Imprescindible para el MVP

- Modos `plan` y `agent` con su filtro de tools (6 y hasta 10 respectivamente).
- Las ocho categorías `read/write/delete/terminal/git_commit/git_push/network/mcp` con su tabla de default del preset `balanced` (aunque `network`/`mcp` no tengan tools activas todavía, la categoría y su default quedan definidos para no romper el enum ni la UI de Settings más adelante).
- `classify()` para `run_command` con `CommandParser` de PowerShell (único shell del MVP), y para `edit_file`/`write_file`/`delete_file` por `paths`.
- Reglas con `scope: 'project' | 'global'` (session queda como posible sin bloquear el MVP, ver nota de §6), patrones por prefijo de tokens y glob, "permitir siempre" con patrón sugerido específico y editable.
- Todos los invariantes de §5 (protected paths, comandos críticos, bloqueos de git, `git_push` siempre `ask`).
- Algoritmo de evaluación completo tal como está en §6, incluyendo el nivel "reglas del agente" vía `AgentConfig.permissions`.
- UI de la tarjeta de permiso con los cinco campos de §8, sin timeout, con cancelación vía `run:cancel`.
- Vínculo obligatorio con `CheckpointService.begin` para toda tool `mutating: true` autorizada.
- `permission_decisions` y `permission_rules` con su pantalla en Settings → Permisos.

## Previsto para más adelante

- `CommandParser` para `bash` (activación cuando exista un entorno real con bash — WSL, mac o Linux — para probarlo); la interfaz ya es genérica por shell, así que es una extensión y no un rediseño.
- Modos `ask`/`edit` con su selector en la UI (v0.2).
- Categorías `git_commit`/`git_push` como tools dedicadas en vez de `run_command` clasificado (v0.2); `network`/`mcp` activas con tools reales (v0.3).
- Regla `session`/"este run" como opción visible por defecto en la tarjeta, si se decide exponerla más allá del menú contextual.
- Permisos en subagentes (`delegate`, herencia restrictiva) — diseño en §10, implementación en v0.4.
- Juez LLM opcional estilo Goose y uso de `annotations` de MCP como hint para categorización automática (v0.4).
- Sandbox de procesos para `run_command` — no hay mecanismo nativo confiable en Windows hoy `[VERIFICADO EN DOC OFICIAL: documentación de sandboxing de Claude Code y de Codex]`; hasta entonces, el control es enteramente vía `PermissionEngine` + timeout + `tree-kill`.
- Los tres `kind` nuevos de `audit_log` (§11), atados a cuando existan las categorías/funcionalidades que auditan.

---

## Nomenclatura agregada

- `PermissionCategory.delegate` (nuevo valor de enum): categoría de la tool `delegate` (v0.4), para que la evaluación de permisos de subagentes tenga una categoría propia en vez de heredar la del padre sin distinción.
- `audit_log.kind` — nuevos valores: `'permission_rule_created'`, `'permission_rule_deleted'`, `'locality_blocked'`, `'critical_command_confirmed'` (§11), como elaboración de los `kind` ya previstos por la columna vertebral para localidad.
- `PermissionRequest.noAllowOption?: boolean` (campo agregado, no está en la interfaz de la columna vertebral): permite que la UI oculte los botones "Permitir siempre" cuando un invariante de §5 aplica, sin necesitar una lista paralela de "categorías sin allow" en el cliente.
- `PermissionRule.critical?: boolean` (campo agregado, opcional): marca en `CommandParser`/`classify()` los patrones de comandos peligrosos al sistema (formateo de discos, etc.) que no mueven archivos del workspace pero igual deben tratarse como críticos (§5).

## Desvíos respecto de la columna vertebral

1. **Qué:** la condición del usuario pide el orden de evaluación `modo → deny → reglas del agente → reglas del proyecto → reglas globales → default`, pero `PermissionRule.scope` en la columna vertebral solo define `'session' | 'project' | 'global'` — no existe un scope `'agent'` en la tabla `permission_rules`.
   **Por qué:** se resuelve sin agregar una tabla ni un scope nuevo: las "reglas del agente" son las que ya vive en `AgentConfig.permissions.rules` (columna `agents.permission_policy_json`), evaluadas como primer nivel antes que `permission_rules` con scope `project`/`global`. Es la interpretación más consistente con el principio 8 (no crear abstracciones sin un uso concreto en el MVP) y con la §5 de la columna vertebral, que ya define `AgentConfig.permissions: PermissionPolicy` como la política propia de cada agente.

2. **Qué:** se agrega la categoría `delegate` a `PermissionCategory`, que en la columna vertebral tiene solo ocho valores; el `CHECK` de `tool_calls.category` (doc 03) **ya** incluye `delegate` (coordinación resuelta, ver §2 de este documento).
   **Por qué:** la tool `delegate` (v0.4, mencionada en §2 y §10 de la columna vertebral) necesita una categoría para que `PermissionEngine.evaluate()` la trate como cualquier otra acción; sin esto, delegar a un subagente caería en una categoría existente que no describe bien el riesgo real (crear un run completo con su propio presupuesto de tokens y su propia superficie de acciones). Se decide agregar `delegate` al `CHECK` **desde la migración 1** (sin uso hasta v0.4), igual que otras columnas "pagadas por adelantado" del Principio 8 (ver §2) — evita una migración de esquema futura solo para este valor. 03-modelo-de-datos.md ya refleja este `CHECK` y ya lo documenta en su propia sección de Desvíos/Nomenclatura agregada; no queda ningún cambio pendiente en 03 por este motivo.

3. **Qué:** se definen tres valores nuevos de `audit_log.kind` no listados explícitamente en la columna vertebral.
   **Por qué:** la columna vertebral solo especifica que las llamadas no locales se auditan (§17); este documento necesita un lugar donde registrar cambios de reglas hechos desde Settings y confirmaciones de comandos críticos, y `audit_log` ya existe con una forma genérica (`kind`, `payload_json`) pensada exactamente para este tipo de extensión sin nueva tabla.

4. **Qué:** el MVP de `CommandParser` cubre solo `pwsh`; el parser `bash` mencionado originalmente en §3 y en "Imprescindible para el MVP" pasa a "Previsto para más adelante".
   **Por qué:** la máquina del usuario relevada es Windows sin bash/WSL instalado y el recorrido de validación #1 solo ejecuta comandos en PowerShell; construir y probar un parser `bash` sin un shell real para validarlo es trabajo adicional no verificable en este equipo y no aporta al hito 1 (hallazgo de pragmatismo). La interfaz `CommandParser.forShell(shell)` ya es genérica por shell, así que agregar `bash` después es una extensión, no un rediseño.

## Preguntas abiertas

Ninguna de las anteriores cambia el diseño de fondo del MVP (son aclaraciones y una categoría/campo agregados, no decisiones que el usuario deba destrabar); no se listan preguntas nuevas más allá de las seis ya abiertas en la columna vertebral (§20), que este documento no toca.
