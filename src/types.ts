export interface SSHProfile {
  host: string;
  port: number;
  username: string;
  password?: string;
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
  createdAt: Date;
  lastActivity: Date;
  idleTimer: ReturnType<typeof setTimeout>;
}
