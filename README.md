# SSH MCP Server

![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)
![MCP SDK](https://img.shields.io/badge/MCP_SDK-1.12-blue?logo=anthropic&logoColor=white)
![SSH2](https://img.shields.io/badge/SSH2-1.16-orange)
![License](https://img.shields.io/badge/License-Private-red)
![Version](https://img.shields.io/badge/Version-1.0.0-green)

MCP server para administración remota de servidores via SSH. Soporta múltiples perfiles, ejecución de comandos, transferencia de archivos (SFTP), y detección de comandos destructivos con audit log.

---

## Arquitectura

### Diagrama General

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Desktop                           │
│                    (u otro cliente MCP)                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │ stdio (JSON-RPC)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SSH MCP Server                             │
│  ┌───────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  MCP SDK   │  │ Tool Router  │  │   Security Module        │  │
│  │  (stdio)   │──│  (index.ts)  │──│  - Dangerous cmd detect  │  │
│  └───────────┘  └──────┬───────┘  │  - Audit logging         │  │
│                        │          └──────────────────────────┘  │
│                        ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              SSH Client (ssh2)                            │   │
│  │  ┌──────────────┐    ┌────────────────────────────────┐  │   │
│  │  │  exec()      │    │  SFTP (lazy init)              │  │   │
│  │  │  - Comandos  │    │  - upload / download           │  │   │
│  │  │  - cat (read)│    │  - ls / write / readdir        │  │   │
│  │  └──────────────┘    └────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                           │
                           │ SSH (TCP :22)
                           ▼
                 ┌───────────────────┐
                 │  Servidor Remoto   │
                 │  (Linux/Unix)      │
                 └───────────────────┘
```

### Flujo de Conexión y Ejecución

```
                    ┌──────────────┐
                    │    Inicio    │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ list_profiles │
                    │ Ver perfiles  │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐         ┌─────────────────┐
                    │  ssh_connect  │────No──▶│ Error: password  │
                    │  (perfil)     │         │ no encontrado    │
                    └──────┬───────┘         └─────────────────┘
                           │ OK
                           ▼
              ┌────────────────────────┐
              │   Conexión Activa      │
              │   (1 perfil a la vez)  │
              └───────────┬────────────┘
                          │
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
     ┌────────────┐ ┌──────────┐ ┌───────────┐
     │  ssh_exec   │ │  SFTP    │ │ ssh_status │
     │  (comando)  │ │  ops     │ │ ssh_disconnect
     └─────┬──────┘ └────┬─────┘ └───────────┘
           │              │
     ┌─────▼──────┐       ▼
     │ Peligroso?  │  upload / download
     │ (regex)     │  ls / read / write
     ├──Sí────┐    │
     │        ▼    │
     │  confirm:   │
     │  true?      │
     │   │    │    │
     │  Sí   No   │
     │   │    │    │
     │   ▼    ▼    │
     │  Exec WARN  │
     └────┬────────┘
          ▼
    ┌───────────┐
    │ audit.log  │
    └───────────┘
```

### Flujo de Seguridad (Comandos Peligrosos)

```
  Comando recibido
        │
        ▼
  ┌─────────────────┐     ┌──────────────────────────────────┐
  │ isDangerousCmd() │     │ Patrones detectados:             │
  │ (16 regex)       │     │  - rm -rf /                      │
  └────┬────────┬────┘     │  - mkfs.*                        │
       │        │          │  - dd if=                         │
      Safe   Peligroso     │  - reboot / shutdown / halt      │
       │        │          │  - chmod 777 /                    │
       │        ▼          │  - fork bomb :(){ :|:& };:       │
       │  ┌───────────┐   │  - systemctl stop/disable/mask   │
       │  │ confirm:   │   │  - killall                       │
       │  │ true?      │   │  - iptables -F                   │
       │  └──┬─────┬───┘   │  - chown -R                      │
       │    Sí    No       │  - dd, init 0/6                   │
       │     │     │       └──────────────────────────────────┘
       │     │     ▼
       │     │  ADVERTENCIA
       │     │  (no ejecuta)
       ▼     ▼
    Ejecutar comando
        │
        ▼
    audit.log
```

### Estructura del Proyecto

```
s01_ssh_mcp/
├── src/
│   ├── index.ts       # Clase SSHMCPServer — router de tools y lógica SSH
│   ├── tools.ts       # Definición de las 10 tools MCP (schemas JSON)
│   ├── profiles.ts    # Carga de perfiles + inyección de passwords desde env
│   ├── security.ts    # Detección de comandos peligrosos + AuditLogger
│   └── types.ts       # Interfaces: SSHProfile, AuditEntry
├── dist/              # Output compilado (generado por tsc)
├── profiles.json      # Configuración de servidores SSH
├── .env               # Passwords (no versionado)
├── audit.log          # Log de auditoría (generado en runtime)
├── package.json
└── tsconfig.json
```

---

## Configuración

### 1. Perfiles de servidores

Editar `profiles.json`:

```json
{
  "produccion": {
    "host": "192.168.1.100",
    "port": 22,
    "username": "deploy"
  },
  "staging": {
    "host": "192.168.1.101",
    "port": 22,
    "username": "deploy"
  }
}
```

### 2. Passwords

Crear `.env` (copiar de `.env.example`):

```
SSH_PASSWORD_PRODUCCION=tu_password
SSH_PASSWORD_STAGING=tu_password
```

El formato es `SSH_PASSWORD_<NOMBRE_PERFIL_UPPERCASE>`.

### 3. Build y ejecución

```bash
npm install
npm run build
npm start
```

### 4. Configuración MCP (Claude Desktop)

Agregar en la configuración de Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/ruta/a/s01_ssh_mcp/dist/index.js"],
      "env": {
        "SSH_PASSWORD_PRODUCCION": "tu_password",
        "SSH_PASSWORD_STAGING": "tu_password"
      }
    }
  }
}
```

> **Nota:** Opcionalmente se puede definir `SSH_PROFILES_PATH` en `env` para apuntar a un `profiles.json` en otra ubicación.

---

## Tools disponibles

| Tool | Descripción | Requiere conexión |
|------|------------|:-----------------:|
| `ssh_list_profiles` | Listar perfiles configurados (sin passwords) | No |
| `ssh_connect` | Conectar a un perfil SSH | No |
| `ssh_disconnect` | Cerrar la conexión SSH activa | Sí |
| `ssh_status` | Estado de conexión (perfil, host, uptime) | Sí |
| `ssh_exec` | Ejecutar comando remoto | Sí |
| `ssh_upload` | Subir archivo local al servidor (SFTP) | Sí |
| `ssh_download` | Descargar archivo del servidor (SFTP) | Sí |
| `ssh_ls` | Listar directorio remoto (SFTP) | Sí |
| `ssh_read_file` | Leer contenido de archivo remoto | Sí |
| `ssh_write_file` | Escribir contenido a archivo remoto (SFTP) | Sí |

### Parámetros por tool

| Tool | Parámetros | Requeridos |
|------|-----------|:----------:|
| `ssh_connect` | `profile` (string) | Sí |
| `ssh_exec` | `command` (string), `confirm` (boolean) | `command` |
| `ssh_upload` | `localPath` (string), `remotePath` (string) | Ambos |
| `ssh_download` | `remotePath` (string), `localPath` (string) | Ambos |
| `ssh_ls` | `path` (string, default: home) | No |
| `ssh_read_file` | `path` (string) | Sí |
| `ssh_write_file` | `path` (string), `content` (string) | Ambos |

---

## Seguridad

### Detección de comandos destructivos

Los siguientes patrones son interceptados y requieren `confirm: true` para ejecutarse:

| Patrón | Razón |
|--------|-------|
| `rm -rf /` | rm recursivo en raíz del sistema |
| `rm -r`, `rm -rf` | Eliminación masiva de archivos |
| `mkfs.*` | Formateo de sistema de archivos |
| `dd if=` | Escritura directa a disco |
| `reboot`, `shutdown`, `halt`, `poweroff` | Control de estado del servidor |
| `init 0`, `init 6` | Cambio de runlevel |
| `chmod 777 /` | Permisos inseguros en raíz |
| `chown -R` | Cambio masivo de propiedad |
| `> /dev/*` | Escritura directa a dispositivo |
| `:(){ :\|:& };:` | Fork bomb |
| `systemctl stop\|disable\|mask` | Detención de servicios del sistema |
| `killall` | Terminación masiva de procesos |
| `iptables -F` | Flush de reglas de firewall |

### Audit log

Todas las operaciones se registran en `audit.log` con el formato:

```
[timestamp] [perfil] [tool] [parámetros] [RESULT: ok|error]
```

Ejemplo:

```
[2026-03-04T10:30:00.000Z] [produccion] [ssh_exec] [ls -la /var/log] [RESULT: ok]
[2026-03-04T10:31:00.000Z] [produccion] [ssh_upload] [./app.tar.gz -> /tmp/app.tar.gz] [RESULT: ok]
```

---

## Detalles Técnicos

- **Transporte MCP:** stdio (JSON-RPC sobre stdin/stdout)
- **Conexión SSH:** Una conexión activa a la vez. Intentar conectar a otro perfil sin desconectar genera error.
- **SFTP:** Inicialización lazy — se crea al primer uso de una operación de archivos y se reutiliza.
- **Lectura de archivos:** Usa `ssh exec cat` (no SFTP) para archivos de texto.
- **Escritura de archivos:** Usa SFTP `createWriteStream` para soporte de archivos grandes.
- **Escape de argumentos:** Shell escaping con comillas simples para prevenir inyección de comandos.
- **Audit logging:** No bloqueante — errores de escritura al log se ignoran para no interrumpir operaciones.
- **Cache de perfiles:** `profiles.json` se lee una vez y se cachea en memoria.
