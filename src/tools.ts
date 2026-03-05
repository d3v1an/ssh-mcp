import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const tools: Tool[] = [
  {
    name: "ssh_list_profiles",
    description: "Lista los perfiles de servidores SSH disponibles (sin mostrar passwords)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ssh_connect",
    description: "Conecta a un servidor SSH usando un perfil configurado",
    inputSchema: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description: "Nombre del perfil del servidor (ej: produccion, staging)",
        },
      },
      required: ["profile"],
    },
  },
  {
    name: "ssh_disconnect",
    description: "Cierra la conexión SSH activa",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ssh_status",
    description: "Muestra el estado de la conexión SSH actual (perfil, host, tiempo conectado)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ssh_exec",
    description:
      "Ejecuta un comando en el servidor remoto. Si el comando es destructivo (rm -rf, reboot, etc.) requiere confirm: true para ejecutarse",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Comando a ejecutar en el servidor remoto",
        },
        confirm: {
          type: "boolean",
          description:
            "Confirmar ejecución de comandos peligrosos. Requerido cuando el comando es detectado como destructivo",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "ssh_upload",
    description: "Sube un archivo local al servidor remoto via SFTP",
    inputSchema: {
      type: "object",
      properties: {
        localPath: {
          type: "string",
          description: "Ruta del archivo local a subir",
        },
        remotePath: {
          type: "string",
          description: "Ruta destino en el servidor remoto",
        },
      },
      required: ["localPath", "remotePath"],
    },
  },
  {
    name: "ssh_download",
    description: "Descarga un archivo del servidor remoto al sistema local via SFTP",
    inputSchema: {
      type: "object",
      properties: {
        remotePath: {
          type: "string",
          description: "Ruta del archivo en el servidor remoto",
        },
        localPath: {
          type: "string",
          description: "Ruta destino en el sistema local",
        },
      },
      required: ["remotePath", "localPath"],
    },
  },
  {
    name: "ssh_ls",
    description: "Lista el contenido de un directorio en el servidor remoto",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Ruta del directorio a listar (default: directorio home)",
        },
      },
    },
  },
  {
    name: "ssh_read_file",
    description: "Lee el contenido de un archivo en el servidor remoto",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Ruta del archivo a leer en el servidor remoto",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "ssh_write_file",
    description: "Escribe contenido a un archivo en el servidor remoto",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Ruta del archivo en el servidor remoto",
        },
        content: {
          type: "string",
          description: "Contenido a escribir en el archivo",
        },
      },
      required: ["path", "content"],
    },
  },
];
