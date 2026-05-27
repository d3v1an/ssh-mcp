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

- **`src/index.ts`** — Main server class. Handles MCP tool dispatch, SSH/SFTP connection lifecycle, command execution, interactive exec (PTY + auto-response), persistent shell sessions, and file operations. All tool handlers are methods on `SSHMCPServer`. Version is read dynamically from `package.json`.
- **`src/tools.ts`** — MCP tool definitions (name, description, JSON Schema). 17 tools: `ssh_list_profiles`, `ssh_connect`, `ssh_disconnect`, `ssh_status`, `ssh_exec`, `ssh_exec_interactive`, `ssh_shell_start`, `ssh_shell_send` (includes `sensitive` flag), `ssh_shell_read`, `ssh_shell_close`, `ssh_upload`, `ssh_download`, `ssh_ls`, `ssh_read_file`, `ssh_write_file`, `ssh_history`, `ssh_undo`.
- **`src/profiles.ts`** — Loads and validates SSH profiles from `profiles.json` at startup (not on first use). Validates required fields (`host`, `port`, `username`, `privateKeyPath`, `hostFingerprint`), verifies the key file is readable, and caches private keys in memory. Never exposes private keys or passphrases in responses.
- **`src/security.ts`** — Dangerous command detection (regex patterns) and `AuditLogger`. Uses `WriteStream` for non-blocking writes with `0o600` permissions (enforced via `chmodSync` on existing files). Common secret patterns (password=, token=, Bearer) are redacted before writing.
- **`src/types.ts`** — TypeScript interfaces: `SSHProfile` (includes `hostFingerprint`, `localSandboxDir`), `AuditEntry`, `PromptResponse`, `ShellSession`, `CommandRecord`, `ReverseInfo`.
- **`src/utils.ts`** — Pure utility functions: `formatUptime`, `padRight`, `escapeShellArg`, `stripAnsi`.
- **`src/validation.ts`** — Input validation helpers: `requireString`, `optionalString`, `optionalBoolean`, `optionalNumber`, `clampTimeout` (bounds: 1s–5min).

### Key Patterns

- **Single active connection**: Only one SSH profile connected at a time.
- **Host verification**: Every connection verifies the remote host fingerprint (`hostHash: 'sha256'` + `hostVerifier`). Connection fails if `hostFingerprint` doesn't match or is missing.
- **Lazy SFTP**: SFTP client initialized on-demand. Automatically invalidated on SFTP `close`/`error` events.
- **Connection cleanup**: SSH client listens for `close`/`end` events to clean up state on unexpected disconnects (`cleanupState()`).
- **keepalive**: Connections use `keepaliveInterval: 30s`, `keepaliveCountMax: 3`, `readyTimeout: 20s`.
- **Interactive exec**: `ssh_exec_interactive` uses `exec()` with PTY. User-provided regex patterns are validated against ReDoS with `safe-regex2` before compiling.
- **Persistent shell sessions**: `ssh_shell_start/send/read/close` use `shell()` with PTY. Max 5 sessions, 1MB buffer, 5-min idle timeout. `sensitive: true` parameter redacts input from audit log.
- **Dangerous command detection**: Commands matching security patterns require `confirm: true`. This is an advisory layer only — not a security barrier. Bypassed by `raw: true` in `ssh_shell_send` (intentional).
- **Audit logging**: All operations logged to `audit.log` via `WriteStream` (0o600 permissions, truly non-blocking). Existing files get `chmodSync` to enforce permissions. Common secret patterns redacted. Requires external rotation (logrotate) for production.
- **Key-based auth only**: `privateKeyPath` required per profile. Passphrases via `SSH_PASSPHRASE_<PROFILE>` env vars. Password auth removed.
- **Local sandbox**: `ssh_download`, `ssh_upload`, and `ssh_undo` (local delete) validate that the local path is within `localSandboxDir` from the active profile.
- **Operation history & undo**: In-memory, max 100 entries. `previousContent` capped at 512KB (checked via `sftp.stat()` before reading — avoids loading large files). `ssh_download` preserves pre-existing local files via `local_file_restore` undo type. History cleared on connect/disconnect, not persisted across restarts. Undo writes as UTF-8 — binary files (detected via null byte check) are excluded from undo backup entirely; both local and remote undo are UTF-8 only.
- **execCommand timeout**: All internal `ssh exec` calls race against `EXEC_TIMEOUT` (30s). Timer cleared and SSH channel destroyed on timeout via `.finally()`. Both `stdout` and `stderr` capped at 1MB per-chunk (truncated periodically during accumulation, not just on close). Non-zero exit codes without stderr resolve with `[exit code: N]` annotation instead of rejecting. Use `cat -- path` and `rm -f -- path` to protect against filenames starting with `-`.
- **Partial file reading**: `ssh_read_file` supports `offset` (start line, 1-based) and `limit` (line count) for reading file sections without loading the full content.

## Configuration

- `profiles.json` — SSH profiles. Must include `host`, `port`, `username`, `privateKeyPath`, `hostFingerprint`. Optional: `localSandboxDir`. **Not versioned** (in `.gitignore`). Copy from `profiles.json.example`.
- `.env` — Optional passphrases: `SSH_PASSPHRASE_<PROFILE>=...`. Omit if key has no passphrase.
- `profiles.json.example` — Template with placeholder values. Included in npm package.
- MCP integration via Claude Desktop config pointing to `dist/index.js` or via `npx s01-ssh-mcp`.

## Security Notes

- `hostFingerprint` is **required**. Get it with: `ssh-keyscan -t ed25519 HOST 2>/dev/null | ssh-keygen -lf -`
- Changes to `profiles.json` require **MCP server restart** (profiles are cached at startup).
- The dangerous command detection regex patterns in `security.ts` are an **advisory UX layer**, not a security control. They can be bypassed. Real security comes from the remote user's permissions.
- `safe-regex2` protects against ReDoS for user-provided regex patterns in `ssh_exec_interactive`.
