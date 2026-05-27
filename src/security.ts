import { createWriteStream, WriteStream, chmodSync } from "fs";
import { join } from "path";
import { AuditEntry } from "./types.js";

const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|.*-rf\s+)\/(\s|$)/, reason: "rm recursivo en raíz del sistema" },
  { pattern: /rm\s+(-[a-zA-Z]*r|-rf)\s/, reason: "rm recursivo - puede eliminar archivos masivamente" },
  { pattern: /mkfs\./, reason: "formateo de sistema de archivos" },
  { pattern: /dd\s+if=/, reason: "escritura directa a disco con dd" },
  { pattern: /\breboot\b/, reason: "reinicio del servidor" },
  { pattern: /\bshutdown\b/, reason: "apagado del servidor" },
  { pattern: /\bhalt\b/, reason: "detención del servidor" },
  { pattern: /\bpoweroff\b/, reason: "apagado del servidor" },
  { pattern: /\binit\s+[06]\b/, reason: "cambio de runlevel (reinicio/apagado)" },
  { pattern: /chmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?777\s+\//, reason: "chmod 777 recursivo en raíz" },
  { pattern: /chown\s+-[a-zA-Z]*R/, reason: "chown recursivo - puede cambiar propiedad masivamente" },
  { pattern: />\s*\/dev\//, reason: "escritura directa a dispositivo" },
  { pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/, reason: "fork bomb" },
  { pattern: /\bsystemctl\s+(stop|disable|mask)\s/, reason: "detención/deshabilitación de servicio del sistema" },
  { pattern: /\bkillall\b/, reason: "terminación masiva de procesos" },
  { pattern: /\biptables\s+-F/, reason: "flush de reglas de firewall" },
];

// Redact common secret patterns before writing to audit log
const REDACT_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /password\s*=\s*\S+/gi, label: "password=" },
  { re: /passwd\s*=\s*\S+/gi, label: "passwd=" },
  { re: /token\s*=\s*\S+/gi, label: "token=" },
  { re: /secret\s*=\s*\S+/gi, label: "secret=" },
  { re: /api[_-]?key\s*=\s*\S+/gi, label: "api_key=" },
  { re: /Authorization:\s*\S+/gi, label: "Authorization:" },
  { re: /Bearer\s+\S+/gi, label: "Bearer" },
];

function redactSensitive(text: string): string {
  let result = text;
  for (const { re } of REDACT_PATTERNS) {
    result = result.replace(re, (match) => {
      const sep = match.indexOf("=") !== -1 ? "=" : ":";
      const idx = match.indexOf(sep);
      return idx !== -1 ? match.slice(0, idx + 1) + " [REDACTED]" : "[REDACTED]";
    });
  }
  return result;
}

export function isDangerousCommand(cmd: string): { dangerous: boolean; reason: string } {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      return { dangerous: true, reason };
    }
  }
  return { dangerous: false, reason: "" };
}

export class AuditLogger {
  private stream: WriteStream;

  constructor(logPath?: string) {
    const path = logPath || join(process.cwd(), "audit.log");
    try { chmodSync(path, 0o600); } catch { /* file may not exist yet */ }
    this.stream = createWriteStream(path, {
      flags: "a",
      mode: 0o600,
      encoding: "utf-8",
    });
    this.stream.on("error", () => {});
  }

  log(entry: AuditEntry): void {
    const params = redactSensitive(entry.params);
    const line = `[${entry.timestamp}] [${entry.profile}] [${entry.tool}] [${params}] [RESULT: ${entry.result}]\n`;
    this.stream.write(line);
  }
}
