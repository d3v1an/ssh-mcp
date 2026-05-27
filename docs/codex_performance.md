# Codex Performance And Regression Check

Fecha: 2026-05-27

## Alcance

Revisión del estado actual después de los cambios en:

- `src/index.ts`
- `src/security.ts`
- `src/profiles.ts`
- `src/validation.ts`
- `src/utils.ts`
- `src/tools.ts`
- `profiles.json.example`
- `README.md`
- `README.es.md`

Validación ejecutada:

- `npm run build` -> OK

## Resumen

Los cambios corrigen varias observaciones importantes de la revisión anterior:

- Ya existe validación de fingerprint del host SSH.
- Ya hay validación tipada básica para argumentos.
- Ya existe sandbox para rutas locales.
- Ya se limita el historial en memoria.
- Ya se maneja mejor la caída de conexión.

Pero todavía quedaron problemas relevantes, y algunos de ellos impactan tanto seguridad como performance:

1. `ssh_download` + `ssh_undo` todavía puede borrar archivos locales preexistentes dentro del sandbox.
2. `execCommand()` ahora tiene timeout lógico, pero no cancela el proceso remoto ni limpia sus listeners.
3. `stderr` sigue sin límite de memoria.
4. El “cap” para contenido previo ocurre demasiado tarde: primero lee el archivo completo y solo después decide si conservarlo.
5. El manejo de strings para buffers y logs sigue siendo costoso para salidas grandes o comandos frecuentes.

## Hallazgos

### 1. Alto: `ssh_download` sigue pudiendo destruir archivos locales válidos durante `undo`

Referencias:

- `src/index.ts:346`
- `src/index.ts:354`
- `src/index.ts:912`

Detalle:

Aunque ahora `localPath` está restringido por `validateLocalPath()`, la lógica de `ssh_download` sigue registrando el undo como `local_file_delete` sin capturar si el archivo local ya existía antes. Después, `ssh_undo` hace `unlinkSync()` directamente.

Impacto:

- Un archivo local legítimo dentro del sandbox puede ser sobrescrito por `ssh_download`.
- Al revertir, el archivo previo se elimina en lugar de restaurarse.
- La vulnerabilidad anterior se redujo en alcance, pero no quedó corregida del todo.

Recomendación:

- Antes de descargar, detectar si `localPath` existe.
- Si existe, capturar backup o contenido previo y restaurarlo en `undo`.
- Si no existe, entonces sí usar estrategia de borrado.

### 2. Alto: el timeout de `execCommand()` no cancela el comando remoto

Referencias:

- `src/index.ts:1037`
- `src/index.ts:1069`

Detalle:

`Promise.race()` rechaza por timeout, pero no cierra el `stream` SSH ni mata el proceso remoto. Eso significa que el comando puede seguir ejecutándose en el servidor aunque el caller ya haya recibido error. Además, los listeners permanecen hasta que el proceso termine.

Impacto:

- Fugas temporales de memoria y listeners.
- Consumo remoto innecesario.
- Posibles side effects tardíos después de que la llamada ya se reportó como fallida.

Recomendación:

- Guardar referencia al `stream` y destruirlo al vencer el timeout.
- Limpiar timers y listeners en todos los caminos.
- Si aplica, enviar señal remota o cerrar el canal explícitamente.

### 3. Medio: `stderr` continúa sin límite de buffer

Referencias:

- `src/index.ts:1045`
- `src/index.ts:1055`

Detalle:

Se limitó `stdout`, pero `stderr` sigue creciendo sin tope. Un proceso verboso en error puede consumir memoria de forma indefinida.

Impacto:

- Riesgo de memory pressure.
- Comportamiento asimétrico difícil de diagnosticar.

Recomendación:

- Aplicar el mismo límite de `MAX_BUFFER` a `stderr`.
- Indicar cuando la salida fue truncada.

### 4. Medio: el recorte de `previousContent` sucede después de leer el archivo completo

Referencias:

- `src/index.ts:289`
- `src/index.ts:429`
- `src/index.ts:995`

Detalle:

La nueva protección `MAX_PREV_CONTENT` solo evita guardar el contenido previo en historial, pero no evita cargar el archivo completo en memoria primero con `cat -- ...`. En términos de performance, el costo fuerte ya ocurrió antes de `capPrevContent()`.

Impacto:

- Alto uso de memoria en archivos grandes.
- Latencia innecesaria antes de `upload` y `write_file`.
- Sigue siendo frágil para binarios o contenidos enormes.

Recomendación:

- Consultar tamaño primero con `sftp.stat()` o `wc -c`.
- Saltar backup textual si supera el umbral.
- Para undo robusto, usar backup remoto temporal en vez de contenido inline.

### 5. Medio: `ssh_read_file` sigue siendo una lectura completa sin control de tamaño

Referencias:

- `src/index.ts:402`
- `src/index.ts:407`

Detalle:

`ssh_read_file` sigue usando `cat -- ...` sobre el archivo entero. El timeout ayuda, pero no resuelve memoria ni volumen de salida cuando el archivo es grande.

Impacto:

- Lecturas costosas.
- Respuestas grandes por stdio MCP.
- Posible truncado implícito y uso elevado de CPU/memoria en strings.

Recomendación:

- Añadir tamaño máximo configurable.
- Permitir lectura parcial (`offset`, `limit`) o `tail/head`.
- Preferir SFTP streaming cuando el caso lo requiera.

### 6. Medio: `execCommand()` deja timers vivos hasta que expiren

Referencias:

- `src/index.ts:1069`
- `src/index.ts:1076`

Detalle:

Cuando el comando termina rápido, el timeout creado con `setTimeout()` no se limpia. No suele ser crítico por operación aislada, pero en carga alta introduce timers pendientes innecesarios.

Impacto:

- Overhead evitable en workloads intensivos.
- Más presión sobre el event loop si hay muchas operaciones concurrentes.

Recomendación:

- Guardar el handle del timer y hacer `clearTimeout()` al resolver o rechazar.

### 7. Medio: concatenar strings en buffers es costoso para outputs grandes

Referencias:

- `src/index.ts:520`
- `src/index.ts:566`
- `src/index.ts:627`
- `src/index.ts:1048`

Detalle:

La implementación usa `output += chunk` y `buffer += data.toString()` en varios puntos. En Node esto puede volverse costoso por copias repetidas cuando hay mucha salida.

Impacto:

- Mayor CPU.
- Más garbage collection.
- Menor rendimiento en sesiones interactivas ruidosas.

Recomendación:

- Acumular chunks en arreglo y unir al final.
- O truncar por bytes con `Buffer`.
- Mantener una política homogénea para `stdout`, `stderr` y shell sessions.

### 8. Bajo: `handleHistory()` copia el arreglo completo antes de filtrar

Referencias:

- `src/index.ts:796`

Detalle:

Con `MAX_HISTORY=100` hoy no es grave, pero `let records = [...this.commandHistory]` hace copia completa aunque luego se filtre o limite.

Impacto:

- Costo pequeño hoy, pero innecesario.

Recomendación:

- Filtrar directamente sobre la referencia si no se muta.
- O aplicar `slice(-limit)` antes cuando el filtro sea `all`.

### 9. Bajo: el endurecimiento de permisos del audit log no corrige archivos ya existentes

Referencias:

- `src/security.ts:59`
- `src/security.ts:63`

Detalle:

`openSync(..., "a", 0o600)` asegura el modo solo al crear el archivo. Si `audit.log` ya existía con permisos más amplios, el cambio no los reduce.

Impacto:

- Persistencia de una configuración insegura heredada.

Recomendación:

- Aplicar `chmodSync(this.logPath, 0o600)` tras abrir, manejando errores de forma segura.

## Análisis De Performance

### Lo que mejoró

- Se agregó `MAX_HISTORY`, evitando crecimiento ilimitado del historial.
- Se tiparon mejor los argumentos, reduciendo errores de coerción.
- Se cachea SFTP y se invalida cuando el subsistema cae.
- Se agregaron keepalives y `readyTimeout` en la conexión SSH.

### Cuellos de botella actuales

1. Backups previos con `cat` completo antes de `upload` y `write`.
2. Lecturas completas en `ssh_read_file`.
3. `Promise.race` sin cancelación real del trabajo remoto.
4. Buffers basados en strings para streams de alto volumen.
5. Escritura síncrona del audit log con `appendFileSync()` en cada evento.

### Recomendaciones de performance

#### Prioridad 1

- Cancelar de verdad el canal SSH cuando `execCommand()` vence por timeout.
- Limitar `stderr` igual que `stdout`.
- Evitar leer contenido previo completo si excede el umbral.

#### Prioridad 2

- Migrar backups de undo a archivos temporales remotos o estrategia de snapshot.
- Añadir lectura parcial para `ssh_read_file`.
- Reemplazar concatenación incremental de strings por acumulación de chunks.

#### Prioridad 3

- Evaluar logging asíncrono o buffered para `audit.log`.
- Revisar si `MAX_BUFFER` y `MAX_PREV_CONTENT` deben ser configurables por entorno.

## Riesgo De Regresión

Los cambios recientes mejoraron claramente la seguridad base, pero todavía hay dos zonas donde pueden aparecer incidentes operativos:

- Reversiones locales con pérdida de archivos previos.
- Comandos remotos que “expiran” en el cliente pero siguen ejecutándose en el servidor.

Ambos puntos mezclan correctness, seguridad y performance, así que conviene tratarlos antes de ampliar el uso del servidor.

## Conclusión

La dirección de los cambios es correcta y el proyecto quedó mejor que en la revisión anterior. Sin embargo, todavía no cerró completamente el problema de `undo` local, y el nuevo timeout de `execCommand()` quedó incompleto desde el punto de vista operativo y de performance. La siguiente iteración debería enfocarse en cancelación real de comandos, manejo acotado de buffers y backups/undo consistentes.
