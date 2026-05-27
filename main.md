# Análisis Consolidado — s01-ssh-mcp v0.4.0

**Fecha:** 2026-05-27
**Fuentes:** `claude_performance.md`, `codex_performance.md`, `gemini_performance.md`
**Rev. 2:** Incorpora refutaciones y correcciones de gemini y codex tras verificación en código real.

---

## Metodología

Cada hallazgo se cruzó entre los tres reportes. La columna **Reportes** indica en cuántos análisis independientes apareció el mismo problema. Los hallazgos marcados con ~~tachado~~ fueron refutados tras verificar el código real y se documentan para dejar constancia del razonamiento.

---

## Refutaciones confirmadas

### ~~P-11 — RegExp recompilados en cada chunk~~ ✅ Ya implementado

**Refutado por:** gemini + codex. Verificado en `src/index.ts:497-505`.

El código actual ya compila los `RegExp` **fuera** del listener, en `compiledResponses`:

```typescript
// src/index.ts:497 — compilación ocurre una sola vez aquí
const compiledResponses = responses.map((r) => {
  const re = new RegExp(r.prompt);
  // ... validación safe-regex2 ...
  return { regex: re, answer: r.answer, sensitive: r.sensitive || false };
});

// src/index.ts:572 — solo evaluación dentro del listener
for (const resp of compiledResponses) {
  if (resp.regex.test(chunk)) { ... }
}
```

**Conclusión:** Falso positivo. No requiere acción.

---

### ~~B-1 — `cleanupState()` no llamado en `error`~~ → Robustez defensiva opcional

**Refutado por:** codex. Verificado en `src/index.ts:129,142,172`.

La premisa del bug era incorrecta:
- `this.sshClient = client` ocurre **dentro de `client.on("ready")`** (línea 142), no antes.
- Si `error` dispara **antes** de `ready`: `this.sshClient` sigue siendo `null` (el check en línea 129 bloquearía una segunda conexión concurrente). No hay estado corrupto que limpiar.
- Si `error` dispara **después** de `ready` (conexión establecida): `ssh2` siempre emite `close` tras `error` en canales establecidos, y el handler de `close` (línea 172) ya tiene la guardia `if (this.sshClient === client)` y llama `cleanupState()`.

**Conclusión:** No es un bug. Agregar `cleanupState()` en el handler de `error` sería defensivamente inerte o podría causar doble limpieza. Queda como nota, no como ítem del plan.

---

## Parte I — Bugs de correctitud

### B-1 ★★★ `ssh_download` puede destruir archivos locales preexistentes al hacer undo

**Reportado por:** codex. Confirmado como el bug funcional más importante pendiente.
**Archivo:** `src/index.ts` → `handleDownload` (línea ~354), `handleUndo` (línea ~912)
**Severidad:** Alta

`ssh_download` registra la operación inversa como `local_file_delete` sin verificar si el archivo local ya existía antes de la descarga. Si había un archivo preexistente en esa ruta dentro del sandbox, `ssh_undo` lo elimina en lugar de restaurarlo.

Flujo problemático:

```
archivo_local_previo.txt  → ssh_download lo sobreescribe
→ historial: { action: "local_file_delete", localPath }
→ ssh_undo  → unlink(localPath)  ← destruye el archivo original sin restaurarlo
```

Corrección: antes de descargar, verificar si el archivo existe con `fs.stat`. Si existe, capturar su contenido como `previousContent` y registrar `action: "local_file_restore"`. Si no existe, mantener `action: "local_file_delete"`.

---

### B-2 ★★☆ `optionalNumber(0)` retorna `0` — `limit: 0` devuelve todos los registros

**Reportado por:** claude
**Archivo:** `src/index.ts` → `handleHistory`
**Severidad:** Baja

> **Ajuste de codex:** No cambiar `optionalNumber` globalmente (afecta otros usos con semánticas distintas). Resolver localmente en `handleHistory`.

```typescript
// Corrección local en handleHistory — no tocar validation.ts:
const rawLimit = optionalNumber(args.limit);
const limit = (rawLimit === undefined || rawLimit <= 0) ? 20 : rawLimit;
const records = this.history.slice(-limit);
```

---

### B-3 ★☆☆ Campo `responses` en `handleExecInteractive` sin validación de tipos

**Reportado por:** claude
**Archivo:** `src/index.ts` → `handleExecInteractive` (línea ~487)
**Severidad:** Baja

> **Corrección de codex:** Los campos reales en `PromptResponse` (ver `src/types.ts:19-21`) son `prompt` y `answer`, **no** `pattern` y `response` como indicaba el borrador anterior. Aplicar el ejemplo del borrador tal cual introduciría un bug nuevo.

```typescript
// Corrección — con nombres de campo reales:
function parseResponses(raw: unknown): PromptResponse[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is PromptResponse =>
      typeof r === "object" && r !== null &&
      typeof (r as PromptResponse).prompt === "string" &&
      typeof (r as PromptResponse).answer === "string"
  );
}
```

---

## Parte II — Problemas de rendimiento

### P-1 ★★★ `execCommand()` no cancela el canal SSH al vencer el timeout

**Reportado por:** claude, codex, gemini
**Archivo:** `src/index.ts` → `execCommand` (línea ~1037)
**Severidad:** Alta

`Promise.race` rechaza por timeout pero el comando remoto sigue ejecutándose. Tres problemas combinados:

- **Fuga de handle**: el `setTimeout` vive hasta 30s después de que el race resolvió
- **Fuga de listeners**: eventos `data`/`close` del stream siguen activos
- **Efecto lateral tardío**: el comando puede terminar después del timeout y mutar estado remoto

> **Ajuste de codex sobre la solución:** El `.finally(() => execStream?.destroy())` del borrador anterior está demasiado simplificado. La receta correcta es: guardar referencia al stream, destruirlo **solo si el timeout ganó** (no en éxito), y limpiar timer y listeners explícitamente en todos los caminos.

Corrección:

```typescript
private execCommand(command: string, timeoutMs = SSHMCPServer.EXEC_TIMEOUT): Promise<string> {
  let timerId: ReturnType<typeof setTimeout>;
  let execStream: ClientChannel | undefined;
  let timedOut = false;

  const exec = new Promise<string>((resolve, reject) => {
    this.sshClient!.exec(command, (err, stream) => {
      if (err) { reject(err); return; }
      execStream = stream;
      let output = "";
      stream.on("data", (d: Buffer) => {
        output += d.toString();
        if (output.length > 1_048_576) output = output.slice(-1_048_576);
      });
      stream.stderr.on("data", (d: Buffer) => {
        output += d.toString();
        if (output.length > 1_048_576) output = output.slice(-1_048_576);
      });
      stream.on("close", () => resolve(output));
      stream.on("error", reject);
    });
  });

  const timer = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([exec, timer]).finally(() => {
    clearTimeout(timerId!);
    if (timedOut) execStream?.destroy();
  });
}
```

> Nota: esta corrección también incorpora el límite de `stderr` (P-2 abajo).

---

### P-2 ★★★ `appendFileSync` bloquea el event loop en cada operación auditada

**Reportado por:** claude, codex, gemini
**Archivo:** `src/security.ts` → `AuditLogger.log` (línea ~74)
**Severidad:** Media-Alta

Toda tool call ejecuta una escritura síncrona a disco. En discos lentos o NFS congela Node.js durante la escritura.

> **El CLAUDE.md documenta esto como "non-blocking"**, pero se refiere al manejo silencioso de errores, no al modelo I/O. La documentación también debe corregirse.

> **Ajuste de codex y gemini:** `appendFile` simple puede perder orden bajo concurrencia. La solución preferida es `WriteStream` con backpressure:

```typescript
import { createWriteStream, WriteStream } from "fs";

export class AuditLogger {
  private stream: WriteStream;

  constructor(logPath: string) {
    this.stream = createWriteStream(logPath, {
      flags: "a",
      mode: 0o600,
      encoding: "utf-8",
    });
  }

  log(entry: AuditEntry): void {
    const line = buildLine(entry);
    this.stream.write(line);  // no bloqueante, orden garantizado por WriteStream
  }
}
```

> Si el stream no puede draining, `write()` retorna `false` y Node gestiona el backpressure internamente. Para este caso de uso (log de auditoría) es suficiente sin manejar el evento `drain` explícitamente.

---

### P-3 ★★★ `stderr` sin límite de buffer en `execCommand`

**Reportado por:** codex, gemini
**Archivo:** `src/index.ts` → `execCommand`
**Severidad:** Media

`stdout` tiene límite de 1 MB pero `stderr` crece sin tope. Un proceso verboso en error puede consumir memoria indefinidamente.

Corrección: aplicar el mismo límite (ya incorporado en el ejemplo de P-1):

```typescript
stream.stderr.on("data", (d: Buffer) => {
  output += d.toString();
  if (output.length > 1_048_576) output = output.slice(-1_048_576);
});
```

---

### P-4 ★★☆ `previousContent` se lee completo antes de decidir si guardarlo

**Reportado por:** codex
**Archivo:** `src/index.ts` → operaciones `ssh_write_file`, `ssh_upload`
**Severidad:** Media

La protección `MAX_PREV_CONTENT` (512 KB) descarta el contenido si supera el umbral, pero el archivo ya fue leído completamente en memoria con `cat -- path`. El costo de red y memoria ya ocurrió antes de la decisión.

Corrección: consultar el tamaño antes de leer con `sftp.stat()`:

```typescript
const stat = await new Promise<Stats>((resolve, reject) =>
  this.sftp!.stat(remotePath, (err, s) => err ? reject(err) : resolve(s))
);
if (stat.size > SSHMCPServer.MAX_PREV_CONTENT) {
  // registrar undo sin previousContent — evitar leer
} else {
  const content = await this.execCommand(`cat -- ${escapeShellArg(remotePath)}`);
  // registrar con previousContent
}
```

---

### P-5 ★★☆ `ssh_read_file` lee el archivo completo sin control de tamaño

**Reportado por:** codex, gemini
**Archivo:** `src/index.ts` → `handleReadFile`
**Severidad:** Media

`cat -- path` sobre un archivo de 100 MB genera un string de 100 MB en memoria antes de enviarlo por stdio MCP.

Corrección mínima: agregar parámetros opcionales `offset` y `limit` (en líneas) al tool, implementando con `sed -n 'N,Mp'` o SFTP streaming para archivos grandes.

---

### P-6 ★★★ Materialización completa del buffer de shell antes de truncar

**Reportado por:** claude, codex, gemini
**Archivo:** `src/index.ts` → handler `data` de sesiones shell
**Severidad:** Baja-Media

```typescript
session.buffer += data.toString();                    // string completo materializado
if (session.buffer.length > SSHMCPServer.MAX_BUFFER) {
  session.buffer = session.buffer.slice(-SSHMCPServer.MAX_BUFFER);  // luego recortado
}
```

Corrección — verificar antes de concatenar para no materializar el exceso:

```typescript
const chunk = data.toString();
if (session.buffer.length + chunk.length > SSHMCPServer.MAX_BUFFER) {
  session.buffer = (session.buffer + chunk).slice(-SSHMCPServer.MAX_BUFFER);
} else {
  session.buffer += chunk;
}
```

---

### P-7 ★★☆ Concatenación incremental de strings en lugar de acumulación de chunks

**Reportado por:** codex, gemini
**Archivo:** `src/index.ts` → múltiples handlers de `data`
**Severidad:** Baja-Media

`output += chunk` genera copias repetidas del string creciente, incrementando presión sobre el GC. Más relevante en `execCommand` y sesiones shell con salidas grandes.

Corrección: acumular en array y unir al final (compatible con el límite de 1 MB):

```typescript
const chunks: string[] = [];
stream.on("data", (d: Buffer) => chunks.push(d.toString()));
stream.on("close", () => {
  let output = chunks.join("");
  if (output.length > 1_048_576) output = output.slice(-1_048_576);
  resolve(output);
});
```

---

### P-8 ★☆☆ Clave privada SSH leída de disco en cada `ssh_connect`

**Reportado por:** claude, codex, gemini
**Archivo:** `src/profiles.ts` → `getProfile`
**Severidad:** Baja

> **Ajuste de codex:** El costo real es pequeño comparado con el handshake SSH. No priorizar por encima de B-1, P-1, P-3, P-4, P-5.

`readFileSync(keyPath)` se ejecuta en cada `ssh_connect`. El servidor ya requiere reinicio para cambios en `profiles.json`, por lo que cachear en `loadProfiles()` es semánticamente equivalente:

```typescript
// En loadProfiles(), durante validación del perfil:
const privateKey = readFileSync(resolvedKeyPath);
profilesCache[name] = { ...entry, privateKeyPath: resolvedKeyPath, privateKey };
```

---

### P-9 ★☆☆ `handleHistory()` copia el array completo antes de filtrar

**Reportado por:** codex
**Archivo:** `src/index.ts` → `handleHistory`
**Severidad:** Baja

Con `MAX_HISTORY=100` el impacto es mínimo pero innecesario. Corrección: filtrar directamente sobre la referencia o aplicar `slice(-limit)` antes cuando no hay filtro.

---

### P-10 ★☆☆ Permisos del audit log no se corrigen si el archivo ya existe

**Reportado por:** codex
**Archivo:** `src/security.ts` → constructor de `AuditLogger`
**Severidad:** Baja

`openSync(path, 'a', 0o600)` aplica el modo solo al crear el archivo. Un `audit.log` preexistente con permisos más amplios mantiene sus permisos. Corrección:

```typescript
try { chmodSync(this.logPath, 0o600); } catch { /* silencioso si no existe aún */ }
```

---

## Parte III — Propuestas solo en Gemini (evaluación opcional)

**G-1: Restringir algoritmos SSH** — limitar `algorithms` a `chacha20-poly1305` + `ed25519` reduce CPU de cifrado. Bajo impacto en uso típico; añade fricción de configuración y puede romper compatibilidad con servidores antiguos.

**G-2: Comprimir `previousContent` con zlib** — permite más historial con la misma RAM. Añade complejidad en compress/decompress en cada undo. Conveniente solo si la RAM es un recurso escaso o el historial crece significativamente.

Ambas propuestas están fuera del plan de acción principal por ahora.

---

## Parte IV — Resumen ejecutivo y plan de acción

### Tabla de hallazgos

| ID | Hallazgo | Tipo | Severidad | Reportes | Esfuerzo |
| -- | -------- | ---- | --------- | -------- | -------- |
| B-1 | `ssh_download` destruye archivos previos en undo | Bug | Alta | 1/3 | Medio |
| P-1 | `execCommand` no cancela canal SSH al vencer timeout | Rendimiento | Alta | 3/3 | Medio |
| P-2 | `appendFileSync` bloquea event loop | Rendimiento | Media-Alta | 3/3 | Medio |
| P-3 | `stderr` sin límite de buffer | Rendimiento | Media | 2/3 | Bajo |
| P-4 | `previousContent` leído completo antes de decidir guardarlo | Rendimiento | Media | 1/3 | Medio |
| P-5 | `ssh_read_file` sin control de tamaño | Rendimiento | Media | 2/3 | Medio |
| P-6 | Buffer shell materializado antes de truncar | Rendimiento | Baja-Media | 3/3 | Bajo |
| P-7 | Concatenación incremental de strings | Rendimiento | Baja-Media | 2/3 | Bajo |
| B-2 | `limit: 0` devuelve todos los registros | Bug | Baja | 1/3 | Bajo |
| B-3 | `responses` sin validación de tipos (campos reales: `prompt`/`answer`) | Robustez | Baja | 1/3 | Bajo |
| P-8 | Clave SSH leída en cada connect | Rendimiento | Baja | 3/3 | Bajo |
| P-9 | `handleHistory` copia array completo | Rendimiento | Baja | 1/3 | Bajo |
| P-10 | Permisos audit log no corrigen archivo existente | Seguridad | Baja | 1/3 | Bajo |

**Eliminados por refutación:**

| ID | Hallazgo | Estado |
| -- | -------- | ------ |
| ~~P-11~~ | RegExp recompilados por chunk | Falso positivo — ya implementado correctamente |
| ~~B-1 orig~~ | `cleanupState()` no llamado en `error` | Refutado — `sshClient` solo se asigna en `ready` |

---

### Plan de acción por fases

> Orden recomendado por codex tras verificación en código real.

#### Fase 1 — Bug funcional + rendimiento crítico

1. **B-1**: Preservar archivo local preexistente en `ssh_download`; capturar `previousContent` si existía antes de la descarga
2. **P-1**: Cancelar canal SSH + limpiar timer con guardia `timedOut` en `execCommand`
3. **P-3**: Aplicar límite de 1 MB a `stderr` (se puede hacer junto con P-1)

#### Fase 2 — Rendimiento de I/O y memoria

1. **P-4**: Verificar tamaño con `sftp.stat()` antes de leer archivo para backup de `previousContent`
2. **P-5**: Agregar parámetros `offset`/`limit` a `ssh_read_file`
3. **P-2**: Migrar `AuditLogger` a `WriteStream` asíncrono

#### Fase 3 — Optimizaciones de buffers y validación

1. **B-3**: Validar `responses` con `parseResponses` — usar campos reales `prompt` / `answer`
2. **P-6 + P-7**: Unificar política de buffers — verificar antes de concatenar, acumular chunks
3. **B-2**: Fix local en `handleHistory` para `limit: 0` (no tocar `optionalNumber`)

#### Fase 4 — Limpieza menor

1. **P-8**: Cachear clave privada en `loadProfiles()`
2. **P-9**: Evitar copia del array en `handleHistory`
3. **P-10**: Agregar `chmodSync` en constructor de `AuditLogger`

#### Fase 5 — Evaluación opcional

- **G-1**: Algoritmos SSH restrictivos
- **G-2**: Compresión de historial con zlib

---

### Hallazgos con mayor consenso (3/3 reportes)

| Hallazgo | Fase |
| -------- | ---- |
| `execCommand` no cancela canal/timer | Fase 1 — P-1 |
| `appendFileSync` bloquea event loop | Fase 2 — P-2 |
| Buffer shell materializado antes de truncar | Fase 3 — P-6 |
| Clave SSH leída en cada connect | Fase 4 — P-8 |
