#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, ClientChannel, SFTPWrapper } from "ssh2";
import dotenv from "dotenv";
import { createRequire } from "module";
import { resolve, sep } from "path";
import * as fs from "fs";

import { tools } from "./tools.js";
import { getProfile, listProfiles } from "./profiles.js";
import { isDangerousCommand, AuditLogger } from "./security.js";
import { PromptResponse, ShellSession, CommandRecord, ReverseInfo } from "./types.js";
import { formatUptime, padRight, escapeShellArg, stripAnsi } from "./utils.js";
import {
  requireString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  clampTimeout,
} from "./validation.js";
import safeRegex from "safe-regex2";

dotenv.config();

const _require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = _require("../package.json") as { version: string };

class SSHMCPServer {
  private server: Server;
  private sshClient: Client | null = null;
  private sftpClient: SFTPWrapper | null = null;
  private currentProfile: string | null = null;
  private connectedAt: Date | null = null;
  private connectedProfileMeta: { host: string; port: number; username: string } | null = null;
  private localSandboxDir: string | null = null;
  private auditLogger: AuditLogger;
  private shellSessions: Map<string, ShellSession> = new Map();
  private sessionCounter = 0;
  private commandHistory: CommandRecord[] = [];
  private recordCounter = 0;

  private static readonly EXEC_TIMEOUT = 30_000;
  private static readonly SETTLE_TIMEOUT = 2_000;
  private static readonly SHELL_IDLE_TIMEOUT = 5 * 60_000;
  private static readonly MAX_SESSIONS = 5;
  private static readonly MAX_BUFFER = 1_024 * 1_024;
  private static readonly MAX_HISTORY = 100;
  private static readonly MAX_PREV_CONTENT = 512 * 1_024;

  constructor() {
    this.auditLogger = new AuditLogger();
    this.server = new Server(
      { name: "ssh-mcp-server", version: SERVER_VERSION },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers();
    process.on("beforeExit", () => this.auditLogger.close());
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
          case "ssh_history":
            return this.handleHistory(args);
          case "ssh_undo":
            return await this.handleUndo(args);
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

  private async handleConnect(args: unknown): Promise<CallToolResult> {
    if (this.sshClient) {
      throw new Error(
        `Ya hay una conexión activa al perfil "${this.currentProfile}". Desconecta primero con ssh_disconnect.`
      );
    }

    const profileName = requireString(args, "profile");
    const profile = getProfile(profileName);

    return new Promise<CallToolResult>((resolve, reject) => {
      const client = new Client();

      client.on("ready", () => {
        this.sshClient = client;
        this.currentProfile = profileName;
        this.connectedAt = new Date();
        this.connectedProfileMeta = {
          host: profile.host,
          port: profile.port,
          username: profile.username,
        };
        this.localSandboxDir = profile.localSandboxDir;
        this.commandHistory = [];
        this.recordCounter = 0;

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

      // Clean up state if connection drops unexpectedly after being established
      client.on("close", () => {
        if (this.sshClient === client) {
          this.auditDirect("connection_dropped", this.currentProfile ?? "unknown", "error");
          this.cleanupState();
        }
      });

      client.on("end", () => {
        if (this.sshClient === client) {
          this.cleanupState();
        }
      });

      client.connect({
        host: profile.host,
        port: profile.port,
        username: profile.username,
        privateKey: profile.privateKey,
        passphrase: profile.passphrase,
        hostHash: "sha256",
        // fingerprint is a hex string; profile stores "SHA256:<base64>" from ssh-keygen -l
        hostVerifier: (fingerprint: string): boolean => {
          const base64Part = profile.hostFingerprint.startsWith("SHA256:")
            ? profile.hostFingerprint.slice(7)
            : profile.hostFingerprint;
          const computed = Buffer.from(fingerprint, "hex").toString("base64").replace(/=+$/, "");
          return computed === base64Part.replace(/=+$/, "");
        },
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3,
        readyTimeout: 20_000,
      });
    });
  }

  private async handleDisconnect(): Promise<CallToolResult> {
    if (!this.sshClient) {
      throw new Error("No hay conexión activa.");
    }

    const profileName = this.currentProfile;
    const client = this.sshClient;

    // Audit shell session closures before state cleanup
    for (const [id] of this.shellSessions) {
      this.audit("ssh_shell_close", `sessionId=${id} (disconnect cleanup)`, "ok");
    }
    this.audit("ssh_disconnect", `profile=${profileName}`, "ok");

    this.cleanupState();
    client.end();

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
    const meta = this.connectedProfileMeta!;

    return {
      content: [
        {
          type: "text",
          text: [
            `Perfil: ${this.currentProfile}`,
            `Host: ${meta.host}:${meta.port}`,
            `Usuario: ${meta.username}`,
            `Conectado hace: ${formatUptime(uptime)}`,
          ].join("\n"),
        },
      ],
    };
  }

  private async handleExec(args: unknown): Promise<CallToolResult> {
    this.requireConnection();
    const command = requireString(args, "command");
    const confirm = optionalBoolean(args, "confirm");

    const check = isDangerousCommand(command);
    if (check.dangerous && !confirm) {
      return this.dangerWarning(command, check.reason);
    }

    try {
      const output = await this.execCommand(command);
      this.audit("ssh_exec", command, "ok");
      this.recordOperation("ssh_exec", { command }, output, false);
      return {
        content: [{ type: "text", text: output || "(sin salida)" }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.audit("ssh_exec", command, "error");
      throw new Error(`Error ejecutando comando: ${msg}`);
    }
  }

  private async handleUpload(args: unknown): Promise<CallToolResult> {
    this.requireConnection();
    const localPath = requireString(args, "localPath");
    const remotePath = requireString(args, "remotePath");

    this.validateLocalPath(localPath);
    if (!fs.existsSync(localPath)) {
      throw new Error(`Archivo local "${localPath}" no encontrado`);
    }

    // Check remote file size before reading for undo backup
    const remoteSize = await this.getRemoteFileSize(remotePath);
    let previousContent: string | undefined;
    const previousExisted = remoteSize !== null;

    if (previousExisted && remoteSize! <= SSHMCPServer.MAX_PREV_CONTENT) {
      try {
        previousContent = await this.execCommand(`cat -- ${escapeShellArg(remotePath)}`);
      } catch { /* content unavailable — undo won't restore */ }
    }

    const sftp = await this.getSftp();

    return new Promise<CallToolResult>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => {
        if (err) {
          this.audit("ssh_upload", `${localPath} -> ${remotePath}`, "error");
          reject(new Error(`Error subiendo archivo: ${err.message}`));
        } else {
          this.audit("ssh_upload", `${localPath} -> ${remotePath}`, "ok");

          const reverseInfo: ReverseInfo = previousExisted
            ? {
                type: "file_restore",
                description: `Restaurar contenido previo de ${remotePath}`,
                remotePath,
                previousContent: this.capPrevContent(previousContent),
              }
            : {
                type: "file_delete",
                description: `Eliminar ${remotePath} (no existía antes)`,
                remotePath,
              };

          this.recordOperation(
            "ssh_upload",
            { localPath, remotePath },
            `Archivo subido: ${localPath} -> ${remotePath}`,
            previousExisted ? reverseInfo.previousContent !== undefined : true,
            reverseInfo
          );

          resolve({
            content: [
              { type: "text", text: `Archivo subido: ${localPath} -> ${remotePath}` },
            ],
          });
        }
      });
    });
  }

  private async handleDownload(args: unknown): Promise<CallToolResult> {
    this.requireConnection();
    const remotePath = requireString(args, "remotePath");
    const localPath = requireString(args, "localPath");

    this.validateLocalPath(localPath);

    let localPreviousContent: string | undefined;
    let localFileExisted = false;
    try {
      const stat = fs.statSync(localPath);
      localFileExisted = true;
      if (stat.size <= SSHMCPServer.MAX_PREV_CONTENT) {
        localPreviousContent = fs.readFileSync(localPath, "utf-8");
      }
    } catch { /* file doesn't exist */ }

    const sftp = await this.getSftp();

    return new Promise<CallToolResult>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => {
        if (err) {
          this.audit("ssh_download", `${remotePath} -> ${localPath}`, "error");
          reject(new Error(`Error descargando archivo: ${err.message}`));
        } else {
          this.audit("ssh_download", `${remotePath} -> ${localPath}`, "ok");

          const reverseInfo: ReverseInfo = localFileExisted
            ? {
                type: "local_file_restore",
                description: `Restaurar contenido previo de ${localPath}`,
                localPath,
                previousContent: localPreviousContent,
              }
            : {
                type: "local_file_delete",
                description: `Eliminar archivo local descargado: ${localPath}`,
                localPath,
              };

          this.recordOperation(
            "ssh_download",
            { remotePath, localPath },
            `Archivo descargado: ${remotePath} -> ${localPath}`,
            localFileExisted ? localPreviousContent !== undefined : true,
            reverseInfo
          );

          resolve({
            content: [
              { type: "text", text: `Archivo descargado: ${remotePath} -> ${localPath}` },
            ],
          });
        }
      });
    });
  }

  private async handleLs(args: unknown): Promise<CallToolResult> {
    this.requireConnection();
    const path = optionalString(args, "path") || ".";

    const sftp = await this.getSftp();

    return new Promise<CallToolResult>((resolve, reject) => {
      sftp.readdir(path, (err, list) => {
        if (err) {
          this.audit("ssh_ls", path, "error");
          reject(new Error(`Error listando directorio "${path}": ${err.message}`));
          return;
        }

        const entries = list.map((entry) => {
          const type = entry.attrs.isDirectory() ? "d" : entry.attrs.isSymbolicLink() ? "l" : "-";
          const size = entry.attrs.size ?? 0;
          return `${type} ${entry.attrs.uid ?? "-"}:${entry.attrs.gid ?? "-"} ${padRight(String(size), 10)} ${entry.filename}`;
        });

        this.audit("ssh_ls", path, "ok");
        resolve({
          content: [{ type: "text", text: entries.join("\n") || "(directorio vacío)" }],
        });
      });
    });
  }

  private async handleReadFile(args: unknown): Promise<CallToolResult> {
    this.requireConnection();
    const remotePath = requireString(args, "path");
    const offset = optionalNumber(args, "offset");
    const limit = optionalNumber(args, "limit");

    if (offset !== undefined && (offset < 1 || !Number.isInteger(offset))) {
      throw new Error("offset debe ser un entero positivo (línea inicial, base 1)");
    }
    if (limit !== undefined && (limit < 1 || !Number.isInteger(limit))) {
      throw new Error("limit debe ser un entero positivo (número de líneas)");
    }

    let cmd: string;
    if (offset !== undefined || limit !== undefined) {
      const start = offset ?? 1;
      if (limit !== undefined) {
        const end = start + limit - 1;
        cmd = `sed -n '${start},${end}p' -- ${escapeShellArg(remotePath)}`;
      } else {
        cmd = `sed -n '${start},$p' -- ${escapeShellArg(remotePath)}`;
      }
    } else {
      cmd = `cat -- ${escapeShellArg(remotePath)}`;
    }

    try {
      const content = await this.execCommand(cmd);
      this.audit("ssh_read_file", remotePath, "ok");
      this.recordOperation("ssh_read_file", { path: remotePath, offset, limit }, `(${content.length} bytes leídos)`, false);
      return {
        content: [{ type: "text", text: content }],
      };
    } catch (error) {
      this.audit("ssh_read_file", remotePath, "error");
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Error leyendo archivo "${remotePath}": ${msg}`);
    }
  }

  private async handleWriteFile(args: unknown): Promise<CallToolResult> {
    this.requireConnection();
    const remotePath = requireString(args, "path");
    const content = requireString(args, "content");

    // Check remote file size before reading for undo backup
    const remoteSize = await this.getRemoteFileSize(remotePath);
    let previousContent: string | undefined;
    const previousExisted = remoteSize !== null;

    if (previousExisted && remoteSize! <= SSHMCPServer.MAX_PREV_CONTENT) {
      try {
        previousContent = await this.execCommand(`cat -- ${escapeShellArg(remotePath)}`);
      } catch { /* content unavailable — undo won't restore */ }
    }

    const sftp = await this.getSftp();

    return new Promise<CallToolResult>((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath);

      stream.on("close", () => {
        this.audit("ssh_write_file", remotePath, "ok");

        const capped = this.capPrevContent(previousContent);
        const reverseInfo: ReverseInfo = previousExisted
          ? {
              type: "file_restore",
              description: `Restaurar contenido previo de ${remotePath}`,
              remotePath,
              previousContent: capped,
            }
          : {
              type: "file_delete",
              description: `Eliminar ${remotePath} (no existía antes)`,
              remotePath,
            };

        this.recordOperation(
          "ssh_write_file",
          { path: remotePath, content: `(${content.length} bytes)` },
          `Archivo escrito: ${remotePath} (${content.length} bytes)`,
          previousExisted ? capped !== undefined : true,
          reverseInfo
        );

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

  private async handleExecInteractive(args: unknown): Promise<CallToolResult> {
    this.requireConnection();
    const command = requireString(args, "command");
    const responses = this.parseResponses((args as Record<string, unknown>)?.responses);
    const timeout = clampTimeout(optionalNumber(args, "timeout"), SSHMCPServer.EXEC_TIMEOUT);
    const confirm = optionalBoolean(args, "confirm");

    const check = isDangerousCommand(command);
    if (check.dangerous && !confirm) {
      return this.dangerWarning(command, check.reason);
    }

    // Validate regex patterns for ReDoS safety before compiling
    const compiledResponses = responses.map((r) => {
      const re = new RegExp(r.prompt);
      if (!safeRegex(re)) {
        throw new Error(
          `Patrón de prompt inseguro (puede causar ReDoS): "${r.prompt}". ` +
            `Usa patrones simples sin cuantificadores anidados.`
        );
      }
      return { regex: re, answer: r.answer, sensitive: r.sensitive || false };
    });

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
          const cleanOutput = stripAnsi(output) || "(sin salida)";
          this.recordOperation("ssh_exec_interactive", { command, responses: responses.length }, cleanOutput, false);
          resolve({
            content: [{ type: "text", text: cleanOutput }],
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
          if (output.length + chunk.length > SSHMCPServer.MAX_BUFFER) {
            output = (output + chunk).slice(-SSHMCPServer.MAX_BUFFER);
          } else {
            output += chunk;
          }

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

  private async handleShellStart(args: unknown): Promise<CallToolResult> {
    this.requireConnection();

    if (this.shellSessions.size >= SSHMCPServer.MAX_SESSIONS) {
      throw new Error(
        `Máximo de ${SSHMCPServer.MAX_SESSIONS} sesiones concurrentes alcanzado. Cierra una sesión existente primero.`
      );
    }

    const rawCols = optionalNumber(args, "cols");
    const cols = (rawCols === undefined || rawCols <= 0) ? 80 : rawCols;
    const rawRows = optionalNumber(args, "rows");
    const rows = (rawRows === undefined || rawRows <= 0) ? 24 : rawRows;

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
          lastActivity: new Date(),
          idleTimer: this.createIdleTimer(sessionId),
        };

        stream.on("data", (data: Buffer) => {
          const chunk = data.toString();
          if (session.buffer.length + chunk.length > SSHMCPServer.MAX_BUFFER) {
            session.buffer = (session.buffer + chunk).slice(-SSHMCPServer.MAX_BUFFER);
          } else {
            session.buffer += chunk;
          }
          session.lastActivity = new Date();
        });

        let settleTimer: ReturnType<typeof setTimeout>;

        stream.on("close", () => {
          clearTimeout(settleTimer);
          if (this.shellSessions.has(sessionId)) {
            this.destroyShellSession(sessionId, session);
            this.audit("ssh_shell_close", `sessionId=${sessionId} (channel closed)`, "ok");
          }
          reject(new Error("Shell cerrada antes de completar inicialización"));
        });

        this.shellSessions.set(sessionId, session);
        this.audit("ssh_shell_start", `sessionId=${sessionId}`, "ok");

        settleTimer = setTimeout(() => {
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

  private async handleShellSend(args: unknown): Promise<CallToolResult> {
    this.requireConnection();
    const sessionId = requireString(args, "sessionId");
    const input = requireString(args, "input");
    const raw = optionalBoolean(args, "raw") ?? false;
    const timeout = clampTimeout(optionalNumber(args, "timeout"), SSHMCPServer.SETTLE_TIMEOUT);
    const confirm = optionalBoolean(args, "confirm");
    const sensitive = optionalBoolean(args, "sensitive") ?? false;

    const session = this.shellSessions.get(sessionId);
    if (!session) {
      throw new Error(`Sesión "${sessionId}" no encontrada. Usa ssh_shell_start para crear una.`);
    }

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

    session.buffer = "";

    const data = raw ? input : input + "\n";
    session.channel.write(data);

    this.resetIdleTimer(sessionId, session);
    const auditInput = sensitive ? "[REDACTED]" : raw ? "(raw)" : input;
    this.audit("ssh_shell_send", `sessionId=${sessionId} input=${auditInput}`, "ok");

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

  private async handleShellRead(args: unknown): Promise<CallToolResult> {
    this.requireConnection();
    const sessionId = requireString(args, "sessionId");
    const timeout = clampTimeout(optionalNumber(args, "timeout"), SSHMCPServer.SETTLE_TIMEOUT);

    const session = this.shellSessions.get(sessionId);
    if (!session) {
      throw new Error(`Sesión "${sessionId}" no encontrada.`);
    }

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

  private async handleShellClose(args: unknown): Promise<CallToolResult> {
    this.requireConnection();
    const sessionId = requireString(args, "sessionId");

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

  // --- History & Undo handlers ---

  private recordOperation(
    tool: string,
    params: Record<string, unknown>,
    output: string,
    reversible: boolean,
    reverseInfo?: ReverseInfo
  ): void {
    // Evict oldest entry when cap is reached
    if (this.commandHistory.length >= SSHMCPServer.MAX_HISTORY) {
      this.commandHistory.shift();
    }

    this.commandHistory.push({
      id: ++this.recordCounter,
      timestamp: new Date().toISOString(),
      tool,
      params,
      output,
      reversible,
      reversed: false,
      reverseInfo,
    });
  }

  private handleHistory(args: unknown): CallToolResult {
    this.requireConnection();
    const filter = optionalString(args, "filter") || "all";
    if (!["all", "reversible", "reversed"].includes(filter)) {
      throw new Error(`Filtro inválido "${filter}". Valores válidos: all, reversible, reversed`);
    }
    const rawLimit = optionalNumber(args, "limit");
    const limit = (rawLimit === undefined || rawLimit <= 0) ? 20 : Math.floor(rawLimit);

    let records: CommandRecord[];

    if (filter === "reversible") {
      records = this.commandHistory.filter((r) => r.reversible && !r.reversed);
    } else if (filter === "reversed") {
      records = this.commandHistory.filter((r) => r.reversed);
    } else {
      records = this.commandHistory;
    }

    records = records.slice(-limit);

    if (records.length === 0) {
      return {
        content: [{ type: "text", text: "No hay operaciones en el historial con el filtro aplicado." }],
      };
    }

    const lines = records.map((r) => {
      const status = r.reversed ? " [REVERTIDA]" : r.reversible ? " [reversible]" : "";
      const params = Object.entries(r.params)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return `#${r.id} [${r.timestamp}] ${r.tool}(${params})${status}`;
    });

    return {
      content: [
        {
          type: "text",
          text: [
            `Historial de operaciones (${records.length}/${this.commandHistory.length} total):`,
            "",
            ...lines,
          ].join("\n"),
        },
      ],
    };
  }

  private async handleUndo(args: unknown): Promise<CallToolResult> {
    this.requireConnection();
    const recordId = optionalNumber(args, "recordId");
    if (recordId === undefined) throw new Error(`Parámetro requerido "recordId" debe ser un número`);
    const confirm = optionalBoolean(args, "confirm");

    const record = this.commandHistory.find((r) => r.id === recordId);
    if (!record) {
      throw new Error(`Registro #${recordId} no encontrado en el historial.`);
    }
    if (!record.reversible) {
      throw new Error(`Registro #${recordId} (${record.tool}) no es reversible.`);
    }
    if (record.reversed) {
      throw new Error(`Registro #${recordId} ya fue revertido.`);
    }
    if (!record.reverseInfo) {
      throw new Error(`Registro #${recordId} no tiene información de reversión.`);
    }

    if (!confirm) {
      return {
        content: [
          {
            type: "text",
            text: [
              `Operación a revertir:`,
              `  #${record.id} ${record.tool} — ${record.reverseInfo.description}`,
              ``,
              `Para confirmar, reenvía con confirm: true.`,
            ].join("\n"),
          },
        ],
      };
    }

    const info = record.reverseInfo;

    switch (info.type) {
      case "file_restore": {
        if (info.previousContent === undefined) {
          throw new Error(
            `Registro #${recordId}: el contenido previo no fue almacenado (archivo demasiado grande). Undo no disponible.`
          );
        }
        const sftp = await this.getSftp();
        await new Promise<void>((resolve, reject) => {
          const stream = sftp.createWriteStream(info.remotePath!);
          stream.on("close", () => resolve());
          stream.on("error", (err: Error) => reject(err));
          stream.end(info.previousContent!, "utf-8");
        });
        record.reversed = true;
        this.audit("ssh_undo", `record=${recordId} file_restore ${info.remotePath}`, "ok");
        return {
          content: [
            {
              type: "text",
              text: `Revertido #${recordId}: contenido previo restaurado en ${info.remotePath}`,
            },
          ],
        };
      }

      case "file_delete": {
        await this.execCommand(`rm -f -- ${escapeShellArg(info.remotePath!)}`);
        record.reversed = true;
        this.audit("ssh_undo", `record=${recordId} file_delete ${info.remotePath}`, "ok");
        return {
          content: [
            {
              type: "text",
              text: `Revertido #${recordId}: archivo ${info.remotePath} eliminado (no existía antes)`,
            },
          ],
        };
      }

      case "local_file_delete": {
        this.validateLocalPath(info.localPath!);
        if (fs.existsSync(info.localPath!)) {
          fs.unlinkSync(info.localPath!);
        }
        record.reversed = true;
        this.audit("ssh_undo", `record=${recordId} local_file_delete ${info.localPath}`, "ok");
        return {
          content: [
            {
              type: "text",
              text: `Revertido #${recordId}: archivo local ${info.localPath} eliminado`,
            },
          ],
        };
      }

      case "local_file_restore": {
        this.validateLocalPath(info.localPath!);
        if (info.previousContent === undefined) {
          throw new Error(
            `Registro #${recordId}: el contenido previo no fue almacenado (archivo demasiado grande). Undo no disponible.`
          );
        }
        fs.writeFileSync(info.localPath!, info.previousContent, "utf-8");
        record.reversed = true;
        this.audit("ssh_undo", `record=${recordId} local_file_restore ${info.localPath}`, "ok");
        return {
          content: [
            {
              type: "text",
              text: `Revertido #${recordId}: contenido previo restaurado en ${info.localPath}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Tipo de reversión desconocido: ${(info as ReverseInfo).type}`);
    }
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

  // --- Connection state ---

  private cleanupState(): void {
    for (const [id, session] of this.shellSessions) {
      clearTimeout(session.idleTimer);
      session.channel.destroy();
      this.shellSessions.delete(id);
    }
    this.sftpClient = null;
    this.sshClient = null;
    this.currentProfile = null;
    this.connectedAt = null;
    this.connectedProfileMeta = null;
    this.localSandboxDir = null;
    this.commandHistory = [];
    this.recordCounter = 0;
  }

  // --- Helpers ---

  private requireConnection(): void {
    if (!this.sshClient) {
      throw new Error("No hay conexión activa. Usa ssh_connect primero.");
    }
  }

  private validateLocalPath(localPath: string): void {
    const sandbox = this.localSandboxDir ?? resolve(process.cwd());
    const target = resolve(localPath);
    if (target !== sandbox && !target.startsWith(sandbox + sep)) {
      throw new Error(
        `Ruta local "${localPath}" fuera del directorio permitido "${sandbox}". ` +
          `Configura "localSandboxDir" en el perfil de profiles.json para ampliar el acceso.`
      );
    }
  }

  private capPrevContent(content: string | undefined): string | undefined {
    if (content === undefined) return undefined;
    if (content.length > SSHMCPServer.MAX_PREV_CONTENT) return undefined;
    if (content.includes("\0")) return undefined;
    return content;
  }

  private parseResponses(raw: unknown): PromptResponse[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      throw new Error("responses debe ser un array");
    }
    const valid = raw.filter(
      (r): r is PromptResponse =>
        typeof r === "object" && r !== null &&
        typeof (r as PromptResponse).prompt === "string" &&
        typeof (r as PromptResponse).answer === "string"
    );
    if (valid.length < raw.length) {
      throw new Error(
        `${raw.length - valid.length} entrada(s) en responses son inválidas (requieren campos prompt y answer)`
      );
    }
    return valid;
  }

  private async getRemoteFileSize(remotePath: string): Promise<number | null> {
    try {
      const sftp = await this.getSftp();
      return await new Promise<number>((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) => {
          if (err) reject(err);
          else resolve(stats.size);
        });
      });
    } catch {
      return null;
    }
  }

  private dangerWarning(command: string, reason: string): CallToolResult {
    return {
      content: [
        {
          type: "text",
          text: [
            `ADVERTENCIA: Comando potencialmente destructivo detectado.`,
            `Comando: ${command}`,
            `Razón: ${reason}`,
            ``,
            `Para ejecutar este comando, reenvía con confirm: true.`,
          ].join("\n"),
        },
      ],
    };
  }

  private async getSftp(): Promise<SFTPWrapper> {
    if (this.sftpClient) return this.sftpClient;

    return new Promise<SFTPWrapper>((resolve, reject) => {
      this.sshClient!.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`Error iniciando SFTP: ${err.message}`));
        } else {
          // Invalidate cached client if the SFTP subsystem closes or errors
          const invalidate = () => { this.sftpClient = null; };
          sftp.on("close", invalidate);
          sftp.on("error", invalidate);
          this.sftpClient = sftp;
          resolve(sftp);
        }
      });
    });
  }

  private execCommand(command: string, timeoutMs = SSHMCPServer.EXEC_TIMEOUT): Promise<string> {
    let timerId: ReturnType<typeof setTimeout>;
    let execStream: ClientChannel | undefined;
    let timedOut = false;

    const exec = new Promise<string>((resolve, reject) => {
      this.sshClient!.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        execStream = stream;

        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        let stdoutLen = 0;
        let stderrLen = 0;

        stream.on("data", (data: Buffer) => {
          const s = data.toString();
          stdoutChunks.push(s);
          stdoutLen += s.length;
          if (stdoutLen > SSHMCPServer.MAX_BUFFER) {
            const joined = stdoutChunks.join("");
            stdoutChunks.length = 0;
            stdoutChunks.push(joined.slice(-SSHMCPServer.MAX_BUFFER));
            stdoutLen = stdoutChunks[0].length;
          }
        });

        stream.stderr.on("data", (data: Buffer) => {
          const s = data.toString();
          stderrChunks.push(s);
          stderrLen += s.length;
          if (stderrLen > SSHMCPServer.MAX_BUFFER) {
            const joined = stderrChunks.join("");
            stderrChunks.length = 0;
            stderrChunks.push(joined.slice(-SSHMCPServer.MAX_BUFFER));
            stderrLen = stderrChunks[0].length;
          }
        });

        stream.on("close", (code: number) => {
          let stdout = stdoutChunks.join("");
          if (stdout.length > SSHMCPServer.MAX_BUFFER) {
            stdout = stdout.slice(-SSHMCPServer.MAX_BUFFER);
          }
          let stderr = stderrChunks.join("");
          if (stderr.length > SSHMCPServer.MAX_BUFFER) {
            stderr = stderr.slice(-SSHMCPServer.MAX_BUFFER);
          }

          if (code !== 0 && stderr) {
            reject(new Error(`Exit code ${code}: ${stderr}`));
          } else if (code !== 0) {
            resolve(stdout + `\n[exit code: ${code}]`);
          } else {
            resolve(stdout + (stderr ? `\n[stderr]: ${stderr}` : ""));
          }
        });
      });
    });

    const timer = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Timeout ejecutando comando (${timeoutMs}ms)`));
      }, timeoutMs);
    });

    return Promise.race([exec, timer]).finally(() => {
      clearTimeout(timerId!);
      if (timedOut) execStream?.destroy();
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

  private auditDirect(tool: string, profile: string, result: "ok" | "error"): void {
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      profile,
      tool,
      params: `profile=${profile}`,
      result,
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("SSH MCP Server iniciado");
  }
}

const server = new SSHMCPServer();
server.run().catch(console.error);
