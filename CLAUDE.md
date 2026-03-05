# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP (Model Context Protocol) server for SSH remote server administration. Enables AI models to manage remote servers over SSH — executing commands, transferring files via SFTP, and reading/writing remote files. Documentation is in Spanish.

## Commands

```bash
npm run build      # Compile TypeScript → dist/
npm start          # Run MCP server (dist/index.js)
```

No test or lint commands are configured yet.

## Architecture

Single-class MCP server (`SSHMCPServer` in `src/index.ts`) that manages one SSH connection at a time via the `ssh2` library.

### Source Files

- **`src/index.ts`** — Main server class. Handles MCP tool dispatch, SSH/SFTP connection lifecycle, command execution, interactive exec (PTY + auto-response), persistent shell sessions, and file operations. All tool handlers are methods on `SSHMCPServer`.
- **`src/tools.ts`** — MCP tool definitions (name, description, JSON Schema). 17 tools: `ssh_list_profiles`, `ssh_connect`, `ssh_disconnect`, `ssh_status`, `ssh_exec`, `ssh_exec_interactive`, `ssh_shell_start`, `ssh_shell_send`, `ssh_shell_read`, `ssh_shell_close`, `ssh_upload`, `ssh_download`, `ssh_ls`, `ssh_read_file`, `ssh_write_file`, `ssh_history`, `ssh_undo`.
- **`src/profiles.ts`** — Loads SSH profiles from `profiles.json` (or `SSH_PROFILES_PATH` env var). Injects passwords from env vars named `SSH_PASSWORD_<PROFILE_NAME_UPPERCASE>`. Never exposes passwords in responses.
- **`src/security.ts`** — Dangerous command detection (regex patterns for `rm -rf /`, `mkfs`, `dd`, `reboot`, `shutdown`, fork bombs, etc.) and audit logging to `audit.log`.
- **`src/types.ts`** — TypeScript interfaces: `SSHProfile`, `AuditEntry`, `PromptResponse`, `ShellSession`, `CommandRecord`, `ReverseInfo`.

### Key Patterns

- **Single active connection**: Only one SSH profile connected at a time; connecting to a new one disconnects the current.
- **Lazy SFTP**: SFTP client initialized on-demand for file operations.
- **Interactive exec**: `ssh_exec_interactive` uses `exec()` with PTY for commands needing interactive input (sudo, confirmations). Auto-responds to prompts via regex matching.
- **Persistent shell sessions**: `ssh_shell_start/send/read/close` use `shell()` with PTY for REPLs and multi-step workflows. Max 5 sessions, 1MB buffer, 5-min idle timeout, auto-cleanup on disconnect.
- **Dangerous command confirmation**: Commands matching security patterns require `confirm: true` parameter. Applies to `ssh_exec`, `ssh_exec_interactive`, and `ssh_shell_send` (when `raw: false`).
- **Audit logging**: All operations logged to `audit.log` (non-blocking, failures silently ignored). Sensitive responses logged as `[REDACTED]`.
- **Environment-based passwords**: Passwords injected via `SSH_PASSWORD_<PROFILE>` env vars, never stored in `profiles.json`.
- **Operation history & undo**: All operations recorded in memory during active connection via `commandHistory`. File operations (`ssh_write_file`, `ssh_upload`) capture previous content before modifying, enabling restore via `ssh_undo`. `ssh_download` records local path for cleanup. History cleared on connect/disconnect.

## Configuration

- `profiles.json` — SSH profiles (host, port, username per profile)
- `.env` — Passwords as `SSH_PASSWORD_PRODUCCION=...`, `SSH_PASSWORD_STAGING=...`
- MCP integration via Claude Desktop config pointing to `dist/index.js`
