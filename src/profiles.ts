import { readFileSync } from "fs";
import { join } from "path";
import { SSHProfile } from "./types.js";

interface ProfilesFile {
  [name: string]: {
    host: string;
    port: number;
    username: string;
  };
}

let profilesCache: ProfilesFile | null = null;

function getProfilesPath(): string {
  return process.env.SSH_PROFILES_PATH || join(process.cwd(), "profiles.json");
}

export function loadProfiles(): ProfilesFile {
  if (profilesCache) return profilesCache;
  const raw = readFileSync(getProfilesPath(), "utf-8");
  profilesCache = JSON.parse(raw) as ProfilesFile;
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

  const envKey = `SSH_PASSWORD_${name.toUpperCase()}`;
  const password = process.env[envKey];
  if (!password) {
    throw new Error(
      `Password no encontrado para perfil "${name}". Define la variable de entorno ${envKey}`
    );
  }

  return {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    password,
  };
}

export function listProfiles(): Record<string, Omit<SSHProfile, "password">> {
  const profiles = loadProfiles();
  const result: Record<string, Omit<SSHProfile, "password">> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    result[name] = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
    };
  }
  return result;
}
