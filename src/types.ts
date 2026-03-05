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
