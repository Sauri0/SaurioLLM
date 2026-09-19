# Instalar SaurioLLM

Guía para usuarios finales: cómo descargar e instalar SaurioLLM en Windows sin tocar código ni
compilar nada. Si en cambio querés compilar el proyecto vos mismo, mirá la sección "Desarrolladores"
del [`README.md`](../README.md).

Esta guía corresponde a **v0.2.3**. Las pruebas del instalador no sustituyen una validación en Windows limpio.
La prueba en Windows limpio y notebook con gráficos integrados está programada para **v0.2.4** por
decisión del dueño; v0.2.3 no debe presentarse como certificada para cualquier PC.

## 1. Requisitos antes de instalar

- **Windows x64** (Windows 11 es el target principal; todavía no hay validación en una instalación
  Windows limpia ni en Windows 10).
- Conexión a Internet durante la primera preparación si vas a descargar el motor administrado, el
  catálogo o un modelo; también necesitás espacio para el instalador, el runtime incluido y los
  modelos (varios GB cada uno).
- Ollama instalado y corriendo es una opción para usar un motor local existente. También podés usar el
  motor administrado por SaurioLLM o un proveedor por API (ver paso 6).

## 2. Descargar el instalador

1. Andá a la sección **[Releases](../../releases)** de este repositorio en GitHub.
2. Bajo la versión más reciente, descargá el archivo `SaurioLLM-Setup-<versión>.exe`.
3. No hace falta descargar nada más que ese `.exe` para instalar (los otros dos archivos del Release,
   `latest.yml` y `SaurioLLM-Setup-<versión>.exe.blockmap`, son solo para que las versiones futuras se
   actualicen solas — ver paso 5 — no hacen falta para instalar por primera vez). El instalador ya trae
   el runtime de Electron y los recursos de la aplicación. El motor administrado y los modelos se
   preparan desde el asistente después de instalar; la compatibilidad en una instalación Windows limpia
   todavía está pendiente de validación.

## 3. Instalar

1. Ejecutá el `.exe` que descargaste.
2. **Windows SmartScreen puede mostrar una advertencia** ("Windows protegió su PC" / "Windows
   protected your PC"). Este instalador **no está firmado digitalmente**, por lo que Windows no puede
   verificar la identidad del editor mediante una firma. Para
   continuar, verificá que descargaste el archivo desde Releases y:
   - Hacé clic en **"Más información"** ("More info").
   - Hacé clic en **"Ejecutar de todas formas"** ("Run anyway").
   Si preferís no ejecutar un instalador sin firma, podés compilarlo vos mismo desde el código fuente
   (ver "Desarrolladores" en el `README.md`).
3. El instalador te deja elegir la carpeta de instalación (no es "un clic", `oneClick: false`).
   Seguí el asistente hasta el final.
4. Al terminar, SaurioLLM queda disponible en el menú Inicio y con un acceso directo.

## 4. Primer arranque

Al abrir SaurioLLM por primera vez te recibe un asistente de primer arranque que te ayuda a:

- Preparar el motor administrado dentro del espacio de SaurioLLM o detectar una instalación existente
  de Ollama; la preparación descarga y verifica el motor dentro de la app.
- Elegir y descargar el primer modelo local, con progreso, cancelación y reintento, según tu placa de
  video y memoria disponible.
- O configurar una clave de API de un proveedor compatible (OpenAI-compatible o Anthropic) si preferís
  no correr modelos localmente.

Después de eso, abrís la carpeta de un proyecto de código y ya podés chatear con el modelo. Para el
resto del recorrido (modos plan/agent, permisos, checkpoints, terminal, Centro de modelos, etc.) mirá
el [`docs/MANUAL.md`](MANUAL.md), pensado para acompañar el uso día a día.

## 5. Actualizaciones automáticas

SaurioLLM se actualiza sola, sin que tengas que volver a esta página de Releases cada vez:

- Al abrir la app (y después cada 6 horas, si la dejás abierta) busca sola una versión nueva en los
  Releases de este repositorio.
- Si hay una, la descarga en segundo plano — podés seguir usando la app mientras tanto, no se
  interrumpe nada.
- Cuando termina de descargar, te avisa con un diálogo: **"Hay una versión nueva (x.y.z) lista."**, con
  dos opciones:
  - **Reiniciar ahora**: cierra SaurioLLM y la vuelve a abrir ya actualizada.
  - **Más tarde**: seguís usando la versión actual; la actualización se instala sola la próxima vez que
    cierres la app (no hace falta que vuelvas a este diálogo).
- Si en ese momento tenés un run activo (el modelo respondiendo, o ejecutando una herramienta),
  SaurioLLM pospone el aviso hasta que termine — no te va a cortar nada a mitad de camino.
- Si no hay conexión o el chequeo falla por lo que sea, no ves ningún aviso molesto: queda anotado en
  `%APPDATA%\SaurioLLM\logs\updater.log` y la app sigue funcionando normal con la versión que tenías.
- **Para desactivarlo:** en Ajustes (o a mano, editando `%APPDATA%\SaurioLLM\settings.local.json`)
  poné la clave `updates.auto` en `false`. También podés desactivarlo por sesión con la variable de
  entorno `SAURIO_NO_UPDATE=1` antes de abrir la app.
- **Nota de firma** (mismo tema que el paso 3, aplicado ahora a la actualización): SaurioLLM verifica
  que el archivo que descargó coincida con el hash `sha512` publicado, pero eso no reemplaza una firma
  de editor reconocida por Windows. La validación completa del flujo en Windows limpio sigue pendiente.

## 6. Modelos: motor administrado, Ollama existente o API

- **Motor administrado por SaurioLLM (local):** el asistente descarga y verifica el motor dentro del
  espacio de la app y luego permite descargar un modelo desde el Centro de modelos. Requiere Internet
  durante la descarga y espacio para el motor y el modelo; ambos corren en tu máquina.
- **Ollama existente (local):** instalá [Ollama](https://ollama.com/download), dejalo corriendo, y
  SaurioLLM lo detecta sin cambiar su configuración. Desde el asistente o el Centro de modelos podés
  instalar un modelo (por ejemplo `qwen3:8b`). Sin GPU también funciona, pero más lento (CPU).
- **Por API (sin instalar nada más, con costo según el proveedor):** cargá una clave de API de un
  proveedor compatible con la API de OpenAI o de Anthropic en Ajustes. SaurioLLM no guarda ni envía esa
  clave a nadie más que al proveedor que elijas.

## 7. Desinstalar

Como cualquier otro programa de Windows: **Configuración → Aplicaciones → Aplicaciones instaladas →
SaurioLLM → Desinstalar**, o ejecutá el desinstalador desde la carpeta de instalación.

## 8. Problemas conocidos / cómo reportar

- Si la ventana queda en blanco o la app no arranca, fijate primero si tu placa de video tiene
  problemas con la virtualización de GPU de Electron (algunos equipos lo necesitan deshabilitado) —
  ver la sección de solución de problemas del [`MANUAL.md`](MANUAL.md).
- Para reportar un problema, abrí un issue en este repositorio describiendo qué esperabas que pasara,
  qué pasó en realidad, y tu versión de Windows.
- **Prueba pendiente en Windows limpio:** para validar una versión publicada, usar una máquina o VM
  Windows x64 sin Node, pnpm ni Ollama; instalar solo el `.exe`, preparar el motor administrado,
  descargar un modelo, abrir un proyecto y crear un chat. Registrar versión, espacio usado, errores de
  SmartScreen y resultado de actualización. Este procedimiento queda documentado para ejecutar; no
  implica que esa corrida ya se haya realizado.

### Registro de aceptación en otro equipo

Usar una cuenta de prueba sin datos personales. Registrar la versión/build de Windows, CPU, RAM,
GPU, espacio libre inicial y SHA-256 del instalador (`Get-FileHash <ruta-del-exe> -Algorithm SHA256`).
El hash debe coincidir con el candidato vigente de `PROYECTO.md`; una prueba de otro build no cierra
la aceptación de éste. No hace falta instalar herramientas de desarrollo para realizar este recorrido.

| Paso | Resultado que debe comprobarse |
|---|---|
| Instalar como usuario estándar | El asistente termina y la app abre sin exigir Node, pnpm ni Ollama instalado. Registrar cualquier elevación o error. |
| Preparar motor y modelo | Progreso visible; cancelar y reintentar funciona. El modelo recomendado identifica límite de contexto y compatibilidad estimada. Registrar modelo elegido y espacio final. |
| Trabajar en un proyecto | Abrir una carpeta con espacios en la ruta, crear chat y pedir leer un archivo de prueba. La raíz del inspector y la usada por herramientas coinciden con esa carpeta. |
| Aprobar una edición | Con permisos de preguntar, aprobar una edición de un archivo de prueba. La ejecución continúa, cambia ese archivo y conserva el resultado. |
| Reiniciar y desconectar red | Proyecto, chat e historial se recuperan. Con motor/modelo ya preparados, un chat local responde sin red. |
| Cerrar | En reposo cierra en menos de 2 segundos. Durante una respuesta, cancelar el cierre conserva el trabajo; detener y cerrar termina el motor propio sin dejarlo consumiendo memoria. |
| Desinstalar y reinstalar | Registrar qué opciones ofrece y cuáles se eligieron; comprobar conservación de proyectos/chats al mantener datos. No seleccionar borrado de datos para este caso. |
| Accesibilidad | Con lector de pantalla, recorrer proyecto, chat, selector de modelos y permisos; registrar controles sin nombre, foco perdido o anuncios repetidos. |

Para actualización, usar otro perfil de prueba con v0.2.2 y datos sintéticos, y actualizar con el
instalador candidato; comprobar proyectos, chats, agentes y preferencias. Esto prueba la actualización
manual: la descarga automática requiere una versión publicada y debe registrarse por separado.

Anotar por paso **aprobado, fallido o no ejecutado**, con captura/error y tiempo cuando corresponda.
Una VM sirve para Windows limpio; no reemplaza el recorrido en hardware integrado representativo.

## Si el motor no arranca en una PC nueva

No necesitás instalar Ollama por separado ni iniciar sesión. SaurioLLM descarga un motor portable propio después de instalar la app: elegí **Preparar motor local** y, cuando termine, **Usar motor de SaurioLLM**. Ese motor no aparece como una instalación global de Ollama en Windows.

El arranque espera hasta 30 segundos y distingue fallos al abrir el proceso, cierre temprano y falta de respuesta. Si continúa fallando, el mensaje conserva el detalle del sistema. El registro está en `%APPDATA%\SaurioLLM\logs\ollama-serve.log`; conservá sus últimas líneas para diagnosticar el problema. No borres tus proyectos ni vuelvas a descargar modelos para resolver un fallo de arranque.

Si instalaste una entrega anterior de v0.2.3, descargá y ejecutá nuevamente el instalador actualizado: conservar el mismo número de versión impide que se ofrezca automáticamente como una versión nueva.
