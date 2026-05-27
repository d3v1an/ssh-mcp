# Análisis de Rendimiento y Correctitud — s01-ssh-mcp v0.4.0

Fecha: 2026-05-27

---

## 1. Problemas de correctitud detectados

### 1.1 `optionalNumber` devuelve `0` en vez de `undefined` para `limit: 0`

**Archivo:** `src/validation.ts` + `src/index.ts` → `handleHistory`
**Severidad:** Baja

```typescript
// validation.ts
export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

// index.ts — handleHistory
const limit = optionalNumber(args.limit) ?? 20;
const records = this.history.slice(-limit);
```

Cuando el cliente envía `limit: 0`, `optionalNumber(0)` retorna `0` (no `undefined`), por lo que `?? 20` no se aplica. Luego `slice(-0)` equivale a `slice(0)`, lo que devuelve **todos** los registros en lugar de ninguno.

**Corrección sugerida:**

```typescript
export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}
```

---

### 1.2 `responses` en `handleExecInteractive` no pasa por validación centralizada

**Archivo:** `src/index.ts` → `handleExecInteractive`
**Severidad:** Baja

```typescript
const responses = ((args as Record<string, unknown>)?.responses ?? []) as PromptResponse[];
```

El campo `responses` se castea directamente sin validar que sea un array ni que sus elementos tengan la forma `{ pattern: string, response: string }`. Un input malformado puede causar errores en tiempo de ejecución dentro del loop de auto-respuesta.

**Corrección sugerida:**

```typescript
function parseResponses(raw: unknown): PromptResponse[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is PromptResponse =>
      typeof r === "object" && r !== null &&
      typeof (r as PromptResponse).pattern === "string" &&
      typeof (r as PromptResponse).response === "string"
  );
}
```

---

### 1.3 Dependencia implícita en `error` → `close` de ssh2 para `cleanupState()`

**Archivo:** `src/index.ts` → `handleConnect`
**Severidad:** Media

```typescript
client.on("error", (err) => {
  this.audit("ssh_connect", `profile=${profileName}`, "error");
  reject(new Error(`Error conectando a "${profileName}": ${err.message}`));
  // cleanupState() NO se llama aquí
});
```

`cleanupState()` solo se invoca desde el handler de `close`. Si `ssh2` emite `error` sin emitir `close` (posible en conexiones parcialmente establecidas), el estado (`sshClient`, `activeProfile`, etc.) queda corrupto y el servidor queda inutilizable hasta reiniciar.

**Corrección sugerida:**

```typescript
client.on("error", (err) => {
  this.audit("ssh_connect", `profile=${profileName}`, "error");
  reject(new Error(`Error conectando a "${profileName}": ${err.message}`));
  if (this.sshClient === client) {
    this.cleanupState();
  }
});
```

---

## 2. Problemas de rendimiento

### 2.1 `appendFileSync` bloquea el event loop en cada operación auditada

**Archivo:** `src/security.ts`
**Severidad:** Media
**Impacto:** Cada tool call (connect, exec, upload, etc.) realiza una escritura síncrona a disco. En sistemas con I/O lento, esto bloquea Node.js completamente durante esa escritura, introduciendo latencia observable.

```typescript
appendFileSync(this.logPath, line, "utf-8"); // bloquea el event loop
```

**Corrección sugerida:** Usar `appendFile` asíncrono con una cola de escritura para no perder entradas:

```typescript
import { appendFile } from "fs";

log(entry: AuditEntry): void {
  const line = `[${entry.timestamp}] ...\n`;
  appendFile(this.logPath, line, "utf-8", () => { /* silent fail */ });
}
```

> **Nota:** La solución asíncrona no garantiza orden estricto bajo alta concurrencia. Para producción, considerar una cola (array en memoria + draining periódico con `writeFileSync` o un `WriteStream`).

---

### 2.2 Timer de `execCommand` no se cancela tras resolver

**Archivo:** `src/index.ts` → `execCommand`
**Severidad:** Media
**Impacto:** El handle del `setTimeout` permanece activo hasta 30 segundos después de que el comando ya terminó. En servidores con muchos comandos rápidos, acumula handles colgantes que mantienen vivo el event loop y consumen memoria del heap.

```typescript
const timer = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error(`Timeout...`)), timeoutMs)
  // ↑ el timerId nunca se guarda ni cancela
);
return Promise.race([exec, timer]);
```

**Corrección sugerida:**

```typescript
private execCommand(command: string, timeoutMs = SSHMCPServer.EXEC_TIMEOUT): Promise<string> {
  let timerId: ReturnType<typeof setTimeout>;

  const exec = new Promise<string>((resolve, reject) => {
    this.sshClient!.exec(command, (err, stream) => {
      if (err) { reject(err); return; }
      let output = "";
      stream.on("data", (d: Buffer) => {
        output += d.toString();
        if (output.length > 1_048_576) output = output.slice(-1_048_576);
      });
      stream.stderr.on("data", (d: Buffer) => { output += d.toString(); });
      stream.on("close", () => resolve(output));
    });
  });

  const timer = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(`Timeout after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  return Promise.race([exec, timer]).finally(() => clearTimeout(timerId!));
}
```

---

### 2.3 Clave privada SSH leída de disco en cada `ssh_connect`

**Archivo:** `src/profiles.ts` → `getProfile`
**Severidad:** Media
**Impacto:** `readFileSync(keyPath)` se ejecuta en cada llamada a `ssh_connect`. Aunque los reconectas suelen ser poco frecuentes, en entornos con muchos reconnects (o perfil con clave en NFS/red) puede agregar latencia significativa.

```typescript
export function getProfile(name: string): SSHProfile & { privateKey: Buffer } {
  const profile = profilesCache[name];
  // ...
  const privateKey = readFileSync(keyPath); // leído en cada connect
  return { ...profile, privateKey };
}
```

**Corrección sugerida:** Cachear `privateKey` junto al resto del perfil en `loadProfiles()`, que ya valida la legibilidad del archivo con `openSync`:

```typescript
// En loadProfiles(), al validar cada perfil:
const privateKey = readFileSync(resolvedKeyPath);
profilesCache[name] = { ...entry, privateKeyPath: resolvedKeyPath, privateKey };
```

> Si el contenido de la clave cambia en disco entre reinicios, el servidor debe ser reiniciado de todas formas (los perfiles se cargan una sola vez al inicio), por lo que el caché es equivalente a la implementación actual pero sin la I/O repetida.

---

### 2.4 Materialización completa del buffer antes de truncar

**Archivo:** `src/index.ts` → handler de datos en `ssh_shell_send` / sesiones de shell
**Severidad:** Baja
**Impacto:** Cuando el buffer supera `MAX_BUFFER` (1 MB), se concatena el chunk completo primero y luego se hace `slice(-MAX_BUFFER)`. Esto materializa momentáneamente un string más grande que `MAX_BUFFER` en heap antes de descartarlo.

```typescript
session.buffer += data.toString();
if (session.buffer.length > SSHMCPServer.MAX_BUFFER) {
  session.buffer = session.buffer.slice(-SSHMCPServer.MAX_BUFFER);
}
```

**Corrección sugerida:** Verificar el tamaño antes de concatenar:

```typescript
const chunk = data.toString();
if (session.buffer.length + chunk.length > SSHMCPServer.MAX_BUFFER) {
  const combined = session.buffer + chunk;
  session.buffer = combined.slice(-SSHMCPServer.MAX_BUFFER);
} else {
  session.buffer += chunk;
}
```

---

### 2.5 Patrones de `safe-regex2` no cacheados entre llamadas

**Archivo:** `src/index.ts` → `handleExecInteractive`
**Severidad:** Baja
**Impacto:** En cada invocación de `ssh_exec_interactive`, cada patrón en `responses` se compila con `new RegExp()` en cada iteración del loop de datos. Si hay muchos chunks de datos y varios patrones, la compilación repetida es innecesaria.

```typescript
for (const response of responses) {
  const regex = new RegExp(response.pattern); // compilado en cada evento 'data'
  if (regex.test(output)) { ... }
}
```

**Corrección sugerida:** Compilar los `RegExp` una sola vez antes del loop de eventos:

```typescript
const compiled = responses.map(r => ({
  regex: new RegExp(r.pattern),
  response: r.response,
}));

stream.on("data", (data: Buffer) => {
  output += data.toString();
  for (const { regex, response } of compiled) {
    if (regex.test(output)) { /* auto-responder */ }
  }
});
```

---

## 3. Resumen y prioridades

| # | Problema | Tipo | Severidad | Esfuerzo |
|---|----------|------|-----------|---------|
| 1.3 | `cleanupState` no llamado en `error` si `close` no se emite | Bug | Media | Bajo |
| 2.1 | `appendFileSync` bloquea event loop | Rendimiento | Media | Medio |
| 2.2 | Timer de `execCommand` no cancelado | Rendimiento/Fuga | Media | Bajo |
| 2.3 | Clave SSH leída en cada connect | Rendimiento | Media | Bajo |
| 1.1 | `limit: 0` devuelve todos los registros | Bug | Baja | Bajo |
| 2.4 | Buffer materializado antes de truncar | Rendimiento | Baja | Bajo |
| 1.2 | `responses` sin validación de tipos | Robustez | Baja | Bajo |
| 2.5 | RegExp recompilados en cada chunk | Rendimiento | Baja | Bajo |

**Orden de atención recomendado:**
1. Corregir 1.3 (estado huérfano tras error de conexión) — riesgo funcional directo
2. Corregir 2.2 (timer leak) — corrección trivial, mejora inmediata
3. Corregir 2.3 (clave SSH cacheada) — corrección trivial, consistente con diseño de `loadProfiles`
4. Corregir 1.1 (`limit: 0`) — edge case menor pero comportamiento incorrecto
5. Evaluar 2.1 (audit async) — requiere más diseño para garantizar orden y no perder entradas
