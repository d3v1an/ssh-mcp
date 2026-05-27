# Análisis de Seguridad y Calidad — s01-ssh-mcp

> Generado: 2026-05-26 | Versión analizada: 0.3.1

---

## Resumen ejecutivo

| Categoría | Crítico | Alto | Medio | Bajo |
|-----------|:-------:|:----:|:-----:|:----:|
| Seguridad  | 1       | 2    | 4     | 3    |
| Calidad    | 0       | 1    | 3     | 4    |

---

## SEGURIDAD

### 🔴 CRÍTICO

#### SEC-01 — Sin verificación de llave de host (MITM)
**Archivo:** `src/index.ts:147-153`

`client.connect()` no pasa `hostVerifier`. El comportamiento por defecto de `ssh2` acepta cualquier llave de host desconocida sin verificación. Esto expone todas las conexiones a ataques Man-in-the-Middle: un atacante en la misma red puede suplantar el servidor y recibir la llave privada durante el handshake.

**Evidencia:**
```typescript
client.connect({
  host: profile.host,
  port: profile.port,
  username: profile.username,
  privateKey: profile.privateKey,  // enviada sin verificar a quién
  passphrase: profile.passphrase,
});
```

**Corrección:** Almacenar el fingerprint del host en `profiles.json` y validarlo:
```typescript
// profiles.json — agregar:
// "hostFingerprint": "SHA256:xxxx..."

client.connect({
  ...
  hostVerifier: (fingerprint) => {
    const expected = profile.hostFingerprint;
    if (!expected) return false; // rechazar si no hay fingerprint configurado
    return fingerprint === expected;
  },
});
```
Para obtener el fingerprint actual: `ssh-keyscan -t ed25519 HOST | ssh-keygen -lf -`

---

### 🟠 ALTO

#### SEC-02 — ReDoS via regex controlada por el usuario
**Archivo:** `src/index.ts:471-475`

`handleExecInteractive` compila patrones de prompt directamente como `RegExp`:
```typescript
const compiledResponses = responses.map((r) => ({
  regex: new RegExp(r.prompt),  // ← input no sanitizado
  ...
}));
```
Un patrón como `(a+)+b` o `([a-zA-Z]+)*` con una cadena larga puede causar backtracking catastrófico y colgar el proceso indefinidamente (ReDoS).

**Corrección:** Usar la librería `safe-regex2` o validar que el patrón sea un string literal simple (sin metacaracteres complejos):
```typescript
import safeRegex from 'safe-regex2';

const compiledResponses = responses.map((r) => {
  const re = new RegExp(r.prompt);
  if (!safeRegex(re)) throw new Error(`Patrón de prompt inseguro: ${r.prompt}`);
  return { regex: re, answer: r.answer, sensitive: r.sensitive || false };
});
```

---

#### SEC-03 — `execCommand` sin timeout
**Archivo:** `src/index.ts:948-976`

El método interno `execCommand` (usado por `ssh_exec`, `ssh_read_file`, y las capturas previas en `ssh_write_file`/`ssh_upload`) no tiene ningún timeout. Un comando remoto colgado (e.g. `cat /dev/zero`, `sleep infinity`, o una lectura bloqueada) deja la Promise pendiente para siempre, congelando el handler y potencialmente el servidor MCP entero.

**Corrección:** Agregar timeout con `Promise.race`:
```typescript
private execCommand(command: string, timeoutMs = SSHMCPServer.EXEC_TIMEOUT): Promise<string> {
  const exec = new Promise<string>((resolve, reject) => { /* ... existente ... */ });
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout ejecutando: ${command}`)), timeoutMs)
  );
  return Promise.race([exec, timer]);
}
```

---

### 🟡 MEDIO

#### SEC-04 — Sin validación de tipos en `args` (inyección de tipos)
**Archivos:** todos los handlers en `src/index.ts`

Todos los handlers reciben `args: any` y castean directamente sin validación:
```typescript
const command = args.command as string;  // puede ser undefined, number, objeto
const confirm = args.confirm as boolean;
```
Si un modelo MCP malicioso o un bug envía `args.command = {toString: () => "rm -rf /"}`, el cast de TypeScript no detectará nada en runtime pero el comportamiento es indefinido.

**Corrección:** Validar en un punto centralizado usando un helper tipado:
```typescript
function requireString(args: any, key: string): string {
  const val = args?.[key];
  if (typeof val !== 'string' || val.trim() === '') {
    throw new Error(`Parámetro requerido "${key}" debe ser un string no vacío`);
  }
  return val;
}
```

---

#### SEC-05 — Timeout de usuario sin cota máxima
**Archivos:** `src/index.ts:449`, `src/index.ts:643`

Los parámetros `args.timeout` en `handleExecInteractive` y `handleShellSend` se usan directamente:
```typescript
const timeout = (args.timeout as number) || SSHMCPServer.EXEC_TIMEOUT;
```
Un valor de `2147483647` (MAX_INT) causaría un timer de ~24 días. En `handleShellSend` esto bloquearía el handler por ese tiempo.

**Corrección:**
```typescript
const MAX_TIMEOUT = 5 * 60_000; // 5 minutos
const timeout = Math.min(Math.max((args.timeout as number) || SSHMCPServer.EXEC_TIMEOUT, 1000), MAX_TIMEOUT);
```

---

#### SEC-06 — Cliente SFTP no se invalida tras error
**Archivo:** `src/index.ts:933-946`

`this.sftpClient` se inicializa una vez y se reutiliza. Si el subsistema SFTP del servidor remoto cierra o emite un error, el cliente almacenado queda en estado inválido. Las llamadas subsiguientes a `getSftp()` devuelven la referencia rota sin intentar reconectar.

**Corrección:** Escuchar el evento `close`/`error` del SFTP y nullificar la referencia:
```typescript
sftp.on('close', () => { this.sftpClient = null; });
sftp.on('error', () => { this.sftpClient = null; });
this.sftpClient = sftp;
```

---

#### SEC-07 — Bypass potencial de patrones peligrosos
**Archivo:** `src/security.ts:5-22`

Los patrones `isDangerousCommand` operan sobre el string del comando tal como llega. Algunos vectores de evasión:

| Técnica | Ejemplo | Detectado |
|---------|---------|:---------:|
| Separador `$IFS` | `rm${IFS}-rf${IFS}/` | No |
| Octal/hex en paths | `rm -rf /\x2fetc` | No |
| Variable interpolation | `D=/; rm -rf $D` | No |
| Wrapper con eval | `eval "rm -rf /"` | No |

**Nota importante:** La detección de comandos peligrosos **no debe ser la única línea de defensa**. El servidor remoto debe configurar sudoers restrictivos y el usuario SSH debe tener permisos mínimos necesarios (principio de mínimo privilegio). Los patrones son una capa de UX, no de seguridad real.

---

### 🔵 BAJO

#### SEC-08 — `audit.log` sin rotación
**Archivo:** `src/security.ts:37-47`

El log de auditoría crece indefinidamente sin rotación ni límite de tamaño. En un servidor MCP en producción con uso intensivo, puede agotar el disco.

**Corrección a largo plazo:** Usar una librería como `winston` con transporte de rotación de archivos, o redirigir a syslog. A corto plazo, documentar que requiere rotación externa (logrotate).

---

#### SEC-09 — `profiles.json` incluido en el paquete npm
**Archivo:** `package.json:16`

```json
"files": ["dist", "profiles.json", ...]
```
Si el repositorio se publica en npm con configuración real (hosts, usernames), esos metadatos quedan expuestos públicamente.

**Corrección:** Eliminar `profiles.json` de `files` y solo incluir `profiles.json.example` (o documentar que el archivo debe crearse localmente).

---

#### SEC-10 — Shell send registra input en audit tal como llega
**Archivo:** `src/index.ts:680`

```typescript
this.audit("ssh_shell_send", `sessionId=${sessionId} input=${raw ? "(raw)" : input}`, "ok");
```
Para modo no-raw, el input completo (que puede contener contraseñas de sudo, tokens, etc.) se escribe en `audit.log`. La redacción solo ocurre en `ssh_exec_interactive` (vía `r.sensitive`), no aquí.

**Corrección:** Truncar el input en el log o agregar un parámetro `sensitive` análogo al de `ssh_exec_interactive`.

---

## CALIDAD DE CÓDIGO

### 🟠 ALTO

#### QA-01 — Versión hardcodeada en el constructor
**Archivo:** `src/index.ts:41`

```typescript
this.server = new Server({ name: "ssh-mcp-server", version: "0.1.0" }, ...)
```
La versión es `"0.1.0"` pero `package.json` dice `"0.3.1"`. Se desincronizan en cada release.

**Corrección:** Leer la versión desde `package.json`:
```typescript
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
// ...
{ name: "ssh-mcp-server", version }
```

---

### 🟡 MEDIO

#### QA-02 — `handleStatus` lee la llave privada en cada llamada
**Archivo:** `src/index.ts:193`

```typescript
const profile = getProfile(this.currentProfile);
```
`handleStatus` llama a `getProfile` que ejecuta `readFileSync` sobre la llave privada solo para obtener `host`, `port` y `username`. En perfiles con llaves grandes o sistemas lentos, esto es redundante.

**Corrección:** Guardar los datos de display del perfil activo al conectar:
```typescript
private connectedProfileMeta: { host: string; port: number; username: string } | null = null;
// en handleConnect, after ready:
this.connectedProfileMeta = { host: profile.host, port: profile.port, username: profile.username };
```

---

#### QA-03 — Historial sin límite de tamaño en memoria
**Archivo:** `src/index.ts:743-759`

`commandHistory` crece sin límite. `ssh_write_file` y `ssh_upload` almacenan `previousContent` completo para cada operación. Escribir un archivo de 10 MB diez veces consume ~100 MB en memoria solo en el historial.

**Corrección:** Establecer un cap (e.g., últimas 100 entradas) y/o limitar `previousContent` a un tamaño máximo:
```typescript
private static readonly MAX_HISTORY = 100;
private static readonly MAX_PREV_CONTENT = 512 * 1024; // 512 KB

// En recordOperation:
if (reverseInfo?.previousContent && reverseInfo.previousContent.length > SSHMCPServer.MAX_PREV_CONTENT) {
  reverseInfo.previousContent = undefined;
  reverseInfo.description += " (contenido previo omitido: demasiado grande para undo)";
}
if (this.commandHistory.length > SSHMCPServer.MAX_HISTORY) {
  this.commandHistory.shift();
}
```

---

#### QA-04 — Sin `keepaliveInterval` en la conexión SSH
**Archivo:** `src/index.ts:147-153`

Las conexiones SSH sin keepalive son silenciosamente dropeadas por firewalls y NATs después de períodos de inactividad. El cliente `ssh2` no lo detecta hasta el próximo intento de operación, que entonces falla con un error críptico.

**Corrección:**
```typescript
client.connect({
  ...
  keepaliveInterval: 30_000,  // ping cada 30s
  keepaliveCountMax: 3,        // 3 fallos = cerrar
  readyTimeout: 20_000,        // timeout de handshake
});
```

---

### 🔵 BAJO

#### QA-05 — Caché de perfiles nunca invalidada
**Archivo:** `src/profiles.ts:13`, `src/profiles.ts:19`

`profilesCache` es un singleton de módulo. Si `profiles.json` cambia en disco (edición sin reiniciar), el servidor sigue usando los valores anteriores. No está documentado.

**Corrección:** Documentar explícitamente en el README y `CLAUDE.md` que los cambios en `profiles.json` requieren reinicio del servidor MCP.

---

#### QA-06 — `stdout` sin límite en `execCommand`
**Archivo:** `src/index.ts:956-975`

```typescript
stream.on("data", (data: Buffer) => { stdout += data.toString(); });
```
El buffer de stdout crece sin cota. Un comando como `cat /dev/urandom` o `find / -type f` puede generar gigabytes de output acumulado en memoria.

**Corrección:** Aplicar el mismo truncado que existe en los streams interactivos:
```typescript
stream.on("data", (data: Buffer) => {
  stdout += data.toString();
  if (stdout.length > SSHMCPServer.MAX_BUFFER) {
    stdout = stdout.slice(-SSHMCPServer.MAX_BUFFER);
  }
});
```

---

#### QA-07 — `handleShellSend` limpia buffer antes de enviar
**Archivo:** `src/index.ts:672`

```typescript
session.buffer = "";
session.channel.write(data);
```
Cualquier output que haya llegado entre el último `ssh_shell_read` y este `ssh_shell_send` se descarta silenciosamente. Esto puede hacer que el historial del shell sea inconsistente.

**Consideración:** Si el comportamiento intencional es "solo ver el output de este comando", está bien documentarlo. Si el objetivo es sesión continua, se debería acumular, no limpiar.

---

#### QA-08 — `rm` en undo sin flag `-f`
**Archivo:** `src/index.ts:867`

```typescript
await this.execCommand(`rm ${escapeShellArg(info.remotePath!)}`);
```
Si el archivo fue subido a una ruta que resultó ser un directorio, o si ya fue eliminado, este `rm` falla con error y la operación de undo queda a medias (`record.reversed` no se pone en `true`).

**Corrección:** Usar `rm -f` y manejar el caso de directorio:
```typescript
await this.execCommand(`rm -f ${escapeShellArg(info.remotePath!)}`);
```

---

## Prioridad de corrección sugerida

| # | ID | Impacto | Esfuerzo |
|---|----|---------|----------|
| 1 | SEC-01 | CRÍTICO — MITM con cualquier perfil | Medio |
| 2 | SEC-03 | ALTO — proceso colgado permanentemente | Bajo |
| 3 | SEC-02 | ALTO — DoS via ReDoS | Bajo |
| 4 | QA-01 | Versión incorrecta en todas las respuestas | Mínimo |
| 5 | QA-04 | Conexión silenciosa dropeada sin keepalive | Mínimo |
| 6 | SEC-05 | Timeout de usuario sin límite | Mínimo |
| 7 | QA-03 | Memoria ilimitada en historial | Bajo |
| 8 | SEC-06 | SFTP roto no se recupera | Bajo |
| 9 | SEC-04 | Validación de tipos en args | Medio |
| 10 | SEC-09 | profiles.json expuesto en npm | Mínimo |

---

## Archivos analizados

| Archivo | LOC | Notas |
|---------|----:|-------|
| `src/index.ts` | 1025 | Archivo principal — mayor concentración de issues |
| `src/profiles.ts` | 83 | Sólido tras migración a llaves |
| `src/security.ts` | 49 | Funcional pero insuficiente como única defensa |
| `src/types.ts` | 50 | Limpio |
| `src/tools.ts` | ~250 | Solo definiciones, sin lógica |
