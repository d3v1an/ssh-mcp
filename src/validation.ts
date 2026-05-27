const MAX_TIMEOUT_MS = 5 * 60_000;
const MIN_TIMEOUT_MS = 1_000;

type ArgsMap = Record<string, unknown>;

function toMap(args: unknown): ArgsMap {
  return (args != null && typeof args === "object" ? args : {}) as ArgsMap;
}

export function requireString(args: unknown, key: string): string {
  const val = toMap(args)[key];
  if (typeof val !== "string" || val.trim() === "") {
    throw new Error(`Parámetro requerido "${key}" debe ser un string no vacío`);
  }
  return val;
}

export function optionalString(args: unknown, key: string): string | undefined {
  const val = toMap(args)[key];
  return typeof val === "string" ? val : undefined;
}

export function optionalBoolean(args: unknown, key: string): boolean | undefined {
  const val = toMap(args)[key];
  return typeof val === "boolean" ? val : undefined;
}

export function optionalNumber(args: unknown, key: string): number | undefined {
  const val = toMap(args)[key];
  return typeof val === "number" ? val : undefined;
}

export function clampTimeout(value: number | undefined, defaultMs: number): number {
  const v = typeof value === "number" ? value : defaultMs;
  return Math.min(Math.max(v, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}
