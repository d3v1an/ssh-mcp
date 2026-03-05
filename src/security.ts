import { appendFileSync } from "fs";
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

export function isDangerousCommand(cmd: string): { dangerous: boolean; reason: string } {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      return { dangerous: true, reason };
    }
  }
  return { dangerous: false, reason: "" };
}

export class AuditLogger {
  private logPath: string;

  constructor(logPath?: string) {
    this.logPath = logPath || join(process.cwd(), "audit.log");
  }

  log(entry: AuditEntry): void {
    const line = `[${entry.timestamp}] [${entry.profile}] [${entry.tool}] [${entry.params}] [RESULT: ${entry.result}]\n`;
    try {
      appendFileSync(this.logPath, line, "utf-8");
    } catch {
      // Silently fail on audit log write errors to not disrupt operations
    }
  }
}
