import { readFileSync, openSync, closeSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { SSHProfile } from "./types.js";

interface ProfileEntry {
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
  hostFingerprint: string;
  localSandboxDir?: string;
}

interface ProfilesFile {
  [name: string]: ProfileEntry;
}

let profilesCache: ProfilesFile | null = null;

function getProfilesPath(): string {
  return process.env.SSH_PROFILES_PATH || join(process.cwd(), "profiles.json");
}

export function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

function validateProfileEntry(name: string, entry: Partial<ProfileEntry>): void {
  const required: Array<keyof ProfileEntry> = ["host", "port", "username", "privateKeyPath", "hostFingerprint"];
  for (const field of required) {
    const val = entry[field];
    if (val === undefined || val === null || val === "") {
      const hint =
        field === "hostFingerprint"
          ? ` Obtén el fingerprint con: ssh-keyscan -t ed25519 ${entry.host ?? "HOST"} 2>/dev/null | ssh-keygen -lf -`
          : "";
      throw new Error(`Perfil "${name}": campo requerido "${field}" faltante o vacío.${hint}`);
    }
  }

  const keyPath = expandHome(entry.privateKeyPath!);
  try {
    const fd = openSync(keyPath, "r");
    closeSync(fd);
  } catch {
    throw new Error(
      `Perfil "${name}": no se puede leer la llave privada en "${keyPath}". ` +
        `Verifica que el archivo exista y tenga permisos correctos (chmod 600).`
    );
  }
}

export function loadProfiles(): ProfilesFile {
  if (profilesCache) return profilesCache;

  let raw: string;
  try {
    raw = readFileSync(getProfilesPath(), "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`No se puede leer profiles.json en "${getProfilesPath()}": ${msg}`);
  }

  let parsed: ProfilesFile;
  try {
    parsed = JSON.parse(raw) as ProfilesFile;
  } catch {
    throw new Error(`profiles.json contiene JSON inválido`);
  }

  if (Object.keys(parsed).length === 0) {
    throw new Error("profiles.json no contiene ningún perfil");
  }

  for (const [name, entry] of Object.entries(parsed)) {
    validateProfileEntry(name, entry);
  }

  profilesCache = parsed;
  return profilesCache;
}

export function getProfile(name: string): SSHProfile {
  const profiles = loadProfiles();
  const profile = profiles[name];
  if (!profile) {
    throw new Error(
      `Perfil "${name}" no encontrado. Disponibles: ${Object.keys(profiles).join(", ")}`
    );
  }

  const keyPath = expandHome(profile.privateKeyPath);
  let privateKey: Buffer;
  try {
    privateKey = readFileSync(keyPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`No se pudo leer la llave privada para "${name}" en ${keyPath}: ${msg}`);
  }

  const passphrase = process.env[`SSH_PASSPHRASE_${name.toUpperCase()}`];
  const localSandboxDir = resolve(
    expandHome(profile.localSandboxDir ?? process.cwd())
  );

  return {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    privateKey,
    passphrase: passphrase ?? undefined,
    hostFingerprint: profile.hostFingerprint,
    localSandboxDir,
  };
}

export function listProfiles(): Record<
  string,
  {
    host: string;
    port: number;
    username: string;
    privateKeyPath: string;
    hostFingerprint: string;
    localSandboxDir?: string;
  }
> {
  const profiles = loadProfiles();
  const result: ReturnType<typeof listProfiles> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    result[name] = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      privateKeyPath: profile.privateKeyPath,
      hostFingerprint: profile.hostFingerprint,
      localSandboxDir: profile.localSandboxDir,
    };
  }
  return result;
}
