# Instalar SaurioLLM

Guía para usuarios finales: cómo descargar e instalar SaurioLLM en Windows sin tocar código ni
compilar nada. Si en cambio querés compilar el proyecto vos mismo, mirá la sección "Desarrolladores"
del [`README.md`](../README.md).

## 1. Requisitos antes de instalar

- **Windows 11** (target principal de esta versión; no probado en Windows 10).
- Espacio libre en disco: el instalador pesa alrededor de 125 MB y la app instalada ronda los 450-500
  MB. Sumale el espacio de los modelos que instales en Ollama (varios GB cada uno).
- Para usar modelos locales gratis: [Ollama](https://ollama.com/download) instalado y corriendo en
  esta misma máquina. Alternativa sin instalar nada más: usar un proveedor por API (ver paso 6).

## 2. Descargar el instalador

1. Andá a la sección **[Releases](../../releases)** de este repositorio en GitHub.
2. Bajo la versión más reciente, descargá el archivo `SaurioLLM-Setup-<versión>.exe`.
3. No hace falta descargar nada más que ese `.exe` para instalar (los otros dos archivos del Release,
   `latest.yml` y `SaurioLLM-Setup-<versión>.exe.blockmap`, son solo para que las versiones futuras se
   actualicen solas — ver paso 5 — no hacen falta para instalar por primera vez). El instalador ya trae
   todo lo necesario (no requiere .NET, Visual C++ Redistributable ni ningún otro runtime aparte).

## 3. Instalar

1. Ejecutá el `.exe` que descargaste.
2. **Windows SmartScreen puede mostrar una advertencia** ("Windows protegió su PC" / "Windows
   protected your PC"). Esto pasa porque el instalador **no está firmado digitalmente** (firmar
   binarios en Windows requiere un certificado de firma de código pago, que este proyecto — gratuito y
   de código abierto — no tiene). El instalador no es más inseguro por eso; simplemente Windows no
   reconoce todavía al editor porque nadie pagó por esa verificación. Para continuar:
   - Hacé clic en **"Más información"** ("More info").
   - Hacé clic en **"Ejecutar de todas formas"** ("Run anyway").
   Si preferís no confiar en un instalador sin firma, podés compilarlo vos mismo desde el código
   fuente (ver "Desarrolladores" en el `README.md`) — el resultado es exactamente el mismo binario.
3. El instalador te deja elegir la carpeta de instalación (no es "un clic", `oneClick: false`).
   Seguí el asistente hasta el final.
4. Al terminar, SaurioLLM queda disponible en el menú Inicio y con un acceso directo.

## 4. Primer arranque

Al abrir SaurioLLM por primera vez te recibe un asistente de primer arranque que te ayuda a:

- Elegir o instalar un modelo local (si tenés Ollama corriendo, lo detecta y te recomienda modelos
  según tu placa de video y memoria disponible).
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
  que el archivo que descargó sea EXACTAMENTE el que se publicó (compara un hash `sha512`), pero eso no
  es una firma de editor — Windows sigue sin reconocer una identidad verificada detrás del binario. Es
  la misma limitación de siempre (sin certificado de firma de código pago), no algo nuevo que introduzca
  la actualización automática.

## 6. Modelos: local (Ollama) o por API

- **Local con Ollama (gratis, corre en tu máquina):** instalá [Ollama](https://ollama.com/download),
  dejalo corriendo, y desde el asistente de primer arranque o el Centro de modelos de SaurioLLM
  instalá un modelo (por ejemplo `qwen3:8b`). Requiere una placa de video con memoria suficiente para
  el modelo elegido; sin GPU también funciona pero más lento (CPU).
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
