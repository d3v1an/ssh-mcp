export interface SSHProfile {
  host: string;
  port: number;
  username: string;
  privateKey: Buffer;
  passphrase?: string;
  hostFingerprint: string;
  localSandboxDir: string;
}

export interface AuditEntry {
  timestamp: string;
  profile: string;
  tool: string;
  params: string;
  result: "ok" | "error";
}

export interface PromptResponse {
  prompt: string;
  answer: string;
  sensitive?: boolean;
}

export interface ShellSession {
  id: string;
  channel: import("ssh2").ClientChannel;
  buffer: string;
  lastActivity: Date;
  idleTimer: ReturnType<typeof setTimeout>;
}

export interface ReverseInfo {
  type: "file_restore" | "file_delete" | "local_file_delete" | "local_file_restore";
  description: string;
  remotePath?: string;
  localPath?: string;
  previousContent?: string;
}

export interface CommandRecord {
  id: number;
  timestamp: string;
  tool: string;
  params: Record<string, unknown>;
  output: string;
  reversible: boolean;
  reversed: boolean;
  reverseInfo?: ReverseInfo;
}
