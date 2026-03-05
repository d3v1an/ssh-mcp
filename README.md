# SSH MCP Server

MCP server para administración remota de servidores via SSH. Soporta múltiples perfiles, ejecución de comandos, transferencia de archivos (SFTP), y detección de comandos destructivos con audit log.

## Configuración

### 1. Perfiles de servidores

Editar `profiles.json`:

```json
{
  "produccion": {
    "host": "192.168.1.100",
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

### 3. Build

```bash
npm install
npm run build
```

### 4. Configuración MCP (Claude Desktop)

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/ruta/a/s01_ssh_mcp/dist/index.js"],
      "env": {
        "SSH_PASSWORD_PRODUCCION": "tu_password"
      }
    }
  }
}
```

## Tools disponibles

| Tool | Descripción |
|------|------------|
| `ssh_list_profiles` | Listar perfiles (sin passwords) |
| `ssh_connect` | Conectar a un perfil |
| `ssh_disconnect` | Cerrar conexión |
| `ssh_status` | Estado de conexión |
| `ssh_exec` | Ejecutar comando remoto |
| `ssh_upload` | Subir archivo (SFTP) |
| `ssh_download` | Descargar archivo (SFTP) |
| `ssh_ls` | Listar directorio remoto |
| `ssh_read_file` | Leer archivo remoto |
| `ssh_write_file` | Escribir archivo remoto |

## Seguridad

- Comandos destructivos (`rm -rf`, `reboot`, `shutdown`, etc.) requieren `confirm: true`
- Todas las operaciones se registran en `audit.log`
