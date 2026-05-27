# Codex Check

Fecha: 2026-05-26

## Alcance

Se revisaron los archivos principales del proyecto:

- `src/index.ts`
- `src/security.ts`
- `src/profiles.ts`
- `src/tools.ts`
- `src/types.ts`
- `package.json`
- `tsconfig.json`
- `README.md`
- `README.es.md`

Validación ejecutada:

- `npm run build` -> OK

## Resumen Ejecutivo

El proyecto está relativamente compacto y fácil de seguir, pero concentra demasiado poder en herramientas que ejecutan comandos remotos y escriben archivos locales/remotos con pocas barreras adicionales. Los riesgos más importantes son:

1. Falta de verificación de identidad del host SSH.
2. Escritura y borrado arbitrario de archivos locales mediante `ssh_download` + `ssh_undo`.
3. Comandos remotos sin timeout real ni límites de salida en `execCommand`.
4. Exposición de datos sensibles en auditoría e historial.
5. Lectura/escritura de archivos grandes sin controles de tamaño ni estrategia atómica.

## Hallazgos

### 1. Crítico: no se valida la huella del host SSH

Referencia:

- `src/index.ts:147`

Detalle:

La conexión SSH se crea con `client.connect(...)`, pero no se configura `hostVerifier`, `hostHash` ni una lista de claves/fingerprints permitidos. Eso deja el canal expuesto a ataques de tipo MITM si el DNS, la red o el destino son manipulados.

Impacto:

- Conexión a un host no confiable sin detección.
- Exposición de comandos, archivos transferidos y respuestas interactivas.
- Falsa sensación de seguridad por usar llave privada aunque no se valida el servidor.

Recomendación:

- Soportar `hostFingerprint` o `knownHosts` por perfil.
- Configurar `hostHash` y `hostVerifier`.
- Fallar la conexión si la huella no coincide.

### 2. Alto: el flujo `ssh_download` + `ssh_undo` permite borrar archivos locales arbitrarios

Referencias:

- `src/index.ts:303`
- `src/index.ts:317`
- `src/index.ts:880`

Detalle:

`ssh_download` acepta cualquier `localPath` y guarda esa ruta en el historial reversible. Después, `ssh_undo` ejecuta `fs.unlinkSync(info.localPath!)` sin restringir ubicación, sin sandbox lógico y sin confirmar que el archivo fue creado realmente por esta ejecución.

Impacto:

- Un cliente MCP puede escribir en cualquier ruta accesible al proceso.
- Luego puede borrar cualquier archivo que haya quedado registrado en historial.
- Si el destino ya existía antes de descargar, el “undo” lo borra igualmente en vez de restaurar el estado previo.

Recomendación:

- Restringir descargas a un directorio base explícito.
- Registrar si el archivo local existía antes y restaurarlo, no solo borrarlo.
- Normalizar y validar rutas con `path.resolve`.
- Bloquear rutas sensibles o fuera de una allowlist.

### 3. Alto: `execCommand` no aplica timeout ni límite de memoria

Referencias:

- `src/index.ts:30`
- `src/index.ts:948`

Detalle:

Existe `EXEC_TIMEOUT`, pero `execCommand()` no lo usa. Tampoco aplica truncado de `stdout`/`stderr`. Un comando remoto colgado, muy verboso o con stream infinito puede dejar la petición abierta indefinidamente o crecer en memoria.

Impacto:

- Denegación de servicio del proceso MCP.
- Consumo de memoria no acotado.
- Posibles bloqueos al ejecutar `tail -f`, `yes`, `cat` de archivos enormes o comandos atascados.

Recomendación:

- Añadir timeout real a `execCommand`.
- Cortar el stream al alcanzar `MAX_BUFFER`.
- Marcar claramente cuando la salida fue truncada.
- Reutilizar la misma política de límites usada en flujos interactivos.

### 4. Alto: auditoría e historial pueden almacenar secretos en texto plano

Referencias:

- `src/index.ts:680`
- `src/index.ts:743`
- `src/index.ts:783`
- `src/index.ts:978`
- `src/security.ts:40`

Detalle:

La auditoría guarda `params` como texto plano en `audit.log`. El historial muestra parámetros completos y `ssh_shell_send` registra `input` cuando `raw` es `false`. `ssh_exec` y `ssh_exec_interactive` también persisten comandos completos. Eso puede capturar tokens, passwords, rutas sensibles o comandos con secretos embebidos.

Impacto:

- Filtración de credenciales en disco.
- Exposición accidental en soporte, logs o screenshots.
- Riesgo adicional porque `audit.log` se escribe en el directorio de trabajo sin política de permisos ni rotación.

Recomendación:

- Redactar automáticamente patrones sensibles (`password=`, tokens, headers, secrets).
- Evitar guardar el valor completo de `command` e `input`; almacenar hash o versión truncada.
- Configurar permisos restrictivos del log.
- Añadir opción para desactivar auditoría o redirigirla a una ubicación segura.

### 5. Medio: `ssh_read_file` y capturas previas leen archivos completos en memoria

Referencias:

- `src/index.ts:365`
- `src/index.ts:391`
- `src/index.ts:370`
- `src/index.ts:852`

Detalle:

La lectura remota usa `cat` completo. Además, antes de `ssh_write_file` y `ssh_upload` se intenta leer el contenido previo completo para permitir undo. Eso no distingue entre archivos de texto, binarios o archivos muy grandes.

Impacto:

- Alto consumo de memoria.
- Corrupción lógica del undo para binarios o contenido no UTF-8.
- Fallos o tiempos excesivos al tocar archivos grandes.

Recomendación:

- Limitar tamaño máximo legible.
- Detectar binarios y rechazar undo basado en texto.
- Para undo, preferir copia temporal remota o backup sidecar.
- Para lectura, usar SFTP stream o `head`/rangos cuando aplique.

### 6. Medio: el “undo” de archivos remotos no es atómico ni seguro para binarios

Referencias:

- `src/index.ts:398`
- `src/index.ts:846`

Detalle:

La restauración usa `createWriteStream(...).end(previousContent, "utf-8")`. Eso asume texto UTF-8 y sobrescribe directamente el archivo destino. Si el proceso cae a mitad de escritura, puede dejarlo truncado.

Impacto:

- Corrupción de configuración remota.
- Undo incorrecto para certificados, binarios o archivos con encoding distinto.

Recomendación:

- Guardar backups binarios con SFTP.
- Escribir a un archivo temporal y hacer rename atómico.
- Conservar metadatos relevantes cuando el caso lo requiera.

### 7. Medio: el estado de conexión puede quedar inconsistente si el servidor remoto corta la sesión

Referencias:

- `src/index.ts:123`
- `src/index.ts:142`
- `src/index.ts:927`

Detalle:

Se manejan eventos `ready` y `error`, pero no `close`, `end` o `keyboard-interactive` del cliente principal. Si la conexión cae después de establecida, `this.sshClient` puede seguir no nulo y `requireConnection()` seguirá devolviendo éxito.

Impacto:

- Errores tardíos y estado inválido.
- SFTP cacheado potencialmente muerto.
- Sesiones de shell e historial asociados a una conexión ya cerrada.

Recomendación:

- Escuchar `close`/`end` y limpiar `sshClient`, `sftpClient`, sesiones y estado asociado.
- Invalidar el cliente SFTP cuando el canal falle.

### 8. Medio: la protección contra comandos peligrosos es fácilmente evadible

Referencias:

- `src/security.ts:5`
- `src/index.ts:652`

Detalle:

La defensa depende de regex heurísticos. Eso es útil como freno suave, pero no como control de seguridad. Además, `ssh_shell_send` con `raw: true` evita la validación por completo, y variantes shell como `sh -c`, variables, subshells o comandos codificados pueden eludir la detección.

Impacto:

- Ejecución de acciones destructivas aunque el filtro no las marque.
- Riesgo de confiar operativamente en una protección que no es robusta.

Recomendación:

- Documentar esto como “warning only”, no como barrera de seguridad.
- Si se requiere control real, implementar allowlists por herramienta o perfil.
- Añadir policy mode por perfil: `read-only`, `ops-safe`, `full-access`.

### 9. Bajo: uso extensivo de `any` en handlers reduce garantías del schema

Referencias:

- `src/index.ts:110`
- `src/index.ts:210`
- `src/index.ts:247`
- `src/index.ts:445`
- `src/index.ts:762`

Detalle:

Los handlers reciben `args: any` y castear manualmente diluye parte del beneficio de TypeScript y del schema MCP. Un cambio en herramientas o payloads puede romper contratos sin señal temprana del compilador.

Impacto:

- Más riesgo de bugs de validación y coerción.
- Menor mantenibilidad.

Recomendación:

- Definir tipos por herramienta.
- Validar argumentos con Zod/Valibot o un parser equivalente.
- Centralizar la normalización de inputs.

### 10. Bajo: `profiles.json` expone inventario sensible de infraestructura

Referencias:

- `profiles.json:1`
- `src/profiles.ts:74`

Detalle:

Aunque no guarda la llave privada, sí versiona hosts, usuarios y rutas a llaves. En repos privados puede ser aceptable; en repos públicos o distribuidos por npm expone metadatos útiles para reconocimiento.

Impacto:

- Enumeración de entornos (`produccion`, `staging`).
- Exposición de naming y layout local de llaves.

Recomendación:

- Convertir `profiles.json` en plantilla de ejemplo.
- Ignorar el archivo real en VCS.
- Cargar configuración real desde ruta externa o variable de entorno.

## Mejoras Prioritarias

### Prioridad 1

- Validar fingerprint/known_hosts del host SSH.
- Restringir `ssh_download` y `ssh_undo` sobre el filesystem local.
- Añadir timeout y límite de buffer a `execCommand`.
- Redactar secretos en historial y auditoría.

### Prioridad 2

- Implementar undo binario/atómico para archivos.
- Limitar tamaño de lecturas remotas.
- Manejar eventos `close`/`end` del cliente SSH.

### Prioridad 3

- Reemplazar `any` por tipos reales.
- Añadir tests de seguridad y regresión.
- Separar perfiles reales de archivos de ejemplo.

## Pruebas Recomendadas

- Conexión rechazada cuando la fingerprint del host no coincide.
- `ssh_exec` cancelado por timeout en comando colgado.
- Truncado controlado de salidas grandes.
- `ssh_download` rechazado fuera del directorio permitido.
- `ssh_undo` restaura archivo local previo en vez de borrarlo.
- `ssh_write_file` y `ssh_upload` con archivos binarios.
- Limpieza automática de estado tras desconexión remota.
- Redacción de secretos en `audit.log` e historial.

## Conclusión

La base del proyecto es clara y compiló correctamente, pero hoy el servidor sigue siendo de alto privilegio con controles mayormente operativos y no de seguridad fuerte. Si este MCP va a usarse fuera de un entorno estrictamente confiable, conviene tratar como obligatorias las correcciones de prioridad 1 antes de ampliar adopción.
