# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-05-28

### Bug Fixes
- **execCommand**: Fixed periodic chunk truncation and improved exit code handling — non-zero exits without stderr now resolve with `[exit code: N]` annotation instead of rejecting
- **undo**: Excluded binary files (detected via null byte check) from undo backup to prevent corruption
- **upload**: Added file existence validation before remote I/O
- **shell**: Validated `cols` and `rows` parameters to prevent invalid values

### Documentation
- Clarified that `hostFingerprint` identifies the remote server, independent of user's private keys
- Fixed Unicode escapes in READMEs (ñ and box-drawing characters)
- Added `offset` and `limit` parameters documentation for `ssh_read_file`
- Updated technical details on undo download and partial file reading
- Removed `docs/` directory from git tracking (content preserved locally)

### Performance
- **history**: Avoided unnecessary array copying with smarter filtering
- **shell**: Settled timer properly cleaned up on session close
- **audit**: Enforce permissions on pre-existing audit logs with `chmodSync`

### Refactoring
- Removed unused `REDACT_PATTERNS.label` from security.ts
- Removed unused fields: `ReverseInfo.previousExisted`, `ShellSession.createdAt`
- Removed unnecessary cast in AuditLogger
- **parseResponses**: Throws explicit error on invalid entries
- **handleHistory**: Validates `filter` against enum, applies `Math.floor` to `limit`
- **handleLs**: Added audit logging with fallback for attributes
- **AuditLogger.close()**: Added `beforeExit` handler to flush pending writes

## [0.4.0] - 2026-05-16

### Features
- **Security Hardening**: Comprehensive multi-layer security model
  - Key-based authentication only (password auth removed)
  - Host fingerprint verification required for all connections (SHA256 + `hostVerifier`)
  - Local sandbox validation for `ssh_download`, `ssh_upload`, and `ssh_undo`
  - Dangerous command detection with advisory user confirmation
  - Automatic secret redaction in audit logs (password=, token=, Bearer patterns)

- **ReDoS Protection**: User-provided regex patterns validated with `safe-regex2` before compilation in `ssh_exec_interactive`

- **Connection Lifecycle Management**
  - SFTP client auto-invalidation on `close`/`error` events
  - Unexpected disconnect cleanup via SSH client `close`/`end` event listeners
  - Keepalive configuration: 30s interval, 3 retry count, 20s ready timeout

- **Execution Hardening**
  - Internal `execCommand` timeout: 30s with channel destruction on expiry
  - Buffer limits: 1MB per chunk for both `stdout` and `stderr` with periodic truncation
  - User timeout clamping: 1s–5min bounds
  - Protected filenames with `cat -- path` and `rm -f -- path` patterns

- **History & Undo Improvements**
  - Operation history capped at 100 entries
  - `previousContent` excluded if file exceeds 512KB (verified via `sftp.stat()` before reading)
  - Binary file detection and exclusion from undo backup

### Code Quality
- **Modularization**: Extracted pure utilities to `src/utils.ts` and typed validation helpers to `src/validation.ts`
- **Profile Loading**: Complete validation at startup (required fields, readable key file), private keys cached in memory
- **Version Management**: Dynamic version read from `package.json`

### Documentation
- Updated READMEs with security model, architecture, limitations, and technical details
- Included security analysis reports (claude_check.md, codex_check.md, gemini_check.md)

## [0.3.1] - 2026-05-08

### Features
- **NPX Support**: Add `bin` field for `s01-ssh-mcp` executable registration
- **Package Metadata**: Added `files`, `repository`, `keywords`, and `license` to `package.json`

## [0.3.0] - 2026-04-30

### Features
- **Operation History & Undo**: In-memory history tracking (max 100 entries)
  - `ssh_history`: List operations with optional filtering and pagination
  - `ssh_undo`: Revert last operation (download, upload, or file write)
  - Supports local file restoration and remote content rollback

## [0.2.0] - 2026-04-25

### Features
- **Interactive Command Execution**: PTY-based SSH command execution
  - `ssh_exec_interactive`: Execute commands with user-provided prompt/response patterns
  - Auto-response feature with regex-based pattern matching
  - Timeout and buffer configuration

## [0.1.0] - 2026-04-20

### Features
- **Initial MCP Server**: SSH remote administration via Model Context Protocol
  - Profile-based connection management (`ssh_list_profiles`, `ssh_connect`, `ssh_disconnect`)
  - Command execution (`ssh_exec`)
  - Persistent shell sessions (`ssh_shell_start`, `ssh_shell_send`, `ssh_shell_read`, `ssh_shell_close`)
  - File operations: SFTP-based upload/download, remote file read/write (`ssh_ls`, `ssh_read_file`, `ssh_write_file`)
  - Connection status and metadata (`ssh_status`)
  - Audit logging

[0.5.0]: https://github.com/d3v1an/ssh-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/d3v1an/ssh-mcp/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/d3v1an/ssh-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/d3v1an/ssh-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/d3v1an/ssh-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/d3v1an/ssh-mcp/releases/tag/v0.1.0
