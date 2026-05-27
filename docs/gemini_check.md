# Análisis de Código y Seguridad - s01-ssh-mcp

Este documento detalla los hallazgos del análisis realizado al servidor MCP para SSH. Se han identificado puntos críticos de seguridad y áreas de mejora en la arquitectura y calidad del código.

## 1. Análisis de Seguridad

### 1.1 Vulnerabilidades Críticas y Moderadas

*   **Inyección de Comandos en Operaciones de Archivos (Moderado):**
    *   **Problema:** En `handleUpload`, `handleWriteFile` y `handleUndo`, se utiliza `cat ${escapeShellArg(remotePath)}` o `rm ${escapeShellArg(remotePath)}`. Aunque `escapeShellArg` protege contra la terminación de cadenas, no protege contra nombres de archivos que comiencen con guion (ej: `-oProxyCommand=...`), que podrían ser interpretados como opciones por el comando `cat` o `rm`.
    *   **Riesgo:** Un atacante (o un modelo descontrolado) podría intentar pasar parámetros a los binarios del sistema remoto.
    *   **Recomendación:** Usar el delimitador `--` para indicar el fin de las opciones: `cat -- ${escapeShellArg(path)}`.

*   **Acceso Sin Restricciones al Sistema de Archivos Local (Moderado):**
    *   **Problema:** Las herramientas `ssh_upload` y `ssh_download` permiten leer y escribir en *cualquier* ruta del sistema local donde se ejecuta el servidor MCP.
    *   **Riesgo:** Un modelo podría ser inducido a descargar archivos sensibles del servidor remoto al sistema local en rutas críticas, o subir archivos locales privados (ej: `~/.ssh/id_rsa`, `.env`) al servidor remoto.
    *   **Recomendación:** Implementar una "sandbox" o directorio restringido para operaciones locales, o requerir confirmación explícita para rutas fuera de un área segura.

*   **Detección de Comandos Peligrosos Evadible (Moderado):**
    *   **Problema:** El sistema en `security.ts` utiliza expresiones regulares simples. Estas son fáciles de evadir mediante:
        *   Obfuscación de comandos (ej: `r\m -r\f /`).
        *   Uso de codificación (base64, hex) dentro de bash.
        *   Uso de variables de entorno (ej: `A=rm; $A -rf /`).
        *   Diferencias en mayúsculas/minúsculas si no se manejan correctamente.
    *   **Riesgo:** Falsa sensación de seguridad.
    *   **Recomendación:** Considerar un enfoque de "lista blanca" para comandos permitidos o integrar un analizador de sintaxis shell más robusto.

### 1.2 Riesgos Menores

*   **Exposición de Datos Sensibles en Logs:**
    *   **Problema:** Aunque `ssh_exec_interactive` permite marcar respuestas como `sensitive`, la herramienta estándar `ssh_exec` registra todo el comando en el `audit.log`. Si un usuario ejecuta un comando con contraseñas en línea de comandos (ej: `mysql -pPASSWORD`), estas quedarán grabadas.
    *   **Recomendación:** Implementar un filtro de limpieza (redacción) en el `AuditLogger` para patrones comunes de secretos.

*   **Denegación de Servicio (DoS) Local:**
    *   **Problema:** El log de auditoría (`audit.log`) crece indefinidamente sin rotación.
    *   **Recomendación:** Implementar rotación de logs.

## 2. Mejoras de Código y Buenas Prácticas

### 2.1 Calidad y Rendimiento

*   **I/O Bloqueante en Node.js:**
    *   **Hallazgo:** Se utiliza `appendFileSync` y `readFileSync` en el flujo principal. Aunque MCP sobre STDIO suele ser secuencial, el uso de funciones síncronas bloquea el event loop.
    *   **Mejora:** Migrar a `fs.promises` para mantener la asincronía y mejorar la capacidad de respuesta.

*   **Manejo de Errores Silencioso:**
    *   **Hallazgo:** `AuditLogger.log` ignora errores de escritura silenciosamente.
    *   **Mejora:** Al menos emitir un `console.error` para que el administrador sepa que la auditoría está fallando.

*   **Lógica de "Undo" Limitada:**
    *   **Hallazgo:** El sistema de reversión captura el estado previo mediante `cat`. Esto fallará con archivos binarios grandes o si el archivo no tiene permisos de lectura. Además, el historial se pierde al reiniciar el proceso.
    *   **Mejora:** Para una reversión robusta, se requeriría un sistema de backups temporales o persistencia del historial en disco.

*   **Uso de `any` en TypeScript:**
    *   **Hallazgo:** Los handlers en `index.ts` usan frecuentemente `args: any`.
    *   **Mejora:** Definir interfaces para los argumentos de cada herramienta para aprovechar totalmente la seguridad de tipos de TypeScript.

### 2.2 Experiencia de Usuario (DX)

*   **Feedback de Progreso en SFTP:**
    *   **Hallazgo:** `fastPut` y `fastGet` no informan del progreso. En archivos grandes, el servidor parecerá colgado.
    *   **Mejora:** Implementar el callback de progreso de `ssh2` y enviar notificaciones (si el protocolo MCP lo permite en el futuro o mediante logs informativos).

*   **Emulación de Terminal:**
    *   **Hallazgo:** `stripAnsi` es una solución básica. Secuencias de control complejas de terminales modernos podrían corromper el buffer de texto.

## 3. Recomendaciones de Arquitectura

1.  **Segregación de Responsabilidades:** `index.ts` ha crecido significativamente (más de 1000 líneas). Sería beneficioso extraer los manejadores de herramientas a archivos independientes o clases de servicio.
2.  **Validación de Perfiles:** El cargador de perfiles no valida que el archivo `profiles.json` tenga el formato correcto antes de intentar usarlo, lo que causa errores en tiempo de ejecución en lugar de al inicio.
3.  **Gestión de Sesiones:** La limpieza de sesiones de shell depende de un timer de inactividad. Sería recomendable añadir una señal de "heartbeat" o verificar la salud de la conexión SSH periódicamente.

---
**Generado por:** Gemini CLI
**Fecha:** 2026-05-26
