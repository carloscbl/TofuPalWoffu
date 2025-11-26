# TofuPalWoffu

Extension de Chrome (Manifest V3) para preparar fichajes en Woffu en modo *dry-run*. Permite:

- Configurar credenciales y bloques horarios directamente desde el popup.
- Consultar el resumen mensual de diario y detectar dias sin fichaje valido.
- Previsualizar la carga (`PUT /api/diaries/{diaryId}/workday/slots/self`) para uno o varios dias antes de enviarla.
- Mantener los datos en local (`chrome.storage`) sin realizar envios reales (modo dry-run siempre activo por defecto).

## Estructura

```
tools/woffu-extension/
  manifest.json
  popup.html
  options.html
  styles/popup.css
  scripts/
    config.js
    api.js
    popup.js
    content.js
  schemas/
    diary-summary.schema.json
    workday-slots-put.schema.json
  README.md
```

Los ejemplos de peticiones reales extraidos de `~/Documents/woffu/requests.txt` se han traducido a los esquemas JSON incluidos en `schemas/`, que sirven de guia para validar los datos utilizados por la extension.

## Instalacion en Chrome (modo desarrollador)

1. Empaqueta o copia la carpeta completa `tools/woffu-extension/` en tu máquina.
2. Abre `chrome://extensions/` y activa **Modo desarrollador**.
3. Usa **Cargar descomprimida** y selecciona la carpeta de la extension.
4. Fija el icono en la barra para acceder rápidamente.

## Configuracion inicial

1. Abre el popup y completa los campos básicos:
   - **Base URL**: por ejemplo `https://xxxxx.woffu.com`.
   - **User ID**: tu identificador numérico (ej. `xxxxxx`).
   - **Bearer token**: pega el JWT actual de Woffu.
   - **Comentario**: texto opcional que se añadirá a cada fichaje.
  - **Offset respecto UTC**: se detecta automáticamente según tu zona horaria (considera horario de verano/invierno).
  - **Bloques horarios (Lunes-Jueves)**: bloques por defecto para días laborables (ej. `08:00-13:00` y `14:00-17:30`).
  - **Bloques horarios (Viernes)**: bloques específicos para viernes (por defecto: `08:00-15:00`).
2. **Los datos se guardan automáticamente** al modificar cualquier campo (sin necesidad de pulsar ningún botón).
3. **Detección automática**: si abres el popup mientras navegas en `*.woffu.com`, la extensión intentará detectar automáticamente:
   - Base URL (desde el dominio)
   - User ID (desde localStorage, sessionStorage, URL o DOM)
   - Bearer token (desde localStorage, sessionStorage o requests)
   - Offset UTC (desde la zona horaria del navegador, ajustándose automáticamente a horario de verano/invierno)

## Flujo de uso

1. Selecciona el mes con el selector (`YYYY-MM`).
2. Pulsa **Cargar registros**. La extension consulta `GET /api/svc/core/diariesquery/users/{userId}/diaries/summary/presence` y filtra los dias editables pendientes (sin fichaje, con diferencia negativa o solicitudes pendientes).
3. Revisa la tabla de "Dias pendientes":
  - Cada fila incluye checkbox para incluir/excluir el dia.
  - **Selección automática inteligente**:
    - ✓ **Se marcan por defecto**: días sin bloques de fichaje
    - ✗ **NO se marcan**: el día actual, días con estado "pendiente" o días que ya tienen bloques
  - Indicadores visuales:
    - 🟢 **"Hoy"**: marca el día actual
    - 🟡 **"Pendiente"**: solicitudes pendientes de aprobación
    - 🔴 **"Sin bloques"**: no tiene fichajes registrados (se marcan automáticamente)
    - ⚪ **"Sin fichaje"**: tiene bloques pero diferencia negativa
  - Boton **Vista previa** para generar el payload del dia.
  - **La extensión detecta automáticamente si es viernes** y aplica los bloques horarios correspondientes.
4. Utiliza los botones de la parte inferior:
  - **Previsualizar dia**: toma el primer dia seleccionado o el marcado con *Vista previa*.
  - **Previsualizar selección**: genera un arreglo con todos los payloads marcados.
  - **Enviar selección**: envía los días seleccionados a Woffu (requiere confirmación previa).
5. El resultado aparece en la seccion "Vista previa":
   - Para previsualizaciones: muestra el endpoint y la carga que se enviaría.
   - Para envíos: muestra el resultado de cada request (éxito/fallo) y recarga automáticamente los registros.

## Modo dry-run y envíos reales

- El flag `dryRun` permanece visible en la configuración para referencia, pero ya no afecta al envío.
- La función `buildDryRunResponse` devuelve la estructura de previsualización para inspección.
- Al pulsar **Enviar selección**, la extensión:
  1. Muestra un diálogo de confirmación con los días a enviar
  2. Ejecuta las llamadas `PUT` a la API de Woffu
  3. Muestra el resultado detallado de cada envío (éxito/fallo)
  4. Recarga automáticamente los registros después de 2 segundos

## Consideraciones de seguridad

- La extension almacena el JWT en el almacenamiento local del navegador; recuerda renovarlo manualmente cuando caduque.
- La extensión intenta detectar el token automáticamente desde las páginas de Woffu, pero nunca lo envía a terceros.
- Evita compartir la carpeta de la extension con el token incrustado.
- Si prefieres trabajar solo con datos de prueba, deja el token vacio y pega respuestas manualmente en la consola (`previewOutput`).

## Próximos pasos sugeridos

- Permitir importar directamente un fichero JSON de configuracion.
- Anadir control granular por dia para modificar bloques horarios antes de previsualizar.
- Integrar notificaciones o badges cuando existan dias pendientes.
- Implementar el `PUT` real condicionado por un switch de seguridad adicional.
