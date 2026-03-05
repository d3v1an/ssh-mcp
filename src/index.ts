#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, SFTPWrapper } from "ssh2";
import dotenv from "dotenv";

import { tools } from "./tools.js";
import { getProfile, listProfiles } from "./profiles.js";
import { isDangerousCommand, AuditLogger } from "./security.js";

dotenv.config();

class SSHMCPServer {
  private server: Server;
  private sshClient: Client | null = null;
  private sftpClient: SFTPWrapper | null = null;
  private currentProfile: string | null = null;
  private connectedAt: Date | null = null;
  private auditLogger: AuditLogger;

  constructor() {
    this.auditLogger = new AuditLogger();
    this.server = new Server(
      { name: "ssh-mcp-server", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        switch (name) {
          case "ssh_list_profiles":
            return this.handleListProfiles();
          case "ssh_connect":
            return await this.handleConnect(args);
          case "ssh_disconnect":
            return await this.handleDisconnect();
          case "ssh_status":
            return this.handleStatus();
          case "ssh_exec":
            return await this.handleExec(args);
          case "ssh_upload":
            return await this.handleUpload(args);
          case "ssh_download":
            return await this.handleDownload(args);
          case "ssh_ls":
            return await this.handleLs(args);
          case "ssh_read_file":
            return await this.handleReadFile(args);
          case "ssh_write_file":
            return await this.handleWriteFile(args);
          default:
            throw new Error(`Tool desconocido: ${name}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    });
  }

  // --- Tool handlers ---

  private handleListProfiles(): CallToolResult {
    const profiles = listProfiles();
    return {
      content: [{ type: "text", text: JSON.stringify(profiles, null, 2) }],
    };
  }

  private async handleConnect(args: any): Promise<CallToolResult> {
    if (this.sshClient) {
      throw new Error(
        `Ya hay una conexión activa al perfil "${this.currentProfile}". Desconecta primero con ssh_disconnect.`
      );
    }

    const profileName = args.profile as string;
    const profile = getProfile(profileName);

    return new Promise<CallToolResult>((resolve, reject) => {
      const client = new Client();

      client.on("ready", () => {
        this.sshClient = client;
        this.currentProfile = profileName;
        this.connectedAt = new Date();

        this.audit("ssh_connect", `profile=${profileName}`, "ok");

        resolve({
          content: [
            {
              type: "text",
              text: `Conectado a "${profileName}" (${profile.username}@${profile.host}:${profile.port})`,
            },
          ],
        });
      });

      client.on("error", (err) => {
        this.audit("ssh_connect", `profile=${profileName}`, "error");
        reject(new Error(`Error conectando a "${profileName}": ${err.message}`));
      });

      client.connect({
        host: profile.host,
        port: profile.port,
        username: profile.username,
        password: profile.password,
      });
    });
  }

  private async handleDisconnect(): Promise<CallToolResult> {
    if (!this.sshClient) {
      throw new Error("No hay conexión activa.");
    }

    const profileName = this.currentProfile;
    this.sftpClient = null;
    this.sshClient.end();
    this.sshClient = null;
    this.currentProfile = null;
    this.connectedAt = null;

    this.audit("ssh_disconnect", `profile=${profileName}`, "ok");

    return {
      content: [{ type: "text", text: `Desconectado de "${profileName}".` }],
    };
  }

  private handleStatus(): CallToolResult {
    if (!this.sshClient || !this.currentProfile || !this.connectedAt) {
      return {
        content: [{ type: "text", text: "No hay conexión activa." }],
      };
    }

    const uptime = Math.floor((Date.now() - this.connectedAt.getTime()) / 1000);
    const profile = getProfile(this.currentProfile);

    return {
      content: [
        {
          type: "text",
          text: [
            `Perfil: ${this.currentProfile}`,
            `Host: ${profile.host}:${profile.port}`,
            `Usuario: ${profile.username}`,
            `Conectado hace: ${formatUptime(uptime)}`,
          ].join("\n"),
        },
      ],
    };
  }

  private async handleExec(args: any): Promise<CallToolResult> {
    this.requireConnection();
    const command = args.command as string;
    const confirm = args.confirm as boolean | undefined;

    const check = isDangerousCommand(command);
    if (check.dangerous && !confirm) {
      return {
        content: [
          {
            type: "text",
            text: [
              `ADVERTENCIA: Comando potencialmente destructivo detectado.`,
              `Comando: ${command}`,
              `Razón: ${check.reason}`,
              ``,
              `Para ejecutar este comando, reenvía con confirm: true.`,
            ].join("\n"),
          },
        ],
      };
    }

    try {
      const output = await this.execCommand(command);
      this.audit("ssh_exec", command, "ok");
      return {
        content: [{ type: "text", text: output || "(sin salida)" }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.audit("ssh_exec", command, "error");
      throw new Error(`Error ejecutando comando: ${msg}`);
    }
  }

  private async handleUpload(args: any): Promise<CallToolResult> {
    this.requireConnection();
    const { localPath, remotePath } = args as { localPath: string; remotePath: string };

    const sftp = await this.getSftp();

    return new Promise<CallToolResult>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => {
        if (err) {
          this.audit("ssh_upload", `${localPath} -> ${remotePath}`, "error");
          reject(new Error(`Error subiendo archivo: ${err.message}`));
        } else {
          this.audit("ssh_upload", `${localPath} -> ${remotePath}`, "ok");
          resolve({
            content: [
              { type: "text", text: `Archivo subido: ${localPath} -> ${remotePath}` },
            ],
          });
        }
      });
    });
  }

  private async handleDownload(args: any): Promise<CallToolResult> {
    this.requireConnection();
    const { remotePath, localPath } = args as { remotePath: string; localPath: string };

    const sftp = await this.getSftp();

    return new Promise<CallToolResult>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => {
        if (err) {
          this.audit("ssh_download", `${remotePath} -> ${localPath}`, "error");
          reject(new Error(`Error descargando archivo: ${err.message}`));
        } else {
          this.audit("ssh_download", `${remotePath} -> ${localPath}`, "ok");
          resolve({
            content: [
              { type: "text", text: `Archivo descargado: ${remotePath} -> ${localPath}` },
            ],
          });
        }
      });
    });
  }

  private async handleLs(args: any): Promise<CallToolResult> {
    this.requireConnection();
    const path = (args.path as string) || ".";

    const sftp = await this.getSftp();

    return new Promise<CallToolResult>((resolve, reject) => {
      sftp.readdir(path, (err, list) => {
        if (err) {
          reject(new Error(`Error listando directorio "${path}": ${err.message}`));
          return;
        }

        const entries = list.map((entry) => {
          const type = entry.attrs.isDirectory() ? "d" : entry.attrs.isSymbolicLink() ? "l" : "-";
          const size = entry.attrs.size;
          return `${type} ${entry.attrs.uid}:${entry.attrs.gid} ${padRight(String(size), 10)} ${entry.filename}`;
        });

        resolve({
          content: [{ type: "text", text: entries.join("\n") || "(directorio vacío)" }],
        });
      });
    });
  }

  private async handleReadFile(args: any): Promise<CallToolResult> {
    this.requireConnection();
    const remotePath = args.path as string;

    try {
      const content = await this.execCommand(`cat ${escapeShellArg(remotePath)}`);
      this.audit("ssh_read_file", remotePath, "ok");
      return {
        content: [{ type: "text", text: content }],
      };
    } catch (error) {
      this.audit("ssh_read_file", remotePath, "error");
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Error leyendo archivo "${remotePath}": ${msg}`);
    }
  }

  private async handleWriteFile(args: any): Promise<CallToolResult> {
    this.requireConnection();
    const { path: remotePath, content } = args as { path: string; content: string };

    const sftp = await this.getSftp();

    return new Promise<CallToolResult>((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath);

      stream.on("close", () => {
        this.audit("ssh_write_file", remotePath, "ok");
        resolve({
          content: [
            { type: "text", text: `Archivo escrito: ${remotePath} (${content.length} bytes)` },
          ],
        });
      });

      stream.on("error", (err: Error) => {
        this.audit("ssh_write_file", remotePath, "error");
        reject(new Error(`Error escribiendo archivo "${remotePath}": ${err.message}`));
      });

      stream.end(content, "utf-8");
    });
  }

  // --- Helpers ---

  private requireConnection(): void {
    if (!this.sshClient) {
      throw new Error("No hay conexión activa. Usa ssh_connect primero.");
    }
  }

  private async getSftp(): Promise<SFTPWrapper> {
    if (this.sftpClient) return this.sftpClient;

    return new Promise<SFTPWrapper>((resolve, reject) => {
      this.sshClient!.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`Error iniciando SFTP: ${err.message}`));
        } else {
          this.sftpClient = sftp;
          resolve(sftp);
        }
      });
    });
  }

  private execCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.sshClient!.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = "";
        let stderr = "";

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on("close", (code: number) => {
          if (code !== 0 && stderr) {
            reject(new Error(`Exit code ${code}: ${stderr}`));
          } else {
            resolve(stdout + (stderr ? `\n[stderr]: ${stderr}` : ""));
          }
        });
      });
    });
  }

  private audit(tool: string, params: string, result: "ok" | "error"): void {
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      profile: this.currentProfile || "none",
      tool,
      params,
      result,
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("SSH MCP Server iniciado");
  }
}

// --- Utility functions ---

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function padRight(str: string, len: number): string {
  return str + " ".repeat(Math.max(0, len - str.length));
}

function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

const server = new SSHMCPServer();
server.run().catch(console.error);
