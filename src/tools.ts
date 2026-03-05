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
  {
    name: "ssh_exec_interactive",
    description:
      "Ejecuta un comando interactivo en el servidor remoto con PTY. Permite responder automáticamente a prompts (ej: sudo password, confirmaciones yes/no). Si el comando es destructivo requiere confirm: true",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Comando a ejecutar en el servidor remoto",
        },
        responses: {
          type: "array",
          description:
            "Lista de respuestas automáticas a prompts. Cada entrada tiene un regex que detecta el prompt y la respuesta a enviar",
          items: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description: "Regex para detectar el prompt (ej: '[Pp]assword[:\\s]')",
              },
              answer: {
                type: "string",
                description: "Texto a enviar como respuesta al prompt",
              },
              sensitive: {
                type: "boolean",
                description:
                  "Si es true, la respuesta se registra como [REDACTED] en el audit log",
              },
            },
            required: ["prompt", "answer"],
          },
        },
        timeout: {
          type: "number",
          description: "Timeout global en milisegundos (default: 30000)",
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
    name: "ssh_shell_start",
    description:
      "Inicia una sesión de shell interactiva persistente con PTY. Útil para REPLs, workflows multi-paso, o login a servicios. Máximo 5 sesiones concurrentes. Auto-cierre tras 5 min de inactividad",
    inputSchema: {
      type: "object",
      properties: {
        cols: {
          type: "number",
          description: "Ancho del terminal en columnas (default: 80)",
        },
        rows: {
          type: "number",
          description: "Alto del terminal en filas (default: 24)",
        },
      },
    },
  },
  {
    name: "ssh_shell_send",
    description:
      "Envía input a una sesión de shell activa. Si raw es false (default), aplica detección de comandos peligrosos. Retorna el output generado tras enviar el input",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "ID de la sesión de shell",
        },
        input: {
          type: "string",
          description: "Texto a enviar a la shell (se agrega \\n automáticamente si raw es false)",
        },
        raw: {
          type: "boolean",
          description:
            "Si es true, envía el input tal cual sin agregar \\n ni aplicar detección de comandos peligrosos (default: false)",
        },
        timeout: {
          type: "number",
          description: "Tiempo en ms para esperar output después de enviar (default: 2000)",
        },
        confirm: {
          type: "boolean",
          description:
            "Confirmar ejecución de comandos peligrosos. Solo aplica cuando raw es false",
        },
      },
      required: ["sessionId", "input"],
    },
  },
  {
    name: "ssh_shell_read",
    description:
      "Lee el output acumulado en el buffer de una sesión de shell. Espera brevemente por output adicional antes de retornar",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "ID de la sesión de shell",
        },
        timeout: {
          type: "number",
          description: "Tiempo en ms para esperar output adicional (default: 2000)",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "ssh_shell_close",
    description: "Cierra una sesión de shell interactiva y libera recursos",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "ID de la sesión de shell a cerrar",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "ssh_history",
    description:
      "Muestra el historial de operaciones ejecutadas durante la conexión activa. Permite filtrar por tipo de operación y limitar resultados",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["all", "reversible", "reversed"],
          description:
            "Filtro del historial: 'all' (todas), 'reversible' (solo reversibles), 'reversed' (solo revertidas). Default: 'all'",
        },
        limit: {
          type: "number",
          description: "Número máximo de registros a retornar (default: 20)",
        },
      },
    },
  },
  {
    name: "ssh_undo",
    description:
      "Revierte una operación específica del historial usando su ID. Solo funciona con operaciones marcadas como reversibles (ssh_write_file, ssh_upload, ssh_download). Requiere confirm: true para ejecutar la reversión",
    inputSchema: {
      type: "object",
      properties: {
        recordId: {
          type: "number",
          description: "ID del registro de operación a revertir (obtenido de ssh_history)",
        },
        confirm: {
          type: "boolean",
          description: "Confirmar la reversión de la operación",
        },
      },
      required: ["recordId"],
    },
  },
];
