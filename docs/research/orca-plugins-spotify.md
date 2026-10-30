# Investigación: plugin de Spotify para la barra lateral derecha de Orca

Fecha: 2026-10-30. Orca instalado: **1.4.244** (`/Applications/Orca.app/Contents/Info.plist`, `CFBundleShortVersionString`), commit `26aa174b` (`Contents/Resources/orca-local-build.json`). La última release publicada es v1.4.245 (`gh release list --repo stablyai/orca`). El repo `main` de upstream va adelantado respecto de lo instalado y la documentación de plugins describe la 1.4.245 en adelante.

Convención: **[verificado]** = leído en código o docs primarias; **[inferido]** = deducido de fuentes primarias sin probarlo en ejecución; **[no verificado]** = no se pudo confirmar.

---

## TL;DR

- Orca **sí tiene un sistema de plugins** (Alpha) y un plugin **sí puede agregar una pestaña al right sidebar** (`contributes.panels`, con un icono en la "activity bar" derecha).
- El panel, sin embargo, es un `<iframe sandbox="allow-scripts" srcdoc>` con CSP `default-src 'none'; connect-src 'none'; img-src data:`. **No tiene red, no puede cargar iframes de Spotify ni carátulas remotas, no reproduce audio y no puede hablar con el worker de su propio plugin.** Desde el panel solo se puede llamar a `workspace.readContext` y `notifications.show`.
- Hoy **no se puede hacer un panel de Spotify "en vivo" con controles usando solo la API soportada**. Lo que sí funciona hoy es un plugin `trusted-worker` (proceso Node) que controla Spotify (AppleScript o Web API) y se expone como **comandos de paleta + atajos de teclado + notificaciones**.
- Para tener el panel de verdad hace falta el canal panel↔worker que pide el issue abierto [stablyai/orca#25129](https://github.com/stablyai/orca/issues/25129) (o un fork o PR upstream). Hay hacks de la comunidad que llegan a algo parecido, pero no sirven para usuarios finales.
- Spotify complica mucho la vía Web API: desde 2026 las apps en *Development Mode* tienen un tope de **5 usuarios** y el dueño de la app necesita **Premium**, y el *Extended Quota* exige ser organización con ≥250k MAU. No se puede publicar un Client ID compartido: cada usuario tendría que crear su propia app en el dashboard de Spotify.
- **Recomendación:** backend AppleScript (`osascript`) en un worker. No pide login, ni Premium, ni app de Spotify. Hoy se entrega como comandos y atajos, y el panel se agrega cuando exista el canal panel↔worker (contribuirlo upstream).

---

## 1. Cómo está construido Orca y cómo se extiende

### 1.1 Stack

| Hecho | Fuente |
| --- | --- |
| App Electron; `main: ./out/main/index.js`, bin CLI `./out/cli/index.js` | `app.asar` → `package.json` (extraído en scratchpad) [verificado] |
| Electron **43.8.1**, Chrome 150.0.7871.250 | `Contents/Frameworks/Electron Framework.framework/Resources/Info.plist` (`CFBundleVersion`), strings del binario [verificado] |
| Renderer en React/TSX (componentes `src/renderer/src/components/right-sidebar/*.tsx`) | árbol del repo `stablyai/orca` [verificado] |
| Open source, MIT, repo `stablyai/orca` | `gh repo view stablyai/orca`; `app-update.yml` (`owner: stablyai, repo: orca`) [verificado] |
| Electron stock, **sin Widevine CDM** (ningún archivo `*widevine*` en el framework, y no aparecen `castlabs`/`components.whenReady` en `out/main`) | búsqueda local [verificado que no está; que EME falle es inferido] |

### 1.2 Sistema de plugins (Alpha)

Documentación oficial en el repo:
- `docs/reference/plugin-authoring.md`: guía.
- `docs/reference/plugin-manifest.md`: formato `orca-plugin.json`.
- `docs/reference/plugin-host-api.md`: API del host.
- `docs/reference/plugin-catalog.md` y `plugin-listing-policy.md`: distribución.
- Ejemplos: `examples/plugins/hello-orca` (panel + worker + eventos) y `examples/plugins/hostile-panel` (fixture de seguridad).

Todos en <https://github.com/stablyai/orca/tree/main/docs/reference> y <https://github.com/stablyai/orca/tree/main/examples/plugins>.

**Manifest** (`orca-plugin.json` en la raíz de una carpeta o repo git), formato 2 desde Orca 1.4.245 (`plugin-manifest.md` L15-16, L30). Campos clave:
- `manifestVersion: 2`, `id`, `name`, `version`, `engines.orca`, `execution`, `main`, `contributes`, `capabilities`, `pluginApi: 1`.
- `publisher` está deprecado: Orca lo deriva del dueño del repo, o pone `local` para carpetas (`plugin-authoring.md` L20-37).
- El **formato 1** (desde 1.4.160) sigue cargando y no lleva `execution` (`plugin-manifest.md` L213-219). Como la instalación local es 1.4.244, para probar hoy hay que usar formato 1 o actualizar Orca a ≥1.4.245.

**Perfiles de ejecución** (`plugin-authoring.md` L43-57):
- `data`: temas, sintaxis, traducciones.
- `declarative`: comandos que ejecutan acciones de Orca, atajos, recetas de VM.
- `sandboxed-ui`: **paneles** y editores custom, en un frame sandbox que solo habla por `window.orca`.
- `trusted-worker`: `main` corre en un **proceso Node aparte**, con las capacidades aprobadas. El usuario aprueba al instalar.

**Puntos de contribución útiles** (`plugin-manifest.md` L33-53):
- `contributes.panels`: "Sidebar panels". El campo `icon` es "Icon shown in the right-sidebar activity bar", con un set fijo de iconos lucide (`activity`, `bar-chart-3`, …, `zap`; no hay icono de música) (L61-70). **Esta es la pestaña del right sidebar.** En el código, `src/renderer/src/components/right-sidebar/PluginPanel.tsx` y `plugin-panel-activity-items.ts`.
- `contributes.commands`: paleta de comandos. Si no tiene `action`, lo ejecuta el worker (L74-81).
- `contributes.keybindings`, por ejemplo `Mod+Shift+K` (L101-109).
- `contributes.events`: `workspace.created`, `workspace.removed`, `agent.status.changed` (L85-89).
- Reservados para el futuro: `statusBarItems`, `sidebarCards` (barra **izquierda**), `connections` (sign-in hecho por el host), `mcpServers`, `skills`, `hooks`, `settings`. Hoy deben ir vacíos (L45-53, L199-211).

**Qué puede renderizar un panel** [verificado]:
- Un HTML propio (`entry`) metido en un `<iframe sandbox="allow-scripts" srcDoc=…>`. El código lo comenta así: "never add allow-same-origin" (`src/renderer/src/components/right-sidebar/PluginPanel.tsx` L99-113 en `main`).
- CSP antepuesta por el host: `default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`. Está en la instalación local, `app.asar/out/shared/plugins/plugin-panel-shell.js` L9-10, y en `main`, `src/shared/plugins/frames/plugin-panel-shell.ts`.
- El shell además cancela navegaciones, anula `window.open` y bloquea clicks en `<a href>` y `submit` (`plugin-panel-shell.js` L49-71).
- `examples/plugins/hostile-panel/panel.html` verifica que `fetch` y `<img>` remotos queden **bloqueados** (L38-74).
- Consecuencias:
  - No hay `fetch` a `api.spotify.com`.
  - No se pueden embeber iframes (`frame-src` cae en `default-src 'none'`).
  - No hay audio ni EME (`media-src` también cae en `'none'`).
  - No hay carátulas por URL, solo `data:`.
  - No hay React del host: el plugin trae su propio HTML/JS inline. Sí recibe tokens de tema como variables CSS `--orca-*` (`plugin-authoring.md` L49-53).
- **API disponible en el panel** (`docs/reference/plugin-host-api.md` L11-24; `src/shared/plugins/workers/plugin-host-api.ts` en `main`): solo `workspace.readContext` y `notifications.show`. `terminal.sendText` es `WORKER_ONLY` en `main` ("text plus Enter runs shell commands… only full-access workers get it"). En la 1.4.244 instalada todavía figura `panel: true` (`app.asar/out/shared/plugins/plugin-host-api.js` L89-97), así que cambió en la 1.4.245.
- **No hay canal panel↔worker.** El issue abierto [#25129](https://github.com/stablyai/orca/issues/25129) lo pide explícitamente: "a plugin panel can't show live data from its own plugin. It can't message its worker or reach a loopback server". Propone `orca.panel.postMessage`/`panels.onMessage` o una capacidad `net:loopback`. Sigue abierto y no encontré respuesta de los mantenedores [no verificado].
- Un intento de dar `storage` a los paneles se mergeó y se revirtió el mismo día ([#36273](https://github.com/stablyai/orca/pull/36273), revert [#36316](https://github.com/stablyai/orca/pull/36316), 2026-10-30). Siguen abiertos [#15643](https://github.com/stablyai/orca/pull/15643) y [#19023](https://github.com/stablyai/orca/pull/19023).

**Worker (`trusted-worker`)** [verificado salvo que se indique]:
- Es `export default function activate(orca)` con `orca.commands.register`, `orca.events.on`, `orca.host.call` y `orca.log` (`examples/plugins/hello-orca/main.mjs`; `plugin-authoring.md` L87-92).
- Corre como Node (`ELECTRON_RUN_AS_NODE=1`) con un entorno reducido a PATH/HOME/LANG/TMPDIR… (`src/main/plugins/workers/plugin-worker-env.ts`).
- Puede usar `child_process` (y por lo tanto `osascript`), `fetch` y `http` (servidor loopback). [inferido: es Node completo; el plugin de la comunidad orca-radio-fm lanza `mpv` desde su worker]
- Lo de "lazily forked" está en `hello-orca/main.mjs` L1. Según `plugin-authoring.md` L280-285, "workers may be stopped at any time", así que no conviene depender de un polling permanente.
- Host API exclusiva del worker: `storage.*`, `secrets.*` (archivo cifrado; sirve para refresh tokens), `settings.*` y `terminal.sendText` (`plugin-host-api.md` L11-24).
- Si un comando devuelve un string, Orca lo muestra tal cual (`hello-orca/main.mjs` L7).

**Dónde viven en disco** [verificado]:
- `~/Library/Application Support/orca/plugins/<publisher.id>/<contentHash>/orca-plugin.json`, más `current` y `.install-provenance/`.
- Lockfile: `~/Library/Application Support/orca/plugins/plugins.lock.json`. Hoy solo está `stablyai.orca-navigation-shortcuts` (source `bundled`).
- Catálogos configurados: `~/Library/Application Support/orca/plugins-data/marketplaces/sources.json` → `https://github.com/stablyai/orca-plugins.git`. El snapshot local lista 7 plugins oficiales (temas, iconos, recetas, atajos), ninguno con panel.

**Instalación y distribución** (`plugin-authoring.md` L139-243):
- **Desarrollo:** Settings → Plugins → "Turn on plugins" → "Development folders…" → elegir la carpeta → revisar y habilitar. Alternativa por CLI en ≥1.4.245: `orca plugin dev load <dir>`. El CLI 1.4.244 instalado **no tiene** `orca plugin` (`orca plugin --help` → "Unknown command: plugin").
- **Git URL:** "Install plugin → Git URL", con `https://github.com/<owner>/<repo>#vX.Y.Z` (README de orca-radio-fm). El publisher pasa a ser el dueño del repo.
- **Directorio público:** tag + topic `orca-plugin` en GitHub → aparece en `https://www.onorca.dev/plugins/<owner>/<repo>` (`plugin-authoring.md` L177-184).
- **Catálogo:** repo con `orca-catalog.json` que fija commit + `contentHash`. El usuario lo agrega en Settings → Plugins → ⋯ → Catalog sources (`plugin-catalog.md`). Las actualizaciones automáticas no piden nada si no aparecen capacidades nuevas.
- Política de listado: gratis, sin tracking, código no ofuscado y **sin usar marca ajena de forma que sugiera respaldo** (`plugin-listing-policy.md`). Ojo con el nombre y el logo de Spotify.

### 1.3 Otros puntos de extensión (posibles fallbacks)

| Punto | Para qué serviría | Fuente |
| --- | --- | --- |
| **Navegador embebido** (`orca tab create --url`, `goto`, `tab profile …`) | Abrir una UI web local (`http://127.0.0.1:PORT`) servida por el worker. Es lo que hace el autor de #25129 como workaround, pero queda como **pestaña central**, no en el sidebar | `orca --help` (sección "Browser Automation"); issue #25129 |
| **Automations** (`orca automations create …`) | Tareas programadas; no sirven para UI | `orca --help` |
| **Skills / MCP / agentes** | Un MCP de Spotify para que *los agentes* controlen la música. No da UI en el sidebar. `contributes.mcpServers`/`skills` están reservados en plugins | `orca --help`; `plugin-manifest.md` L45-48 |
| **Status bar nativa** | PR abierto [#9268](https://github.com/stablyai/orca/pull/9268) "feat(status-bar): show local media playback": muestra el tema actual de Spotify/Apple Music en macOS vía AppleScript. Es prior art del enfoque osascript dentro del propio Orca | GitHub |
| **Fork / PR upstream** | Repo MIT, React. Se puede implementar #25129 o un panel nativo | `gh repo view` |

### 1.4 Plugins de la comunidad que sirven de modelo

Búsqueda: `gh search repos --topic orca-plugin`.

- **[jrmatos/orca-radio-fm](https://github.com/jrmatos/orca-radio-fm)**: panel de radio en el sidebar derecho. Es el caso más parecido. Su README confirma el límite: "Orca renders plugin panels in a sandboxed iframe with a CSP that blocks **all** network and media, and panels cannot call the plugin's background worker. So audio never plays inside Orca".
  - Los botones del panel llaman a `notifications.show`, y un daemon systemd escucha esas notificaciones por **D-Bus** (solo Linux) y ejecuta la acción.
  - En macOS solo funcionan la paleta y los atajos, que corren en el worker.
  - Sirve como plantilla de comandos y atajos de reproducción.
- **[pty0220/orca-git-graph](https://github.com/pty0220/orca-git-graph)**: un proceso Python externo **reescribe el `panel.html`** de un plugin cargado como carpeta de desarrollo, y el watcher de Orca recarga el iframe (`docs/architecture.md`, "Data flow"). Así consigue datos "en vivo" de una sola vía (externo → panel), sin capacidades. Solo funciona con carpetas de desarrollo y resetea scroll y estado en cada refresco.
- Otros con panel: `jerrazuw/orca-gallery-panel`, `Craig-Franklin/orca-commit-review`, `h4rkl/orca-git-blame`. No los revisé en detalle [no verificado].
- No encontré ningún plugin de Spotify (`gh search issues/prs "spotify"` en `stablyai/orca` solo devuelve el PR #9268).

---

## 2. Formas de tener Spotify en ese sidebar

### 2.1 Spotify Web Playback SDK (el panel sería el reproductor)

- Requiere **Premium** ("mobile only types of premium subscriptions are excluded") y no se puede usar en proyectos comerciales sin aprobación previa ([Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk)).
- La página no menciona Electron ni Widevine. Sí exige `encrypted-media` en iframes cross-origin, o sea EME/DRM.
- Orca usa Electron 43.8.1 **stock, sin Widevine CDM**. Para tener Widevine en Electron hace falta el fork **castLabs ECS**, y para producción una firma VMP vía su servicio EVS ([castlabs/electron-releases](https://github.com/castlabs/electron-releases)). Conclusión inferida: el SDK no reproduciría.
- Además, el panel bloquea `connect-src`, scripts externos y `media-src`.
- **Veredicto: inviable** sin un fork de Orca sobre castLabs.

### 2.2 Web API: control remoto de un cliente existente (Spotify Connect)

- Endpoints `/me/player` (estado, `currently-playing`), `PUT /me/player/play`, `pause`, `next`, `previous`, search y `/me/playlists`.
- "This API only works for users who have Spotify Premium". Scope `user-modify-playback-state` ([Start/Resume Playback](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback)).
- **Auth:** Authorization Code + **PKCE**, sin client secret (recomendado cuando el secreto no se puede guardar). Token en `https://accounts.spotify.com/api/token`. El refresh puede o no devolver un refresh token nuevo ([PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)).
- **Redirect URI** ([reglas](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)):
  - "`localhost` is not allowed".
  - Hay que usar `http://127.0.0.1:PORT` o `http://[::1]:PORT`. HTTP solo se permite en loopback.
  - Los loopback se pueden registrar sin puerto y usar uno dinámico.
  - Se aplica a apps nuevas desde el 9-abr-2025 y a todas desde noviembre de 2025.
  - Encaja con un worker que levanta `http.createServer` en 127.0.0.1 y abre el navegador con `open`.
- **Cuotas (el problema grande):**
  - Development Mode: "Up to 5 authenticated Spotify users", cada uno en el allowlist. "The app owner must have a Spotify Premium account" ([Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)).
  - Desde el 11-feb-2026 (apps nuevas) y el 9-mar-2026 (existentes): un solo Client ID de Development Mode por desarrollador, 5 usuarios por Client ID, Premium obligatorio. Los cambios de endpoints para integraciones existentes se pospusieron ([blog 2026-02-06](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)).
  - Extended Quota: solo organizaciones con negocio registrado, servicio lanzado y **≥250k MAU** (desde el 15-may-2025) ([Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)).
  - Una fuente secundaria dice que el 23-jul-2026 el tope de Client IDs subió a 25 por cuenta [no verificado en fuente oficial]. No encontré que se haya levantado el tope de 5 usuarios.
- **Endpoints en Dev Mode** ([guía de migración feb-2026](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)):
  - Los endpoints de player no figuran entre los removidos [inferido: siguen disponibles].
  - El `limit` de search bajó a máx. 10 (default 5).
  - `/playlists/{id}/tracks` pasó a `/items` y solo devuelve los items de playlists propias o colaborativas.
  - Se removieron los batch, browse y top-tracks.
- **Implicancia de instalación:** no se puede publicar un Client ID compartido. Cada usuario tendría que tener Premium, crear su app en developer.spotify.com, registrar `http://127.0.0.1/callback` y pegar su Client ID en el plugin. Eso son 5 o 6 pasos manuales y fricción alta.
- **Dónde correría:** solo en el worker, porque el panel no tiene red. Los tokens van a `secrets.set`.
- **Veredicto:** es el más potente (search, playlists, cualquier dispositivo, multiplataforma) pero el más pesado de instalar. Conviene como modo "avanzado" opcional.

### 2.3 AppleScript / `osascript` contra Spotify de escritorio en macOS

- El diccionario local `/Applications/Spotify.app/Contents/Resources/Spotify.sdef` [verificado] expone:
  - Propiedades: `player state`, `player position`, `sound volume`, `shuffling`, `repeating`.
  - `current track` con `name`, `artist`, `album`, `duration`, `artwork url`, `spotify url`.
  - Comandos: `playpause`, `play`, `pause`, `next track`, `previous track`, `play track "<spotify:uri>"`.
- Sin OAuth, sin app en el dashboard, y **funciona con cuentas Free** [inferido: el sdef no impone restricciones; no lo probé con Free].
- No incluye búsqueda ni lista de playlists. Se puede reproducir una URI conocida con `play track`.
- Permisos:
  - Orca declara `NSAppleEventsUsageDescription` y tiene el entitlement `com.apple.security.automation.apple-events` (`Info.plist`; `codesign -d --entitlements`) [verificado].
  - Lo esperable es que macOS pregunte una vez "Orca quiere controlar Spotify" cuando el worker ejecute `osascript` [inferido, no probado].
- Solo macOS y solo si Spotify desktop está abierto. Hay que consultar `application "Spotify" is running` para no lanzarlo, como hace el PR #9268.
- La carátula (`artwork url`, en i.scdn.co) habría que descargarla en el worker y pasarla al panel como `data:`.
- **Veredicto:** la opción de instalación más simple con diferencia.

### 2.4 Embeds de Spotify (`open.spotify.com/embed`)

- La iFrame API permite `loadEntity`/`loadUri`, `play`, `pause`, `resume`, `togglePlay`, `restart`, `seek` y `destroy`, con eventos `ready`, `playback_started` y `playback_update` ([iFrame API](https://developer.spotify.com/documentation/embeds/references/iframe-api)).
- Reproduce **un contenido concreto** (track, álbum, playlist, episodio). No muestra "lo que estoy escuchando" ni controla otros dispositivos. Las docs no aclaran preview vs tema completo [no verificado].
- Además de eso:
  - En el panel está bloqueado por la CSP (`default-src 'none'` cubre `frame-src` y `script-src` externos).
  - Si reproduce temas completos, depende de DRM (EME), que Orca no trae [inferido].
- **Veredicto: inviable en el panel.**

### 2.5 open.spotify.com en el navegador embebido de Orca

- `orca tab create --url https://open.spotify.com` abre una pestaña de navegador **central**, no en el sidebar.
- El reproductor web de Spotify necesita Widevine, y el Electron stock de Orca no lo trae, así que lo esperable es el error de "contenido protegido" [inferido, no probado].
- Serviría solo para navegar el catálogo, no para escuchar.
- **Veredicto:** no cumple ni "sidebar" ni "reproducir".

### 2.6 Hacks posibles hoy (solo uso personal)

- **Panel reescrito** (estilo orca-git-graph): un worker o script reescribe `panel.html` de una carpeta de desarrollo con el estado actual (título y carátula en `data:`) y Orca lo recarga. Da display "en vivo" de una vía. Problemas:
  - Solo funciona con carpetas de desarrollo.
  - Parpadea y resetea el estado.
  - Los botones del panel no pueden avisar al worker.
- **Botones vía `notifications.show`** (estilo orca-radio-fm): en macOS no hay un bus equivalente a D-Bus fácil de escuchar, así que lo descarto.
- **Botones vía `terminal.sendText` desde el panel:** solo en ≤1.4.244, solo en la terminal del worktree activo, escribe en la terminal del usuario, y ya fue quitado en `main`. Lo descarto.

### 2.7 Comparación

| Opción | Instalación | Auth | Premium | Capacidades | Funciona en el panel hoy |
| --- | --- | --- | --- | --- | --- |
| **osascript (worker)** | 1 clic (Git URL o catálogo) + aprobar + permiso macOS | ninguna | no [inferido] | estado, carátula, play/pause/next/prev, volumen, shuffle, tocar URI | **No** (sí paleta, atajos y notificaciones). Panel cuando exista #25129 |
| Web API + PKCE (worker) | instalar + crear app de Spotify propia + pegar Client ID + login | PKCE, loopback 127.0.0.1 | **sí** (dueño de la app y usuario) | todo lo anterior + search (≤10), playlists propias, Connect multi-dispositivo, multiplataforma | igual que arriba |
| Web Playback SDK | requiere fork de Orca con castLabs | PKCE | sí | reproducir dentro de Orca | no |
| Embed iframe | – | – | – | un contenido fijo | no (CSP) |
| open.spotify.com en navegador de Orca | trivial | login web | – | navegar; reproducir probablemente no (DRM) | no (pestaña central) |
| Fork / PR upstream (panel nativo o #25129) | depende de que lo acepten | – | – | total | sí, si se mergea |

---

## 3. Recomendación

**Camino:** plugin `trusted-worker` con backend **osascript** como base, y contribuir upstream el canal panel↔worker de #25129 para tener el panel. La Web API queda como modo opcional "avanzado".

### Fase 1: funciona hoy y se instala en un paso

Plugin que corre en el worker:
- Comandos de paleta: "Spotify: Play/Pause", "Next", "Previous", "Now playing" (devuelve "Tema — Artista").
- Atajos de teclado.
- Opcional: `notifications.show` cuando cambia el tema. Con poca garantía, porque el worker puede ser detenido.
- Panel: estático (ayuda o atajos) o directamente sin panel hasta la fase 2. Un panel que no hace nada confunde.

### Fase 2: panel en el sidebar

1. Proponer y aportar un PR a `stablyai/orca` implementando #25129 (el autor del issue ofreció hacer el PR y pidió acordar la forma primero).
2. Con ese canal, el panel recibe `{state, title, artist, artworkDataUrl, position}` del worker y le manda `{cmd: 'next'}`.
3. Alternativa si no se acepta: un fork, o un panel nativo inspirado en el PR #9268.

### Fase 3 (opcional)

Backend Web API con PKCE, activable desde la configuración, para Linux/Windows, búsqueda y playlists. El usuario trae su propio Client ID.

### Estructura propuesta del repo

```
orca-spotify/
├── orca-plugin.json
├── worker.mjs          # activate(orca): registra comandos y atajos; backend elegido
├── backends/
│   ├── applescript.mjs # osascript -e '…' con timeout; chequea "is running"
│   └── webapi.mjs      # opcional: PKCE + servidor 127.0.0.1, tokens en secrets
├── panel/index.html    # UI; hoy estática, en fase 2 usa el canal panel↔worker
└── assets/icon.png     # 128×128+, sin logo de Spotify (política de listado)
```

`orca-plugin.json` (formato 2, Orca ≥1.4.246 para omitir `publisher`):

```json
{
  "$schema": "https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json",
  "manifestVersion": 2,
  "execution": "trusted-worker",
  "id": "now-playing",
  "name": "Now Playing (Spotify)",
  "version": "0.1.0",
  "engines": { "orca": ">=1.4.246" },
  "pluginApi": 1,
  "main": "worker.mjs",
  "contributes": {
    "panels": [{ "id": "player", "title": "Now Playing", "icon": "activity", "entry": "panel/index.html" }],
    "commands": [
      { "id": "playpause", "title": "Spotify: Play / Pause" },
      { "id": "next", "title": "Spotify: Next track" },
      { "id": "previous", "title": "Spotify: Previous track" },
      { "id": "now", "title": "Spotify: Now playing" }
    ],
    "keybindings": [
      { "command": "playpause", "key": "Mod+Alt+Shift+P" },
      { "command": "next", "key": "Mod+Alt+Shift+N" }
    ]
  },
  "capabilities": [{ "kind": "notifications:show" }, { "kind": "storage:own" }]
}
```

Para probar en la 1.4.244 instalada hay que usar formato 1: sin `execution` ni `$schema`, con `"manifestVersion": 1`, `"publisher"` y `"engines": {"orca": ">=1.4.160"}`, como hace orca-radio-fm. También se puede actualizar Orca a 1.4.245+.

Esqueleto del worker (backend AppleScript):

```js
import { execFile } from 'node:child_process'
const osa = (script) => new Promise((res, rej) =>
  execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 }, (e, out) => e ? rej(e) : res(out.trim())))
const ifRunning = (body) =>
  `if application "Spotify" is running then tell application "Spotify" to ${body}`
export default function activate(orca) {
  orca.commands.register('playpause', () => osa(ifRunning('playpause')))
  orca.commands.register('next', () => osa(ifRunning('next track')))
  orca.commands.register('previous', () => osa(ifRunning('previous track')))
  orca.commands.register('now', () =>
    osa(ifRunning('(name of current track) & " — " & (artist of current track)')))
}
```

### Pasos del usuario final

1. Tener Orca ≥1.4.246 y Spotify de escritorio abierto (macOS).
2. Settings → Plugins → "Turn on plugins". Luego Install plugin → Git URL `https://github.com/<owner>/orca-spotify#v0.1.0`, o buscarlo en el directorio o catálogo cuando esté listado (topic `orca-plugin`).
3. Revisar los permisos y hacer clic en "Enable".
4. Primer uso: aceptar el prompt de macOS "Orca quiere controlar Spotify" [inferido].
5. Usar la paleta o los atajos. En fase 2, la pestaña "Now Playing" del sidebar derecho.

Para quien desarrolla: `orca plugin create <dir> --template panel`, `orca plugin validate .` y `orca plugin dev load .` (CLI ≥1.4.245; `plugin-authoring.md` L147-169).

---

## Pendientes y riesgos sin verificar

- Que el prompt de Automatización de macOS aparezca y se atribuya a Orca cuando `osascript` lo lanza el worker.
- Que el control por AppleScript funcione con cuentas Free.
- Si los mantenedores aceptarían #25129 y con qué forma.
- Etiquetas exactas de la UI de plugins en la 1.4.244 instalada. Las tomé de las docs de `main` y del README de orca-radio-fm.
- Que open.spotify.com y los embeds fallen por DRM en el navegador de Orca (inferido por la ausencia de Widevine; no lo probé).
- El cambio a 25 Client IDs por cuenta de Spotify (solo fuente secundaria: <https://vorplabs.com/agent-tools/spotify-api-changes>).
