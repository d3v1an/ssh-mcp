# Análisis de Rendimiento y Optimización - s01-ssh-mcp

Este documento evalúa el rendimiento del servidor MCP para SSH tras las últimas actualizaciones y propone mejoras para optimizar el uso de recursos y la latencia.

## 1. Evaluación de Rendimiento Actual

### 1.1 Puntos Positivos
*   **Gestión de SFTP:** El uso de `fastPut` y `fastGet` de `ssh2` es la forma más eficiente de transferir archivos, ya que utiliza múltiples streams paralelos internamente.
*   **Límites de Buffer:** Se han implementado límites estrictos (`MAX_BUFFER = 1MB`) para el output de comandos y sesiones de shell, evitando el crecimiento descontrolado de memoria.
*   **Timeouts:** Todas las operaciones de ejecución ahora tienen un timeout global, evitando hilos colgados indefinidamente.
*   **Control de Historial:** Se ha limitado el historial a 100 registros y se ha restringido el almacenamiento de contenido previo para "undo" a 512KB por archivo.

### 1.2 Áreas de Mejora (Cuellos de Botella)

*   **Operaciones de E/S Síncronas:**
    *   **Hallazgo:** El `AuditLogger` utiliza `appendFileSync` y el cargador de perfiles usa `readFileSync`.
    *   **Impacto:** Aunque el protocolo MCP sobre STDIO es mayoritariamente secuencial, estas llamadas bloquean el *event loop*. En sistemas con alta latencia de disco o logs muy grandes, esto puede retrasar la respuesta del servidor.
*   **Gestión de Memoria en Sesiones Shell:**
    *   **Hallazgo:** Cada sesión de shell mantiene un buffer de hasta 1MB. Con el máximo de 5 sesiones, esto supone 5MB de buffers activos, más el historial de comandos.
    *   **Impacto:** Bajo para la mayoría de sistemas modernos, pero relevante si se escala a más sesiones o se ejecutan comandos con outputs masivos frecuentemente.
*   **Validación de Perfiles en Cada Conexión:**
    *   **Hallazgo:** `loadProfiles` lee y parsea el JSON completo cada vez que se requiere un perfil, aunque tiene un caché básico.
    *   **Mejora:** El caché es efectivo, pero la validación completa (`validateProfileEntry`) se ejecuta en cada carga inicial.

## 2. Recomendaciones de Optimización

### 2.1 Latencia y Concurrencia
1.  **Migrar a E/S Asíncrona:** Cambiar `appendFileSync` por `fs.promises.appendFile`. Esto permitirá que el servidor procese otras tareas (como heartbeats o limpieza de sesiones) mientras el log se escribe en disco.
2.  **Streaming en Lectura de Archivos:** Para `ssh_read_file`, si el archivo es grande, es preferible usar streams de SFTP en lugar de capturar todo el output con `cat` en memoria.

### 2.2 Eficiencia de Memoria
1.  **Buffer Circular para Shell:** Implementar un buffer circular real en lugar de `slice(-MAX_BUFFER)`, lo cual genera nuevos strings y carga el recolector de basura (GC).
2.  **Compresión de Historial:** Si el historial de "undo" crece, se podría considerar comprimir el `previousContent` en memoria (usando `zlib`) para permitir un historial más largo con el mismo consumo de RAM.

### 2.3 Optimización de Red (SSH)
1.  **Configuración de Algoritmos:** Restringir los algoritmos de intercambio de llaves y cifrado a solo los más modernos (ej. `chacha20-poly1305`, `ed25519`) puede reducir ligeramente el overhead de CPU en el cifrado.
2.  **Reutilización de Canal SFTP:** Actualmente `getSftp` ya reutiliza el cliente, lo cual es excelente. Se debe asegurar que las sesiones de shell también aprovechen la multiplexación del mismo canal SSH base.

## 3. Plan de Acción Sugerido

| Prioridad | Tarea | Beneficio |
| :--- | :--- | :--- |
| **Alta** | Convertir `AuditLogger` a asíncrono | Elimina bloqueos en el flujo principal |
| **Media** | Implementar streaming en `ssh_read_file` | Permite leer archivos mayores a 1MB sin crashes |
| **Baja** | Caché de perfiles pre-validado | Mejora el tiempo de arranque de conexión |

---
**Generado por:** Gemini CLI
**Fecha:** 2026-05-26
