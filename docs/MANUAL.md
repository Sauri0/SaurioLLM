# Manual de uso — SaurioLLM

Este manual describe **v0.2.3**. Consultá [Instalar SaurioLLM](INSTALAR.md) para descargarla.

## 1. Requisitos

### Si usás el instalador

Necesitás Windows x64 y espacio para la aplicación y los modelos que elijas. No hace falta instalar
Node.js, pnpm ni herramientas de desarrollo.

La preparación inicial del motor administrado y la descarga de modelos requieren Internet. Después
podés trabajar localmente. También podés conectar un Ollama existente o un proveedor por API.

El instalador no está firmado, por lo que Windows puede mostrar una advertencia de SmartScreen.

### Si ejecutás el código del repositorio

- Windows 11 es el target principal.
- Node.js 24 o posterior.
- pnpm 10.
- Dependencias instaladas con `pnpm install`.

Para desarrollo podés usar el motor administrado, un Ollama externo en su endpoint habitual o un
proveedor API configurado desde la aplicación.

## 2. Primer arranque

1. Abrí SaurioLLM desde Inicio o su acceso directo.
2. Elegí una de estas opciones:
   - **Motor de SaurioLLM:** descarga y prepara una copia portable administrada por la aplicación.
   - **Ollama existente:** usa una instancia que ya administrás.
   - **Proveedor API:** configura un endpoint compatible y, si corresponde, una clave.
3. Si elegiste el motor administrado, revisá el espacio requerido y comenzá la descarga. Podés
   cancelar y reintentar.
4. Elegí o descargá un modelo recomendado.
5. Creá un proyecto nuevo o abrí una carpeta existente.
6. Creá un chat y enviá tu primer mensaje.

El motor administrado usa sus propios archivos, puerto y carpeta de modelos. No modifica la
configuración de una instalación externa de Ollama.

## 3. Proyectos y chats

### Proyectos

Desde Inicio podés:

- crear un proyecto dentro del espacio administrado por SaurioLLM;
- abrir una carpeta que ya existe;
- volver a proyectos recientes;
- quitar un proyecto de la lista sin borrar sus archivos.

La raíz visible del proyecto es la misma que reciben el prompt y las herramientas. Al cambiar de
proyecto también cambian los chats, archivos y contexto activos.

### Chats

Cada proyecto mantiene su propia lista. El menú de un chat permite:

- fijar o desfijar;
- renombrar;
- archivar y restaurar;
- eliminar con confirmación.

La búsqueda encuentra chats por su título y contenido. Al reiniciar, la aplicación intenta restaurar
el último proyecto y chat que elegiste.

## 4. Elegir modo y modelo

### Modos

- **Preguntar:** responde y puede consultar información disponible sin ejecutar un trabajo completo.
- **Plan:** produce un checklist de pasos. Si el pedido depende del proyecto, puede leer y buscar
  fuentes antes de afirmar hallazgos. No edita archivos ni lleva a cabo el plan.
- **Agente:** puede usar las herramientas habilitadas, sujeto a la política de permisos del chat.

### Modelos

Podés dejar la selección en Automático o elegir proveedor y modelo. La selección muestra localidad,
contexto y capacidades conocidas. Un contexto provisional o una compatibilidad estimada aparecen
como tales.

**Solo modelos locales** bloquea una generación si el proveedor efectivo es cloud, incluso cuando el
chat fue creado antes de activar la opción. No se cambia automáticamente a otro proveedor.

## 5. Centro de modelos

### Instalados

Muestra los modelos disponibles y permite usarlos en el chat activo. Si un proveedor no responde, los
modelos de los demás proveedores siguen disponibles y el fallo se muestra por separado.

### Explorar

Permite buscar y filtrar catálogos por proveedor, cuantización, capacidad y contexto. Durante la
primera sincronización se muestra un estado de carga; si la red falla, la aplicación puede usar el
catálogo incluido.

La compatibilidad considera el tamaño del modelo y los recursos detectados. Es una ayuda para elegir,
no una garantía de rendimiento.

### Descargas

Cada trabajo informa su estado: descarga, verificación, preparación, completado, cancelado o fallido.
Podés cancelar un trabajo activo y reintentar uno cancelado o fallido. Los errores quedan visibles para
diagnóstico.

Para archivos GGUF públicos compatibles, SaurioLLM descarga a una carpeta temporal propia, valida
tamaño y formato, verifica el SHA-256 publicado cuando existe y recién entonces registra el modelo en
el motor local. Una descarga incompleta no aparece como modelo instalado.

## 6. Agentes y equipos

Los agentes personales son opcionales. Podés crear uno desde cero o partir de una plantilla:

- **Programador** para implementar cambios;
- **Tester** para verificar comportamiento;
- **Revisor** para inspeccionar sin modificar;
- **Director** para coordinar colaboradores habilitados.

Cada agente tiene instrucciones, modelo fijo o automático, herramientas permitidas y preset de
permisos. La aplicación valida las herramientas efectivas antes de pedir permiso o ejecutarlas.

En un chat de Director podés elegir colaboradores personales. Sólo esos agentes pueden recibir una
delegación. La selección persiste al reiniciar y la actividad identifica quién realizó cada tarea.

## 7. Herramientas, permisos y checkpoints

Las herramientas trabajan dentro de la carpeta del proyecto. La aplicación protege `.git` frente a
escrituras directas y comprueba conflictos cuando un archivo cambió desde su última lectura.

Los presets de permisos permiten elegir cuánto preguntar. Una tarjeta de permiso explica la acción,
su alcance y las opciones disponibles. Permitir una vez no crea una regla permanente; las decisiones
recordadas respetan el alcance elegido.

Cuando una edición pasa por el flujo normal se crea un checkpoint. Desde la tarjeta correspondiente
podés revisar el diff y revertir esa edición. Un checkpoint no revierte comandos arbitrarios, cambios
de configuración ni mensajes del chat.

## 8. Archivos, cambios y contexto

El panel contextual de Chats incluye:

- **Archivos:** árbol y visor de sólo lectura;
- **Cambios:** diff de checkpoints y cambios conocidos;
- **Terminal:** sesión dentro del proyecto, cuando está habilitada.

El árbol se actualiza ante cambios externos y permite buscar por nombre, ruta o contenido. Cambiar de
proyecto libera los observadores anteriores.

La sección **Qué contexto recibió la IA** muestra las fuentes incluidas, compactadas, podadas o no
disponibles. También indica si el límite de contexto fue informado por el proveedor o es provisional.
Las memorias se presentan como datos con procedencia, no como instrucciones ejecutables.

## 9. Proveedores API y costos

En **Ajustes → APIs y costos** podés agregar y probar un proveedor. La clave se guarda mediante el
almacén seguro de Windows y no vuelve a mostrarse completa.

Antes de una primera llamada no local, la aplicación requiere una elección explícita. El registro de
uso distingue:

- costo informado o facturado por el proveedor;
- costo estimado a partir de tarifas conocidas;
- costo desconocido.

Un valor ausente no se presenta como USD 0. Los errores de autenticación, límite y servicio ocupado
aparecen en el chat sin descartar proveedores que siguen funcionando.

## 10. Recursos y rendimiento

En **Ajustes → Motor y recursos** podés elegir un preset local y revisar CPU, RAM, GPU y memoria
detectadas. Los controles ajustan solicitudes y procesos administrados; no reasignan físicamente la
memoria ni cambian motores externos.

Rendimiento depende de:

- modelo y cuantización;
- longitud de contexto;
- memoria libre y otros programas activos;
- reparto entre CPU y GPU;
- velocidad del disco.

Las mediciones de un equipo no predicen las de otro. Usá los estados de compatibilidad y carga como
evidencia del equipo actual.

## 11. Teclado y zoom

- `Enter` envía; `Shift+Enter` agrega una línea.
- `Escape` cierra primero el diálogo o menú activo y devuelve el foco a su disparador.
- Los diálogos mantienen el recorrido de `Tab` y `Shift+Tab` dentro de sus controles.
- Las pestañas compactas aceptan flechas izquierda/derecha, Inicio y Fin.
- Con zoom alto, Chats separa **Proyecto y chats**, **Chat** y **Archivos y más** para conservar un
  ancho usable.
- La preferencia de movimiento reducido del sistema desactiva animaciones no esenciales.

## 12. Actualizaciones

La aplicación puede consultar actualizaciones si la opción está habilitada. Una actualización no se
aplica en silencio durante un trabajo activo. La versión nueva debe conservar proyectos, chats,
agentes, preferencias y credenciales.

Antes de una actualización importante, conservá una copia de tus proyectos. Los archivos del
proyecto viven fuera de la base de datos de la aplicación.

## 13. Diagnóstico

Si algo falla, anotá:

1. qué pediste;
2. modelo, proveedor y modo;
3. estado o mensaje visible;
4. si ocurrió antes o después de reiniciar;
5. pasos mínimos para repetirlo.

Los logs y la base local están dentro de la carpeta de datos de SaurioLLM en `%APPDATA%`. Antes de
compartirlos, revisá que no contengan claves, prompts, rutas o contenido privado. Nunca publiques una
base completa sin inspeccionarla.

### La ventana no abre

La mitigación de GPU está activa por defecto porque algunos entornos de Windows o virtualizados no
crean correctamente el contexto gráfico de Electron. Para una prueba de desarrollo podés habilitar la
aceleración con `SAURIO_GPU=1`. Si el problema persiste, reportá el tipo de GPU y el error sin incluir
identificadores únicos del equipo.

### El modelo no entra en memoria

Elegí una cuantización más chica, reducí el contexto o probá un modelo menor. La aplicación puede
proponer un reintento local con menos capas en GPU, pero no reduce el contexto en silencio ni cambia a
nube.

### Un proveedor falla

Revisá endpoint, credencial y catálogo. Un error 401 suele indicar autenticación; 429 puede indicar
límite o servicio ocupado. Los reintentos automáticos son acotados y el último error queda visible.

## 14. Verificación y límites de v0.2.3

El instalador y sus archivos de actualización tienen integridad verificada. El tamaño y SHA-256
están publicados en [el seguimiento del proyecto](../PROYECTO.md).

El gate de fuente está aprobado: **1.359 pruebas aprobadas y 5 omitidas**, typecheck y lint limpios, y
evaluación real **20/20 en 250,1 s** con lecturas y tareas en modo Plan, edición semántica,
checkpoint, diff, reversión, permisos y delegación. La matriz local/API y modelo retirado pasó sobre
el paquete final: error visible sin fallback. La preparación de esa prueba registra consentimiento
explícito por IPC; no automatiza el clic en la confirmación nativa de nube.

La validación externa en Windows limpio y una notebook con gráficos integrados se realizará como
trabajo de v0.2.4. La prueba real con lector de pantalla sigue pendiente, sin versión asignada. No se
afirma compatibilidad universal a partir de las pruebas del equipo de desarrollo.

Alcance de la corrección final: la suite de 1.359 pruebas incluye recomendaciones sin motor. La evaluación real 20/20 y los smokes de API, permisos, migración y zoom corresponden al corte anterior, cuyos módulos no cambiaron. Persistencia/reinicio se verificaron nuevamente sobre el instalador corregido.

Recorrido UI completo repetido sobre el instalador corregido: 12 pantallas, recomendaciones con motor apagado, chat del Director y colaboradores persistidos, borrador conservado ante error y cero excepciones del renderer.
