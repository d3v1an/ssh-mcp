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
import { PromptResponse, ShellSession } from "./types.js";

dotenv.config();

class SSHMCPServer {
  private server: Server;
  private sshClient: Client | null = null;
  private sftpClient: SFTPWrapper | null = null;
  private currentProfile: string | null = null;
  private connectedAt: Date | null = null;
  private auditLogger: AuditLogger;
  private shellSessions: Map<string, ShellSession> = new Map();
  private sessionCounter = 0;

  private static readonly EXEC_TIMEOUT = 30_000;
  private static readonly SETTLE_TIMEOUT = 2_000;
  private static readonly SHELL_IDLE_TIMEOUT = 5 * 60_000;
  private static readonly MAX_SESSIONS = 5;
  private static readonly MAX_BUFFER = 1_024 * 1_024;

  constructor() {
    this.auditLogger = new AuditLogger();
    this.server = new Server(
      { name: "ssh-mcp-server", version: "0.1.0" },
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
          case "ssh_exec_interactive":
            return await this.handleExecInteractive(args);
          case "ssh_shell_start":
            return await this.handleShellStart(args);
          case "ssh_shell_send":
            return await this.handleShellSend(args);
          case "ssh_shell_read":
            return await this.handleShellRead(args);
          case "ssh_shell_close":
            return await this.handleShellClose(args);
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

    // Cerrar todas las sesiones de shell activas
    for (const [id, session] of this.shellSessions) {
      this.destroyShellSession(id, session);
      this.audit("ssh_shell_close", `sessionId=${id} (disconnect cleanup)`, "ok");
    }

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

  // --- Interactive & Shell handlers ---

  private async handleExecInteractive(args: any): Promise<CallToolResult> {
    this.requireConnection();
    const command = args.command as string;
    const responses = (args.responses || []) as PromptResponse[];
    const timeout = (args.timeout as number) || SSHMCPServer.EXEC_TIMEOUT;
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

    // Compilar regex de prompts
    const compiledResponses = responses.map((r) => ({
      regex: new RegExp(r.prompt),
      answer: r.answer,
      sensitive: r.sensitive || false,
    }));

    const auditResponses = responses
      .map((r) => (r.sensitive ? `${r.prompt}:[REDACTED]` : `${r.prompt}:${r.answer}`))
      .join(", ");

    return new Promise<CallToolResult>((resolve, reject) => {
      this.sshClient!.exec(command, { pty: true }, (err, stream) => {
        if (err) {
          this.audit("ssh_exec_interactive", `${command} responses=[${auditResponses}]`, "error");
          reject(new Error(`Error ejecutando comando interactivo: ${err.message}`));
          return;
        }

        let output = "";
        let settled = false;
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        let globalTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (settleTimer) clearTimeout(settleTimer);
          if (globalTimer) clearTimeout(globalTimer);
        };

        const finish = () => {
          if (settled) return;
          settled = true;
          cleanup();
          this.audit("ssh_exec_interactive", `${command} responses=[${auditResponses}]`, "ok");
          resolve({
            content: [{ type: "text", text: stripAnsi(output) || "(sin salida)" }],
          });
        };

        const resetSettle = () => {
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(finish, SSHMCPServer.SETTLE_TIMEOUT);
        };

        globalTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            if (settleTimer) clearTimeout(settleTimer);
            stream.destroy();
            this.audit("ssh_exec_interactive", `${command} (timeout)`, "ok");
            resolve({
              content: [
                {
                  type: "text",
                  text: stripAnsi(output) + "\n[timeout: comando excedió el tiempo límite]",
                },
              ],
            });
          }
        }, timeout);

        stream.on("data", (data: Buffer) => {
          const chunk = data.toString();
          output += chunk;

          // Truncar buffer si excede el máximo
          if (output.length > SSHMCPServer.MAX_BUFFER) {
            output = output.slice(-SSHMCPServer.MAX_BUFFER);
          }

          // Verificar si algún prompt match
          for (const resp of compiledResponses) {
            if (resp.regex.test(chunk)) {
              stream.write(resp.answer + "\n");
              break;
            }
          }

          resetSettle();
        });

        stream.on("close", finish);

        stream.on("error", (streamErr: Error) => {
          if (!settled) {
            settled = true;
            cleanup();
            this.audit("ssh_exec_interactive", `${command}`, "error");
            reject(new Error(`Error en stream interactivo: ${streamErr.message}`));
          }
        });
      });
    });
  }

  private async handleShellStart(args: any): Promise<CallToolResult> {
    this.requireConnection();

    if (this.shellSessions.size >= SSHMCPServer.MAX_SESSIONS) {
      throw new Error(
        `Máximo de ${SSHMCPServer.MAX_SESSIONS} sesiones concurrentes alcanzado. Cierra una sesión existente primero.`
      );
    }

    const cols = (args?.cols as number) || 80;
    const rows = (args?.rows as number) || 24;

    return new Promise<CallToolResult>((resolve, reject) => {
      this.sshClient!.shell({ cols, rows, term: "xterm" }, (err, stream) => {
        if (err) {
          this.audit("ssh_shell_start", "", "error");
          reject(new Error(`Error iniciando shell: ${err.message}`));
          return;
        }

        const sessionId = `shell-${++this.sessionCounter}`;
        const session: ShellSession = {
          id: sessionId,
          channel: stream,
          buffer: "",
          createdAt: new Date(),
          lastActivity: new Date(),
          idleTimer: this.createIdleTimer(sessionId),
        };

        stream.on("data", (data: Buffer) => {
          session.buffer += data.toString();
          // Truncar buffer si excede el máximo
          if (session.buffer.length > SSHMCPServer.MAX_BUFFER) {
            session.buffer = session.buffer.slice(-SSHMCPServer.MAX_BUFFER);
          }
          session.lastActivity = new Date();
        });

        stream.on("close", () => {
          if (this.shellSessions.has(sessionId)) {
            this.destroyShellSession(sessionId, session);
            this.audit("ssh_shell_close", `sessionId=${sessionId} (channel closed)`, "ok");
          }
        });

        this.shellSessions.set(sessionId, session);
        this.audit("ssh_shell_start", `sessionId=${sessionId}`, "ok");

        // Esperar el banner/prompt inicial
        setTimeout(() => {
          resolve({
            content: [
              {
                type: "text",
                text: [
                  `Sesión de shell iniciada: ${sessionId}`,
                  `Terminal: ${cols}x${rows}`,
                  `Auto-cierre por inactividad: 5 minutos`,
                  ``,
                  `Output inicial:`,
                  stripAnsi(session.buffer) || "(esperando output...)",
                ].join("\n"),
              },
            ],
          });
        }, SSHMCPServer.SETTLE_TIMEOUT);
      });
    });
  }

  private async handleShellSend(args: any): Promise<CallToolResult> {
    this.requireConnection();
    const sessionId = args.sessionId as string;
    const input = args.input as string;
    const raw = (args.raw as boolean) || false;
    const timeout = (args.timeout as number) || SSHMCPServer.SETTLE_TIMEOUT;
    const confirm = args.confirm as boolean | undefined;

    const session = this.shellSessions.get(sessionId);
    if (!session) {
      throw new Error(`Sesión "${sessionId}" no encontrada. Usa ssh_shell_start para crear una.`);
    }

    // Security check cuando no es raw
    if (!raw) {
      const check = isDangerousCommand(input);
      if (check.dangerous && !confirm) {
        return {
          content: [
            {
              type: "text",
              text: [
                `ADVERTENCIA: Comando potencialmente destructivo detectado.`,
                `Input: ${input}`,
                `Razón: ${check.reason}`,
                ``,
                `Para ejecutar, reenvía con confirm: true.`,
              ].join("\n"),
            },
          ],
        };
      }
    }

    // Limpiar buffer antes de enviar
    session.buffer = "";

    // Enviar input
    const data = raw ? input : input + "\n";
    session.channel.write(data);

    this.resetIdleTimer(sessionId, session);
    this.audit("ssh_shell_send", `sessionId=${sessionId} input=${raw ? "(raw)" : input}`, "ok");

    // Esperar output
    return new Promise<CallToolResult>((resolve) => {
      setTimeout(() => {
        resolve({
          content: [
            {
              type: "text",
              text: stripAnsi(session.buffer) || "(sin output)",
            },
          ],
        });
      }, timeout);
    });
  }

  private async handleShellRead(args: any): Promise<CallToolResult> {
    this.requireConnection();
    const sessionId = args.sessionId as string;
    const timeout = (args.timeout as number) || SSHMCPServer.SETTLE_TIMEOUT;

    const session = this.shellSessions.get(sessionId);
    if (!session) {
      throw new Error(`Sesión "${sessionId}" no encontrada.`);
    }

    // Esperar output adicional
    return new Promise<CallToolResult>((resolve) => {
      setTimeout(() => {
        const output = session.buffer;
        session.buffer = "";
        resolve({
          content: [
            {
              type: "text",
              text: stripAnsi(output) || "(sin output nuevo)",
            },
          ],
        });
      }, timeout);
    });
  }

  private async handleShellClose(args: any): Promise<CallToolResult> {
    this.requireConnection();
    const sessionId = args.sessionId as string;

    const session = this.shellSessions.get(sessionId);
    if (!session) {
      throw new Error(`Sesión "${sessionId}" no encontrada.`);
    }

    this.destroyShellSession(sessionId, session);
    this.audit("ssh_shell_close", `sessionId=${sessionId}`, "ok");

    return {
      content: [{ type: "text", text: `Sesión "${sessionId}" cerrada.` }],
    };
  }

  // --- Shell session lifecycle helpers ---

  private createIdleTimer(sessionId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const session = this.shellSessions.get(sessionId);
      if (session) {
        this.destroyShellSession(sessionId, session);
        this.audit("ssh_shell_close", `sessionId=${sessionId} (idle timeout)`, "ok");
      }
    }, SSHMCPServer.SHELL_IDLE_TIMEOUT);
  }

  private resetIdleTimer(sessionId: string, session: ShellSession): void {
    clearTimeout(session.idleTimer);
    session.idleTimer = this.createIdleTimer(sessionId);
    session.lastActivity = new Date();
  }

  private destroyShellSession(sessionId: string, session: ShellSession): void {
    clearTimeout(session.idleTimer);
    session.channel.destroy();
    this.shellSessions.delete(sessionId);
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

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

const server = new SSHMCPServer();
server.run().catch(console.error);
