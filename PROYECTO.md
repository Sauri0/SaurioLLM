# SaurioLLM — estado público del proyecto

Última actualización: 2026-09-19.

Este documento describe la entrega **v0.2.3**. El instalador y sus archivos de actualización están
verificados; la descarga se distribuye mediante [Releases](https://github.com/Sauri0/SaurioLLM/releases/tag/v0.2.3).

## Qué es

SaurioLLM es una aplicación de escritorio para Windows que permite trabajar con modelos locales y
proveedores compatibles con API sobre una carpeta de proyecto real. El recorrido principal es:

1. abrir o crear un proyecto;
2. abrir un chat;
3. elegir un modelo local o API;
4. conversar, preparar un plan o permitir que un agente trabaje con herramientas controladas.

Los agentes personales, equipos y delegaciones son opcionales. La aplicación conserva proyectos,
chats, tareas, permisos, costos informados y evidencia de contexto en SQLite.

## Principios del producto

- **Local por defecto:** no hay fallback silencioso a nube.
- **Proyecto confinado:** prompts y herramientas usan la raíz del proyecto abierto; `.git` está
  protegido frente a escrituras directas.
- **Permisos visibles:** las acciones se evalúan antes de ejecutarse y las decisiones recordadas se
  limitan al alcance elegido.
- **Contexto honesto:** se usa el máximo confirmado por el modelo o proveedor. Un límite provisional
  se presenta como tal.
- **Errores recuperables:** cancelación, reintento y fallos de proveedor quedan visibles.
- **Datos locales:** claves API se guardan mediante el almacén seguro del sistema y no se exponen por
  IPC. Las llamadas no locales se registran con proveedor, modelo y uso disponible.

## Estado de v0.2.3

La versión integra las siguientes áreas:

### Primer uso y modelos locales

- Asistente para usar el motor local administrado por SaurioLLM, conectar una instancia externa de
  Ollama o configurar un proveedor API.
- Descarga, verificación, instalación y ciclo de vida del motor administrado sin requerir Node.js,
  pnpm ni una instalación global de Ollama.
- Descargas de modelos con progreso, cancelación, reintento y estados persistidos.
- Importación segura de archivos GGUF desde repositorios públicos compatibles: descarga HTTPS con
  redirects restringidos, staging propio, límites de tamaño/espacio, verificación de hash cuando
  está publicado y validación del archivo antes de registrarlo en el motor local.

### Centro de modelos

- Vistas Instalados, Explorar y Descargas.
- Búsqueda y filtros por proveedor, capacidad, cuantización y contexto.
- Catálogo incluido para funcionamiento sin red y actualización en vivo cuando está disponible.
- Compatibilidad estimada separada de la compatibilidad probada en este equipo.
- Selección explícita por proveedor y modelo; la identidad no se reduce al nombre del modelo.

### Proyectos, chats y archivos

- Crear un proyecto administrado o abrir una carpeta existente.
- Restaurar el último proyecto y chat elegidos al reiniciar.
- Buscar, fijar, renombrar, archivar, restaurar y eliminar chats.
- Árbol de archivos actualizado ante cambios externos, búsqueda por nombre o contenido y panel de
  cambios.
- Separación de chats, contexto y herramientas entre proyectos.

### Agentes y ejecución

- Modos Preguntar, Plan y Agente.
- En modo Plan, las tareas se guardan como checklist. Si el pedido depende del proyecto, el modelo
  puede inspeccionar archivos con herramientas de lectura y búsqueda sin ejecutar el plan.
- En modo Agente, herramientas nativas y textuales con allowlist efectiva, permisos, checkpoints,
  conflictos por cambios externos, cancelación y recuperación.
- Plantillas editables para Programador, Tester, Revisor y Director.
- Colaboradores habilitados por chat y delegación restringida a esa lista.

### Contexto, recursos y proveedores

- Límite de contexto efectivo y procedencia visibles; compactación y exclusiones registradas.
- Detección de CPU, RAM, GPU y memoria disponible sin prometer que todo modelo funcionará en todo
  hardware.
- Presets de recursos locales y controles avanzados opcionales.
- Proveedores Ollama, OpenAI-compatible y Anthropic-compatible.
- Uso y costo informado por el proveedor persistidos cuando existen; costo facturado, estimado y
  desconocido se muestran como categorías distintas.
- Opción **Solo modelos locales** aplicada en el límite de generación, incluso para chats creados
  antes de activarla.

### Interfaz y accesibilidad

- Navegación principal por Inicio, Chats, Modelos, Agentes, Rendimiento y Ajustes.
- Vista compacta para ventanas angostas o zoom alto.
- Foco contenido en diálogos, restauración del disparador, navegación por teclado y movimiento
  reducido.
- Estado y errores del run visibles en el chat y restaurados después de reiniciar.

## Evidencia disponible

Las verificaciones se ejecutaron con perfiles aislados y actualizaciones deshabilitadas.
La evidencia disponible incluye:

- suite automática final de fuente con **1.359 pruebas aprobadas y 5 omitidas**; typecheck y lint
  aprobados;
- evaluación real **20/20 en 250,1 s**: modo Plan inspeccionó fuentes y guardó tareas; la edición
  cumplió el criterio semántico y verificó checkpoint, diff y reversión; permisos y delegación
  también completaron sus criterios;
- primer uso local completo en el equipo de desarrollo, desde preparación del motor y descarga de un
  modelo hasta una respuesta visible;
- descarga e importación GGUF real con cancelación, reintento e inventario final;
- smoke funcional del ejecutable empaquetado y migración sintética desde v0.2.2;
- errores API 401/429 visibles y recuperación posterior;
- bloqueo de nuevas llamadas cloud al activar Solo modelos locales;
- rechazo de una herramienta no habilitada antes de solicitar permiso, con error persistido;
- recorrido de teclado y doce combinaciones de sección y zoom entre 125 % y 200 %.

El paquete final pasó los smokes de persistencia, API, Revisor, modo solo local, actualización desde
v0.2.2 y teclado/zoom. La matriz local/API verificó selección desde la UI, persistencia, generación y
retiro de modelo con error 404 sin fallback. Esta evidencia no certifica todo hardware o proveedor externo.

## Validación externa pendiente

El código pasó la suite y la evaluación real; el paquete incluye la guía recuperable de `edit_file`
y tiene integridad verificada. En la matriz se preparó consentimiento explícito por IPC: el clic en
la confirmación nativa de nube no fue automatizado.

La aceptación en Windows limpio y una notebook con gráficos integrados fue diferida a **v0.2.4**. La
prueba real con lector de pantalla continúa pendiente, sin versión asignada. Ninguno de esos entornos
se presenta como aprobado ni se promete compatibilidad universal.

## Limitaciones conocidas

- El instalador no está firmado; Windows puede mostrar una advertencia de SmartScreen.
- La primera instalación del motor y la descarga de modelos requieren conexión y espacio suficiente.
- El rendimiento depende del modelo, cuantización, contexto y recursos libres del equipo.
- Los proveedores pueden devolver catálogos parciales, límites desconocidos o costos no informados;
  la interfaz debe conservar esa incertidumbre.
- Las pruebas contractuales de API usan servidores sintéticos locales. Las llamadas pagas no forman
  parte de los gates automáticos.
- La importación desde repositorios públicos depende de que el archivo y sus metadatos sigan
  disponibles en los hosts autorizados.

## Artefacto de release

| Campo | Estado |
|---|---|
| Versión | v0.2.3 |
| Publicación | [Release v0.2.3](https://github.com/Sauri0/SaurioLLM/releases/tag/v0.2.3) |
| Instalador | SaurioLLM-Setup-0.2.3.exe — 132.225.166 bytes |
| SHA-256 | 65672b5cc276f6533d6db46b3f99b2de47a1403177bf7ccc0a8224a3ddd080d0 |
| Firma | No firmado |
| Versión publicada anterior | v0.2.2 |

## Documentación

- [Instalación](docs/INSTALAR.md)
- [Manual de uso](docs/MANUAL.md)
- [Estado técnico](docs/architecture/16-estado-de-implementacion.md)
- [Arquitectura](docs/architecture/01-arquitectura.md)

Las notas internas de investigación, perfiles de prueba y registros de aceptación no forman parte del
árbol público.

## Corrección del candidato inicial

Se corrigieron las recomendaciones por rol cuando el motor local está apagado: usan estimaciones del catálogo y omiten el enriquecimiento que requiere Ollama, sin ocultar errores de programación ni presentar compatibilidad medida. Si instalaste el primer candidato de v0.2.3, descargá y reinstalá el instalador vigente: compartir número de versión no activa una actualización automática.

Alcance de la corrección final: la suite de 1.359 pruebas incluye recomendaciones sin motor. La evaluación real 20/20 y los smokes de API, permisos, migración y zoom corresponden al corte anterior, cuyos módulos no cambiaron. Persistencia/reinicio se verificaron nuevamente sobre el instalador corregido.

Recorrido UI completo repetido sobre el instalador corregido: 12 pantallas, recomendaciones con motor apagado, chat del Director y colaboradores persistidos, borrador conservado ante error y cero excepciones del renderer.

Matriz local/API repetida y aprobada sobre el instalador corregido: selección y persistencia, respuestas sintéticas, retiro de modelo con error 404 visible y cero fallback o llamadas externas. Se mantiene la limitación del consentimiento preparado por IPC.

## Actualización por incidente de primer arranque

La revisión actual corrige la carpeta de ejecución del motor portable, amplía el margen inicial de 15 a 30 segundos y conserva errores de apertura/cierre del proceso. El motor se descarga desde la app, no requiere Ollama global ni login. Se verificaron typecheck, lint y 468 pruebas de escritorio (2 omitidas). El fallo reportado en una PC nueva aún necesita confirmación en ese equipo; esta entrega no certifica Windows limpio. Descargá y ejecutá nuevamente el instalador si tenías una entrega anterior de v0.2.3.

Prueba del paquete sin Ollama global aprobada: entorno de usuario aislado, arranque del motor administrado, health/catálogo, persistencia, reapertura y cierre limpio. Usó una copia del portable oficial descargado previamente; no sustituye la validación en un Windows limpio ni confirma todavía el caso de la PC reportada.
