# 16 — Estado de implementación

**Fecha del resumen:** 2026-09-19
**Versión:** v0.2.3

Este documento resume el estado técnico publicable. Los documentos de arquitectura definen los
contratos; este archivo indica qué partes están conectadas y qué límites siguen abiertos. El hash del
instalador se completará después del build final.

## 1. Arquitectura conectada

### Persistencia

- SQLite con migraciones versionadas, WAL, claves foráneas, índices y búsqueda FTS.
- Repositorios para proyectos, chats, mensajes, runs, herramientas, checkpoints, tareas, ajustes,
  agentes, memorias, proveedores y evidencia de modelos.
- EventStore con persistencia y proyección transaccionales.
- Historial de chat con último estado/error del run para restaurar fallos después de reiniciar.
- Migración de preferencias de arranque heredadas sin sobrescribir ajustes nuevos.

### Runtime de agentes

- `RunController` con estados, streaming, cancelación, permisos, checkpoints, compactación, tareas,
  continuación y recuperación.
- Modos Preguntar, Plan y Agente.
- En Plan, el contrato exige checklist no vacío. La lectura y búsqueda están permitidas cuando el
  pedido depende del proyecto; edición, comandos mutantes y ejecución del plan siguen prohibidos.
- Reintentos acotados para servicio ocupado y conexión rechazada.
- Allowlist efectiva validada sobre tool calls nativas y textuales antes de permisos o ejecución.
- Delegación limitada a colaboradores habilitados, con profundidad, iteraciones y cancelación.

### Contexto

- Presupuesto calculado con el máximo efectivo informado por el modelo o proveedor.
- Límite provisional visible cuando no hay metadatos confirmados.
- Repo map, instrucciones de proyecto, memorias con procedencia, historial, adjuntos y tools
  presupuestados.
- Compactación y poda con inspección de fuentes incluidas o excluidas.
- Raíz del runtime alineada con el proyecto activo en prompt y herramientas.

### Herramientas y seguridad del proyecto

- Herramientas builtin para leer, buscar, editar, crear, borrar y ejecutar acciones permitidas.
- `WorkspaceFs` confinado a la raíz y protección de `.git` sobre rutas canónicas.
- Seguimiento de hashes de lectura para detectar cambios externos antes de escribir.
- Matching exacto y normalizaciones seguras en `edit_file`; una coincidencia aproximada se usa como
  sugerencia para releer, no se aplica automáticamente.
- Checkpoints con diff y reversión; efectos fuera del sistema de archivos se informan aparte.

### Modelos y proveedores

- Gateway con scheduler y proveedores Ollama, OpenAI-compatible y Anthropic-compatible.
- Localidad del proveedor como autoridad; sin fallback silencioso a nube.
- Preferencia Solo modelos locales revalidada al iniciar la llamada y después de esperar un slot.
- Catálogos parciales: el fallo de un proveedor no elimina los modelos de los demás.
- Identidad de modelo compuesta por proveedor y nombre.
- Uso, costo y fuente persistidos cuando el proveedor los informa.

### Motor local y descargas

- Instalador portable administrado con origen restringido, tamaño, espacio, hash, extracción segura,
  cancelación y rollback.
- Proceso en puerto y carpeta propios; puede adjuntarse a un motor existente sólo por elección del
  usuario.
- Descargas con estados persistidos, progreso acotado, cancelación y reintento.
- Importación GGUF desde repositorios públicos compatibles mediante staging, validación de tamaño,
  magic y SHA-256 publicado antes de registrar blobs y manifiesto.
- Limpieza limitada a staging huérfano propio y antiguo.
- Ollama remoto o LAN conserva su mecanismo de pull; la importación local no se fuerza fuera del
  motor administrado local.

### Aplicación de escritorio

- Electron, React y TypeScript con preload e IPC tipado.
- Navegación por Inicio, Chats, Modelos, Agentes, Rendimiento y Ajustes.
- Proyectos administrados y carpetas existentes; restauración de selección.
- Gestión de chats: búsqueda, fijado, renombre, archivo, restauración y borrado.
- Árbol de archivos con observación de cambios externos y búsqueda por contenido.
- Centro de modelos con Instalados, Explorar y Descargas.
- Agentes personales, plantillas, recomendaciones y colaboradores por chat.
- Errores de run visibles y persistidos; banners de proveedor y motor diferenciados.
- Layout compacto, navegación por teclado, foco de diálogos y movimiento reducido.

## 2. Estado de aceptación de v0.2.3

### Evidencia disponible

Los cortes integrados recientes cuentan con:

- suite automática de fuente con **1.356 pruebas aprobadas y 5 omitidas**; typecheck y lint aprobados;
- evaluación real **20/20 en 250,1 s**: Plan leyó fuentes y guardó tareas; la edición cumplió el
  criterio semántico y verificó checkpoint, diff y reversión; permisos y delegación completaron sus
  criterios;
- arranque local completo con motor administrado, descarga de modelo y primer chat en el equipo de
  desarrollo;
- importación GGUF real con cancelación, reintento y modelo visible en inventario;
- smokes empaquetados de persistencia, restauración automática, migración sintética desde v0.2.2,
  errores API, Solo modelos locales y rechazo de tool fuera de allowlist;
- pruebas de teclado y cuatro secciones a zoom 125 %, 150 % y 200 %.

Estas verificaciones usan perfiles aislados. Los proveedores HTTP de los smokes contractuales son
servidores loopback sintéticos y no generan costo externo.

### Paquete final

- Matriz local/API y modelo retirado aprobada: selección UI, persistencia, respuesta y 404 visible sin fallback.
- Paquete con guía recuperable de `edit_file`, artefactos e integridad verificados; hash y tamaño al final.
- Smokes de persistencia, API, Revisor, solo-local, upgrade 0.2.2 y teclado/zoom aprobados.

La matriz prepara consentimiento de nube explícito por IPC. El clic en la confirmación nativa no se automatizó.

## 3. Matriz funcional resumida

| Área | Estado | Observación |
|---|---|---|
| Proyecto → chat → modelo | Implementado | Es el recorrido principal; agentes y equipos son opcionales. |
| Persistencia y restauración | Implementado | Conserva selección, historial y último error terminal. |
| Plan estructurado | Verificado | Produjo tareas e inspeccionó fuentes sin ejecutar el plan en la evaluación real 20/20. |
| Herramientas y permisos | Implementado | Allowlist, permisos, conflicto externo y checkpoints tienen cobertura. |
| Delegación | Implementado | Sólo colaboradores habilitados; límites y cancelación aplicados. |
| Motor administrado | Implementado | Instalación, proceso, actualización, cancelación y recuperación. |
| Modelos Ollama | Implementado | Local administrado, externo y LAN mantienen contratos separados. |
| Modelos Hugging Face GGUF | Implementado | Importación validada para repositorios públicos compatibles. |
| Proveedores API | Implementado | Sin llamadas pagas automáticas; errores y uso visibles. |
| Solo modelos locales | Implementado | Bloqueo en gateway sin invocar proveedor cloud. |
| Contexto efectivo | Implementado | Máximo confirmado o provisional identificado. |
| Recursos y OOM | Implementado | Recomendación y recuperación sin promesa universal. |
| Accesibilidad de teclado/zoom | Verificada localmente | Lector de pantalla real pendiente, sin versión asignada. |
| Migración desde v0.2.2 | Verificada con fixture aislado | Conservó proyectos, chats, agentes, preferencias y credencial sintética. |
| Actualizador | Implementado | Instalador, blockmap y latest.yml con integridad verificada. |

## 4. Límites técnicos conocidos

1. **Hardware:** compatibilidad y rendimiento dependen de memoria libre, modelo, cuantización y
   contexto. La detección no garantiza que cualquier modelo entre en cualquier equipo.
2. **Contexto desconocido:** si el proveedor no informa un máximo, la app usa un valor provisional y
   debe mantener visible esa incertidumbre.
3. **Catálogos remotos:** pueden cambiar o responder parcialmente. El snapshot incluido permite
   explorar modelos Ollama sin depender de la primera sincronización.
4. **Repositorios GGUF:** la importación depende de un archivo público resoluble por nombre y de hosts
   HTTPS autorizados. No usa credenciales privadas del repositorio.
5. **Costo API:** un proveedor que no informa costo queda como desconocido; no se presenta como cero
   facturado.
6. **Actualización:** el instalador no está firmado. La rama y los artefactos públicos se generan sólo
   después de cerrar los gates del mismo build.
7. **Compatibilidad externa:** Windows limpio y una notebook con gráficos integrados se validarán
   como trabajo de v0.2.4. La prueba real con lector de pantalla sigue pendiente, sin versión
   asignada. Esos entornos no están certificados por las pruebas locales de v0.2.3.

## 5. Verificación reproducible

Los comandos principales del repositorio son:

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --filter @saurio/desktop run build:installer
node scripts/release-local.mjs
```

Los smokes de escritorio deben usar un `SAURIO_USER_DATA` temporal y `SAURIO_NO_UPDATE=1`. Las
pruebas externas o pagas requieren habilitación explícita; una clave presente en el entorno no debe
activarlas por sí sola.

## 6. Separación de iniciativas

Jev/Evaluaciones permanece como iniciativa de análisis y planificación. No forma parte de la
implementación ni de los gates de v0.2.3.

## 7. Release

| Campo | Estado |
|---|---|
| Versión | v0.2.3 |
| Distribución | [Release](https://github.com/Sauri0/SaurioLLM/releases/tag/v0.2.3) |
| Build final | Verificado — 132.225.343 bytes |
| SHA-256 | b6d9906faa0fe8282e587c09b918a266b30bd396d7f295efa0de831c4031d35d |
| Firma | No firmado |

Este resumen no incluye rutas locales, identificadores de procesos, inventario de hardware ni nombres
de logs del entorno de desarrollo.
