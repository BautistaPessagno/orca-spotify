# Investigación: Spotify Web API como backend del plugin Now Playing

Fecha: 2026-11-01. Orca instalado: **1.4.245** (`/Applications/Orca.app/Contents/Info.plist`, `CFBundleShortVersionString`). Última release publicada: v1.4.245 (2026-10-30). Docs y código de Orca leídos en `stablyai/orca`, rama `main`, commit `225db8c` (2026-11-01 18:12 UTC). Plugin: Now Playing 0.1.0, commit `29d4029` de este repo. Todas las páginas de Spotify se leyeron el **2026-11-01** entre las 18:24 y las 19:00 UTC (HTML renderizado en el servidor, bajado con `curl` y pasado a texto; no hizo falta navegador).

Continúa la [nota previa](./orca-plugins-spotify.md) (2026-10-30) y no repite lo que ya verificó. Lo que sigue es nuevo o corregido respecto de ella.

Convención, igual que en la nota previa: **[verificado]** = leído en la fuente primaria; **[inferido]** = deducido de fuentes primarias sin probarlo; **[no verificado]** = no se pudo confirmar. Los ids (S1, O2, L1…) se resuelven en "Fuentes consultadas", al final, con la fecha de lectura de cada página de Spotify.

---

## TL;DR

- **Acceso hoy:** solo Development Mode está al alcance. Máximo 5 usuarios con allowlist, el dueño de la app necesita Premium (si vence, la app deja de funcionar) y hasta 25 Client IDs por cuenta de desarrollador. Extended Quota exige una organización registrada con servicio lanzado y al menos 250k MAU. Un Client ID compartido dentro del plugin no sirve: cada usuario tendría que crear su propia app. **[verificado]** (S1, S2, S3, S7)
- **Lo de los 25 Client IDs quedó resuelto:** lo dicen cuatro páginas oficiales de Spotify (apps, guía de migración, changelog y blog de julio de 2026). La cuota de Dev Mode pasó a contarse por cuenta de desarrollador, no por Client ID. **[verificado]** (S2, S3, S7, S10)
- **Endpoints:** los de Player, Search y `/me/playlists` sobrevivieron a feb-2026. Los de control dicen "only works for users who have Spotify Premium". `GET /me` ya no devuelve `product`, así que el plugin no puede saber si el usuario es Premium sin intentar un comando. **[verificado]** (S4, S28)
- **Cambio nuevo desde la nota previa:** los refresh tokens vencen a los 6 meses (apps existentes desde 2026-07-20). La conexión hay que renovarla dos veces por año. **[verificado]** (S9, S17)
- **Términos:** según las Developer Terms, controlar la reproducción con la Web API es "Streaming". Eso implica solo Premium, nada comercial, atribución con el logo de Spotify, link de vuelta, política de privacidad y botón de desconexión. El backend AppleScript no usa la Spotify Platform y no hereda esas obligaciones **[inferido]**. (S21, S22, S23, S24)
- **Host de Orca:** el worker tiene Node completo, así que puede hacer `fetch`, abrir un servidor en `127.0.0.1` y guardar tokens con `secrets.*`. El panel no tiene red, pero puede abrir el navegador con `orca.shell.openExternal` tras un click. Todo lo que pide PKCE existe hoy. Lo único que falta en una release es `contributes.settings` (para el Client ID): está en `main` desde 1.4.246, sin publicar. **[verificado]** (O1 a O9)
- **Polling:** la Web API no tiene push ni webhooks. El límite es una ventana móvil de 30 s con 429 y `Retry-After`, sin números publicados. Medido acá: `osascript` cuesta unos 45 ms por llamada; una llamada HTTPS a `api.spotify.com` tarda 260 a 420 ms. (S14, L2)
- **Web Playback SDK:** sigue inviable en Orca. La red de los frames está denegada a nivel de sesión y la app no trae Widevine. **[verificado]** (O4, S26, L2)
- **Recomendación:** la Web API **no** conviene como backend principal. AppleScript sigue como default. Sirve como **modo opcional avanzado, "traé tu propio Client ID"**, y solo si aparece demanda real de Linux/Windows o de controlar otro dispositivo. Diseño mínimo en 6.3.

---

## 1. Estado actual del acceso (nov-2026)

### 1.1 Development Mode vs Extended Quota

| Tema | Development Mode | Extended Quota Mode | Fuente |
| --- | --- | --- | --- |
| Estado inicial | Toda app nueva empieza acá | Hay que pedirlo | S1 [verificado] |
| Usuarios | "Up to 5 authenticated Spotify users", cada uno en el allowlist del dashboard | Ilimitados, el allowlist deja de aplicar | S1 [verificado] |
| Usuario fuera del allowlist | Puede loguearse, pero sus requests reciben 403 | n/a | S1 [verificado] |
| Premium | "The app owner must have a Spotify Premium account"; si la suscripción vence, la app deja de funcionar hasta que se renueve | No lo menciona la página | S1, S3 [verificado] |
| Client IDs por desarrollador | **25** desde julio de 2026 (antes 1) | La página de quota no menciona topes | S2, S3, S7, S10 [verificado] |
| Cuota de requests | Contada por cuenta de desarrollador; todos tus Client IDs en Dev Mode comparten un solo presupuesto. Los "buckets" y los números "are subject to change" y no se publican | "Higher rate limit" | S1, S7, S10 [verificado] |
| Endpoints | Conjunto reducido (S4) | Sin cambios, "no migration required" | S3 [verificado] |
| Pensado para | "Learning, experimentation, and personal projects for non-commercial use by individual developers" | Apps "ready for a wider audience" | S8, S1 [verificado] |

### 1.2 Los 25 Client IDs: resuelto

La nota previa lo dejó como [no verificado] con una sola fuente secundaria. Ahora hay cuatro primarias, leídas el 2026-11-01:

- S2 (guía "Apps"): "You can create up to 25 apps per developer account."
- S3 (guía de migración): la tabla sigue diciendo "Client IDs per developer: 1" para apps nuevas, y debajo aclara "As of July 2026, the Client IDs per developer limit has been increased to 25".
- S7 (changelog de julio de 2026): "[CHANGED] Client IDs per developer", "Increased from 1 to 25".
- S10 (blog del 2026-07-23): "Client ID limit increased from 1 to 25 per developer account."

Las dos fuentes que dicen "1" (S3, tabla, y S8, blog del 2026-02-06) son anteriores o están anotadas por las posteriores. No es una contradicción real. **Lo que sigue sin levantarse es el tope de 5 usuarios por Client ID.** [verificado]

Una consecuencia de los 25 Client IDs: no cambia nada para el plugin. Un Client ID compartido seguiría topado en 5 usuarios. Lo que sí hace es dejar a cada usuario crear su app sin pelearse con el límite de una por cuenta.

### 1.3 Qué pasó entre feb y nov de 2026

| Fecha | Cambio | Fuente |
| --- | --- | --- |
| 2026-02-06 | Anuncio: Dev Mode con Premium obligatorio, 1 Client ID, 5 usuarios, endpoints reducidos. Apps nuevas desde el 11-feb, existentes desde el 9-mar | S8 [verificado] |
| 2026-03-09 | Se posponen los cambios de endpoints para integraciones existentes. Premium, tope de usuarios y 1 Client ID siguen en pie. "Further details on updated timelines" sin fecha | S8 [verificado] |
| 2026-03 | Se revierte la baja de `external_ids` en Track y Album | S5 [verificado] |
| 2026-05 | Se agrega `account_id` a `GET /me` | S6 [verificado] |
| 2026-06-18 | Refresh tokens con vencimiento de 6 meses (apps nuevas ya, existentes desde 2026-07-20) | S9 [verificado] |
| 2026-07-23 | 25 Client IDs, cuota por cuenta, cuerpo `{"reason": "QUOTA_EXCEEDED"}` en los 429 por cuota | S7, S10 [verificado] |
| 2026-08-13 | Spotify Soloist, un cliente Connect headless con API WebSocket local (ver 4.3). Actualizado en octubre de 2026: ya hay builds para macOS y Windows | S11 [verificado] |

No encontré cambios publicados entre el 30-oct y el 1-nov. La última fecha del RSS del blog es el 2026-10-26 y el post más nuevo es del 13-ago (S32) [verificado que no hay posts más nuevos; no puedo descartar un cambio sin anuncio]. El índice `/documentation/web-api/changelog` devuelve 404; los changelogs están enlazados en la navegación como julio, mayo, marzo y febrero de 2026 (S1, navegación) y los leí a todos.

### 1.4 Extended Quota: proceso y requisitos

Todo de S1 [verificado], salvo lo indicado:

1. Desde el 2025-05-15 Spotify "only accepts applications from organizations (not individuals)". La solicitud va por el formulario de "Partner Application", desde un mail de empresa.
2. Requisitos listados: entidad legal registrada, "active, and Launched Service", **al menos 250k MAU**, disponibilidad en los mercados clave de Spotify, "Commercial Viability" y cumplimiento de los términos.
3. Si el formulario se aprueba, desde el dashboard se pide el pase en la pestaña "Quota extension Request" con un cuestionario de 4 pasos. La revisión "can take up to six weeks".
4. El blog de abril de 2025 dice que el acceso extendido queda reservado para casos "established, scalable, and impactful" que ayuden a la estrategia de la plataforma y al descubrimiento de artistas (S12). La Developer Policy agrega que Spotify "makes no guarantees or promises on processing times, or that such extended access request will be approved" (S22, VII).

Un plugin open source gratuito no cumple ninguno de esos requisitos [inferido]. Extended Quota no es una salida.

### 1.5 Developer Terms y Developer Policy

Developer Terms versión 10, vigente desde el 15-may-2025; Developer Policy, misma fecha (S21, S22). Cláusulas que importan para este plugin:

| Tema | Qué dice | Consecuencia para el plugin | Fuente |
| --- | --- | --- | --- |
| Qué es "Streaming" | "using the Spotify Platform to enable playback of sound recordings … including using the Spotify Platform to control a background Spotify application" | El backend Web API es un "Streaming SDA". La página de Compliance Tips lista como streaming a las apps que usan `/me/player/play`, `/next`, `/previous` o "any other Spotify API or SDK to control playback" | S21 (II), S23 [verificado] |
| Solo Premium | "Streaming of music sound recordings through the Spotify Platform shall only be made available to subscribers to the Premium Spotify Service" | Los usuarios Free quedan fuera. Coincide con el 403 esperable en los comandos | S22 (IV) [verificado] |
| Comercial | Los Streaming SDAs no pueden tener uso comercial (venta, anuncios, e-commerce) | El plugin es MIT y gratis, así que cumple. Orca ya exige plugins gratuitos (O5, L7-12) | S22 (IV) [verificado] |
| Uso permitido | Licencia "for private personal use" | Encaja con "cada uno usa su propia app" | S21 (III.1) [verificado]; encaje [inferido] |
| Credenciales | "You must use a separate Security Code for each SDA"; el código debe estar embebido "in a secure manner not accessible by third parties"; no se puede "disclose your account or Security Codes to any other party" | Publicar un Client ID en el repo y que lo use todo el mundo choca con esto como mínimo en el espíritu. Además el tope de 5 usuarios lo vuelve inútil | S21 (VI), S22 (VII) [verificado]; lectura sobre el Client ID público [inferido] |
| Atribución | Todo metadato o carátula de Spotify lleva el logo de Spotify y "a link back" al contenido. La carátula no se recorta ni se modifica; sí se puede cambiar el tamaño | El panel tendría que mostrar el logo y un link a Spotify cuando use datos de la Web API | S22 (II), S24, S23, S21 (IV, 60) [verificado] |
| Privacidad | Política de privacidad que describa el uso de datos, y "easily accessible mechanism to disconnect their Spotify account" | Botón "Desconectar" que borre los tokens, y una sección de privacidad en el README | S22 (I) [verificado] |
| Copiar la experiencia de Spotify | Prohíbe productos que "mimic, or replicate or attempt to replace a core user experience of Spotify", salvo que "add independent value" | Un control remoto dentro de un IDE debería pasar, pero la cláusula es subjetiva | S22 (III) [verificado]; juicio [inferido] |
| Nombre | El nombre "should not begin with 'Spot'" ni sugerir respaldo | "Now Playing" cumple | S22 (VI) [verificado] |
| Cambios | Spotify puede limitar llamadas y modificar la plataforma "without notice" | Riesgo de política permanente | S21 (VI) [verificado] |
| Open source | Los Terms no tratan la distribución de código open source de un cliente de la API (solo mencionan software open source incluido dentro de la Platform). Regulan distribuir "the Spotify Platform … only in binary form as part of an SDA" | No encontré una cláusula que prohíba publicar el código de un cliente de la API. Conviene no incluir SDKs de Spotify (usar `fetch` directo) | S21 (III) [verificado que no hay mención]; recomendación [inferido] |

**Dos fuentes primarias en tensión, sin elegir una:** las guías de diseño de Spotify exigen atribuir con el logo ("it must always be accompanied by the Spotify brand", S24), y la política de listado de Orca prohíbe usar "another … product's name, logo or brand in a way that suggests they made or endorse your plugin" (O5, L20-23). No son contradictorias si el logo se usa como atribución y no como identidad del plugin, pero el criterio final es de cada parte y no está resuelto [inferido].

**Sobre AppleScript:** el backend actual lee datos de la app de escritorio sin pasar por la Spotify Platform, así que las Developer Terms no parecen aplicar **[inferido]**. Los Terms de uso de Spotify para el usuario no los revisé.

### 1.6 Qué implica para el usuario final

Con un Client ID propio, el usuario es a la vez dueño de la app y único usuario (1 de 5). Eso resuelve el tope de usuarios y el de Client IDs, y deja la cuota por cuenta repartida solo entre sus propias apps. Lo que no se evita: Premium obligatorio, crear la app en el dashboard y aceptar los Developer Terms al hacerlo (S2), y re-loguearse cada 6 meses.

---

## 2. Endpoints y disponibilidad en Dev Mode

Disponibilidad: todos aparecen en "Endpoints still available" del changelog de feb-2026 (S4) [verificado]. Ese changelog describe el conjunto reducido que rige para apps nuevas; el aplazamiento del 9-mar solo toca a integraciones ya existentes (S8). Scopes y marca de Premium vienen de la página de referencia de cada endpoint (S28), leída el 2026-11-01.

| Endpoint | Scope | ¿Premium? | Campos de respuesta o parámetros útiles | Relación con AppleScript |
| --- | --- | --- | --- | --- |
| Get Playback State `GET /me/player` | `user-read-playback-state` | La página no lo dice | `is_playing`, `progress_ms`, `timestamp`, `item` (`name`, `artists[]`, `album.name`, `album.images[]`, `duration_ms`, `uri`), `device` (`name`, `type`, `volume_percent`, `supports_volume`, `is_active`, `is_restricted`), `shuffle_state`, `repeat_state` (`off`, `track`, `context`), `context`, `actions`, `currently_playing_type`. Responde 200 o 204 | Reemplaza el estado completo, con agregados (device, repeat de 3 valores, `actions`). No distingue "Spotify cerrado" de "sin dispositivo activo" |
| Get Currently Playing `GET /me/player/currently-playing` | `user-read-currently-playing` | La página no lo dice | Mismo cuerpo que el anterior | Redundante. Solo sirve para pedir un scope menor |
| Start/Resume `PUT /me/player/play` | `user-modify-playback-state` | **Sí** ("only works for users who have Spotify Premium") | Cuerpo: `context_uri`, `uris`, `offset`, `position_ms`; query `device_id` | Reemplaza `play`. También cubre tocar una URI y agrega contextos (álbum, playlist) |
| Pause `PUT /me/player/pause` | `user-modify-playback-state` | **Sí** | `device_id` | Reemplaza `pause` |
| Skip To Next `POST /me/player/next` | `user-modify-playback-state` | **Sí** | `device_id` | Reemplaza `next track` |
| Skip To Previous `POST /me/player/previous` | `user-modify-playback-state` | **Sí** | `device_id` | Reemplaza `previous track` |
| Seek `PUT /me/player/seek` | `user-modify-playback-state` | **Sí** | `position_ms` (entero, requerido) | Reemplaza `set player position`, con precisión de ms en vez de segundos enteros |
| Set Volume `PUT /me/player/volume` | `user-modify-playback-state` | **Sí** | `volume_percent` 0 a 100; hay que mirar `device.supports_volume` | Reemplaza `set sound volume` si el dispositivo lo soporta |
| Toggle Shuffle `PUT /me/player/shuffle` | `user-modify-playback-state` | **Sí** | `state` booleano (fija, no alterna) | Reemplaza `set shuffling` |
| Set Repeat `PUT /me/player/repeat` | `user-modify-playback-state` | **Sí** | `state` = `track`, `context` u `off` | AppleScript tiene un booleano; la Web API tiene tres estados |
| Get Available Devices `GET /me/player/devices` | `user-read-playback-state` | La página no lo dice | `id`, `name`, `type`, `is_active`, `volume_percent`, `supports_volume`. "Some device models are not supported and will not be listed" | **Nuevo** |
| Transfer Playback `PUT /me/player` | `user-modify-playback-state` | **Sí** | `device_ids` (solo uno), `play` | **Nuevo** |
| Search `GET /search` | La página no lista scopes | La página no lo dice | `q`, `type`, `limit` 0 a 10 (default 5, antes 50 y 20), `offset` 0 a 1000 | **Nuevo** (AppleScript no busca) |
| Playlists `GET /me/playlists` | `playlist-read-private` | La página no lo dice | `limit` 1 a 50. `GET /playlists/{id}/items` solo devuelve el contenido de playlists propias o colaborativas (S3, S4) | **Nuevo**. Para tocar una, `PUT /play` con `context_uri` |
| Get Queue `GET /me/player/queue` | `user-read-currently-playing` y `user-read-playback-state` | La página no lo dice | `currently_playing`, `queue` | **Nuevo** |
| Add to Queue `POST /me/player/queue` | `user-modify-playback-state` | **Sí** | `uri` (track o episodio), `device_id` | **Nuevo** |

Todo [verificado] (S28, S4), salvo lo marcado como "la página no lo dice", que es la ausencia de la frase en la referencia y no prueba que una cuenta Free pueda leer el estado **[inferido]**.

### 2.1 Qué hay que tener presente

- **Todas las páginas de control advierten:** "The order of execution is not guaranteed when you use this API with other Player API endpoints." Es el mismo problema que hoy resuelve `src/settle.mjs` (relee hasta ver el cambio). Hay que mantenerlo [verificado].
- **No existe un toggle de play/pause.** Hay que leer `is_playing` y mandar `play` o `pause`. Agrega una lectura y una carrera entre dos clientes [inferido].
- **Sin dispositivo activo.** `GET /me/player` puede dar 204, y los comandos apuntan al "currently active device" si no se pasa `device_id`. Con Spotify abierto pero inactivo hay que transferir antes (S28). Los códigos de error de ese caso no están documentados en las páginas de referencia, que solo listan 204/401/403/429 [no verificado el 404 `NO_ACTIVE_DEVICE` ni el 403 `PREMIUM_REQUIRED` que la API real suele devolver].
- **No hay "abrir Spotify".** La Web API solo ve dispositivos ya abiertos. `open -a Spotify` (backends/applescript.mjs L136-141) no tiene equivalente.
- **Premium ya no se puede consultar:** `product` salió de `GET /me` (S4, User). Los usuarios Free se enteran por el error del primer comando [verificado].
- **Carátula:** `item.album.images[]`, "widest first", URLs en `i.scdn.co`. El panel sigue sin poder cargar imágenes remotas, así que el worker las baja y las pasa como `data:` igual que hoy (`src/panel-protocol.mjs` L21-33, L54-58) [verificado en L1]. Con la Web API se elige el tamaño del arreglo en vez de reescribir el id de la URL (`panel-protocol.mjs` L11-18).
- **Estado de `repeat`.** `panel/index.html` L373 y L468-469 y `backends/applescript.mjs` L15, L33 manejan un booleano. La Web API pide un ciclo `off` → `context` → `track` [verificado en L1].
- **La documentación de Spotify está desprolija.** Los ejemplos de respuesta de la referencia todavía incluyen `popularity`, `available_markets` y `linked_from`, que el changelog de feb-2026 marca como removidos (S28 contra S4). La página de scopes lista "Get the User's Currently Playing Track" bajo `user-read-playback-state`, con un link a `get-recently-played`, mientras que la referencia del endpoint exige `user-read-currently-playing` (S18 contra S28). La página de rate limits todavía recomienda "Get Multiple Albums", que ya no existe (S14 contra S4). Tomo el changelog y la página de cada endpoint como fuente de verdad. Pedir los dos scopes de lectura evita la ambigüedad.

### 2.2 Capacidad por capacidad contra el backend actual

| Capacidad (backend actual) | Web API | ¿1:1? |
| --- | --- | --- |
| Estado: título, artista, álbum, duración, posición, URI (`STATE_SCRIPT`, applescript.mjs L10-24) | `GET /me/player`. `artist of t` es un solo texto; acá son `artists[]` | Sí |
| Estado `closed` si Spotify no corre (L11) | No existe. Hay `204` o `is_playing: false` | No |
| Carátula (`artwork url`) | `item.album.images[]` | Sí |
| Volumen (`sound volume`) | `device.volume_percent`; fijar con `PUT /volume`; depende de `supports_volume` | Sí, condicionado |
| Shuffle (booleano, alterna) | `shuffle_state` y `PUT /shuffle?state=` | Sí |
| Repeat (booleano) | `repeat_state` de 3 valores | No, la Web API es más rica |
| Seek en segundos enteros (L41-48) | `position_ms` | Sí, más fino |
| playpause, play, pause, next, previous | Endpoints propios; `playpause` se arma con una lectura | Sí |
| `open` | Sin equivalente | No |
| Dispositivos, transferir, cola, búsqueda, playlists | Todos disponibles | Solo la Web API |

---

## 3. Autenticación para un plugin de escritorio

### 3.1 Flujo y reglas vigentes

Todo [verificado], leído el 2026-11-01.

- **Flujo:** Authorization Code con PKCE. Es el recomendado cuando "the client secret can't be safely stored", p. ej. apps de escritorio (S16, S19). No hay client secret.
- **Pasos** (S16): generar `code_verifier` de 43 a 128 caracteres; `code_challenge` = SHA-256 en base64url; abrir `https://accounts.spotify.com/authorize` con `client_id`, `response_type=code`, `redirect_uri`, `code_challenge_method=S256`, `code_challenge`, `scope` y `state`; recibir `code` en el redirect; `POST https://accounts.spotify.com/api/token` (`application/x-www-form-urlencoded`) con `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`.
- **Redirect URI** (S15, S13):
  - HTTPS siempre, salvo loopback, donde HTTP está permitido.
  - Loopback con IP literal: `http://127.0.0.1:PORT` o `http://[::1]:PORT`. **`localhost` no está permitido.**
  - Debe coincidir exactamente con lo registrado, con una excepción: "for loopback IP literals, which can dynamically be assigned ports". Si el puerto no se conoce, se registra la URI sin puerto y el puerto se agrega en la request de autorización.
  - Reglas obligatorias para apps nuevas desde el 2025-04-09; migración de las existentes hasta noviembre de 2025 (el post de recordatorio "OAuth Migration - 27 November 2025" figura en el índice del blog, S32).
  - Los esquemas custom (`com.ejemplo://callback`) siguen aceptados (S13), pero Orca no ofrece registrar un protocolo para plugins [inferido], así que no sirven.
- **Dos páginas de Spotify, dos estilos:** S15 manda registrar la URI loopback **sin puerto**, y los ejemplos de S2 y S16 usan `http://127.0.0.1:8080`. Si el dashboard acepta la URI sin puerto no lo pude comprobar [no verificado]. Plan B: puerto fijo registrado.
- **Tokens** (S16, S17, S9):
  - El access token dura 1 hora (`expires_in: 3600`).
  - El refresh puede devolver o no un refresh token nuevo; si no lo devuelve, se sigue con el viejo.
  - **El refresh token vence a los 6 meses** de la autorización original; refrescar no lo extiende. Al vencer, el endpoint de token responde 400 `invalid_grant`. La guía manda descartar el token y volver a autorizar, sin reintentar el refresh.
  - Los refresh tokens no exponen fecha de emisión; hay que guardar `authorized_at`.
  - Los scopes ya otorgados se conservan al re-autorizar si se piden los mismos.

### 3.2 Scopes mínimos

| Función | Scope |
| --- | --- |
| Leer estado, dispositivos | `user-read-playback-state` |
| Play, pause, next, previous, seek, volumen, shuffle, repeat, transferir, cola | `user-modify-playback-state` |
| Endpoint `currently-playing` o cola | `user-read-currently-playing` (opcional, ver 2.1) |
| Listar playlists (fase posterior) | `playlist-read-private` |

Para la primera versión alcanzan los dos primeros. Spotify pide no solicitar scopes "on the basis that your app might include a feature later" (S23) [verificado].

### 3.3 Qué ofrece el host de Orca

Fuentes: docs y código de `stablyai/orca`, rama `main`, commit `225db8c`.

| Necesidad | Qué hay | Cita | Marca |
| --- | --- | --- | --- |
| **Red saliente desde el worker** | `main` corre en un proceso Node aparte con "every host method its `capabilities` allow"; es "full-access". El proceso se forkea sin flags de permisos (`execArgv: []`) y con `ELECTRON_RUN_AS_NODE`. La lista de capacidades no tiene ninguna de red | O2 L58-61; O6 L59-66; O7 L44; O3 L196 | [verificado] que no hay un control de red; que `fetch` salga a Internet en tiempo de ejecución es [inferido] (no lo ejecuté; el worker actual ya hace `fetch` a `i.scdn.co`, `src/panel-protocol.mjs` L26) |
| **Entorno del worker** | Allowlist de variables: `PATH`, `HOME`, `LANG`, `TZ`, `TMPDIR`, etc. Sin `HTTP_PROXY` ni `HTTPS_PROXY` | O7 L3-22 | [verificado]. Quien dependa de un proxy por variables de entorno puede quedar sin salida [inferido] |
| **Servidor local (loopback)** | Un worker Node puede usar `node:http`. Ningún doc lo prohíbe | O2 L58-61 | [inferido] |
| **Abrir el navegador** | `shell.openExternal` existe solo para panel y editor, no para el worker. Exige un click o tecla en el frame (activación transitoria de "unos segundos") y Orca pregunta la primera vez por cada host (`accounts.spotify.com`) con "Always allow". Un worker puede ejecutar `open` por `child_process`, como ya hace con `/usr/bin/open -a Spotify` | O1 L9, L28; O4 L118-123; backends/applescript.mjs L137 | [verificado] la API; el `open` del worker para una URL es [inferido] |
| **Panel sin red** | Los frames corren aislados, con la red "denegada a nivel de sesión": `webRequest` cancela todo lo que no sea el origen del plugin, `data:` o `blob:` | O2 L112-123; O4 L22-39 | [verificado] |
| **Panel ↔ worker** | `plugin.request` (panel pregunta, worker responde con `orca.panels.handle`) y `orca.panels.post` (worker empuja). Límites: entrada 64 KiB, respuesta 1 MiB, timeout por defecto 30 s y máximo 120 s, posts de hasta 256 KiB y 200 cada 10 s | O1 L30; O2 L193-239 | [verificado]. El plugin actual ya usa `plugin.request` (panel/index.html L411) |
| **Secretos** | `secrets.get/set/delete/protection` con capacidad `secrets:own`, disponibles para worker y panel. Se cifran con `safeStorage` de Electron (keyring del SO). En Linux con backend `basic_text` `secrets.set` **falla** a propósito y avisa que hay que instalar gnome-keyring o kwallet | O1 L22-25; O9 L83-102 | [verificado] |
| **Almacenamiento y settings** | `storage.*` (`storage:own`). `contributes.settings` y `settings.*` (`settings:own`) con campos declarados en Settings: **Since 1.4.246**, todavía sin release publicada | O1 L18-21, L26-27; O3 L45; O2 L254-267 | [verificado]. Para ≤1.4.245 el Client ID tendría que ir en `storage` con un campo en el panel |
| **Ciclo de vida del worker** | Se detiene a los 5 minutos sin actividad (`PLUGIN_WORKER_IDLE_REAP_MS`) y arranca de nuevo con el siguiente comando, evento o request del panel. Cada respuesta y cada llamada al host cuentan como actividad. El modelo de procesos de worker figura como **experimental** | O8 L98; O6 L152-175, L193, L259; O2 L136-141, L603-606 | [verificado]. Que un panel haciendo `plugin.request` mantenga vivo al worker es [inferido] |
| **Cambio de capacidades** | Si una actualización pide una capacidad nueva (`secrets:own`, `settings:own`), no se instala sola y el plugin muestra "Update needs review" | O2 L561-565 | [verificado] |
| **Login hecho por el host** | `contributes.connections` está reservado, "Account providers with a host-run sign-in, so a plugin never handles credentials itself". Hoy debe ir vacío | O3 L51, L217, L224 | [verificado] que está planeado y sin formato; vigilarlo |

---

## 4. Polling, rate limits y latencia

### 4.1 Cómo limita Spotify

- **Rate limit:** se calcula sobre las llamadas de la app "in a rolling 30 second window". Al pasarse, 429. El header `Retry-After` viene "normally" en segundos. El límite es distinto en Dev Mode y en Extended Quota. **La página no publica ningún número.** Hay endpoints con límites propios (p. ej. subir imagen de playlist) (S14) [verificado].
- **Cuota de Dev Mode:** es otro mecanismo, con "quota buckets" por grupo de endpoints, contada por cuenta de desarrollador desde julio de 2026. Cuando se excede, 429 con cuerpo `{"error": {"status": 429, "message": "Too many requests", "reason": "QUOTA_EXCEEDED"}}` (S1, S7). El campo `reason` es la única forma documentada de distinguir cuota de rate limit (S20 lista `QUOTA_EXCEEDED` como único valor) [verificado]. Si ese 429 trae `Retry-After` no lo dicen [no verificado].
- La guía de migración recomienda "Limit API calls to avoid hitting rate limits" para Dev Mode (S3) [verificado].
- Las respuestas llevan `ETag` y la guía manda usar `If-None-Match` (304) (S20). Si un 304 cuenta para el límite no está documentado [no verificado].

### 4.2 Frecuencia razonable para un panel con barra de progreso

El panel actual pollea cada **1 s** con la ventana visible y cada **4 s** oculta (`panel/index.html` L280-281), e interpola la posición cada 200 ms (L329-335, L496). Con osascript eso cuesta un spawn local por segundo. Con la Web API serían 30 requests por ventana de 30 s, compartidas con todas las apps del mismo desarrollador, contra un límite que no conocemos.

Propuesta de diseño, con números elegidos por mí **[inferido]**; ninguno sale de Spotify:

| Situación | Intervalo | Requests por 30 s |
| --- | --- | --- |
| Panel visible, reproduciendo | 5 s, con la barra interpolada localmente | 6 |
| Panel visible, en pausa | 10 s | 3 |
| Panel oculto o worker sin panel | 30 s o detener el polling | 0 a 1 |
| Después de un comando propio | 1 lectura inmediata y hasta 2 reintentos a ~400 ms hasta que se vea el cambio (hoy `settle.mjs` reintenta 6 veces cada 80 ms) | 3 como máximo por comando |
| Fin de pista | Programar una lectura en `duration_ms - progress_ms + 500 ms` | 1 |
| 429 | Esperar `Retry-After`. Sin header: backoff 2, 4, 8… hasta 60 s. Con `QUOTA_EXCEEDED`: pausa larga (1 a 10 min) y aviso en el panel | 0 |

La posición interpolada se calcula con `progress_ms` más el tiempo local desde que llegó la respuesta, como ya hace `positionNow()`. El `timestamp` de la respuesta indica cuándo cambió el estado en Spotify, no la hora de la lectura [verificado en S28].

### 4.3 ¿Hay push o webhooks?

- **Web API: no.** Ni los conceptos (Access Token, API calls, Apps, Authorization, Redirect URIs, Playlists, Quota modes, Rate limits, Scopes, URIs and IDs, Track Relinking) ni la referencia mencionan webhooks, WebSocket o suscripciones. Es ausencia en la navegación y en las páginas leídas (S1, S14, S20, S3) [verificado que no figura; no puedo probar que no exista algo no documentado].
- **Web Playback SDK:** emite `player_state_changed`, pero solo para el dispositivo que crea el propio SDK en el navegador (S26), que no es viable acá (sección 5).
- **Spotify Soloist (nuevo, ago-2026):** es un receptor Spotify Connect headless con servidor WebSocket local opcional (`--ws 127.0.0.1:9090`) que emite eventos de reproducción y acepta comandos. El WebSocket "has no built-in client authentication" ni TLS ni validación de Origin (S29, S11, S31) [verificado]. Es **otro reproductor** que suena por sí mismo, no un control remoto de la app de escritorio. Para armarlo hace falta Premium, una API key del dashboard y no se pueden redistribuir sus binarios (S30). No reemplaza ni a AppleScript ni a la Web API para este plugin. Queda como pista para el caso de quien no use la app de escritorio.

### 4.4 Comparación con AppleScript

Medido en esta máquina el 2026-11-01 (macOS, `Darwin 27.0.0`), con Spotify abierto (L2):

| Medición | Resultado |
| --- | --- |
| `osascript -e 'return 1'`, 20 corridas, spawn y salida | mín 40,7 ms, mediana 44,9 ms, máx 72,2 ms |
| Script con `application "Spotify" is not running` (no manda un Apple Event a Spotify), 20 corridas | mín 41,6 ms, mediana 46,4 ms, máx 75,6 ms |
| `GET https://api.spotify.com/v1/me/player` **sin token** (401), 5 corridas con conexión nueva | conexión TCP 28 a 41 ms, TLS completo a los 57 a 76 ms desde el inicio (la primera corrida, 227 ms), tiempo hasta el primer byte 260 a 424 ms |

Lectura **[inferido]**: cada `osascript` es casi todo costo de lanzar el proceso (~45 ms), sin red. El `STATE_SCRIPT` real, que sí manda un Apple Event a Spotify, **no lo medí** para no disparar el aviso de permisos de macOS [no medido]. Una llamada HTTPS tarda un orden de magnitud más. La medición sin token incluye al edge de Spotify pero no al backend autenticado, así que la cifra real de una llamada con token puede ser mayor [no medido]. Reutilizar la conexión (keep-alive) ahorra el DNS y el TLS, no el tiempo hasta el primer byte.

---

## 5. Web Playback SDK

Veredicto: **sin cambios, sigue inviable.** Ver la [nota previa, 2.1](./orca-plugins-spotify.md#21-spotify-web-playback-sdk-el-panel-sería-el-reproductor). Evidencia actualizada, leída el 2026-11-01:

| Punto | Evidencia | Marca |
| --- | --- | --- |
| El SDK necesita navegador con EME | Doc oficial: soportado en "Chrome, Firefox, Safari and Microsoft Edge", sin mencionar Electron. El evento `initialization_error` se emite "most likely due to the browser not supporting EME protection" | S25, S26 [verificado] |
| Necesita cargar un script remoto | El tutorial usa `<script src="https://sdk.scdn.co/spotify-player.js">` | S27 [verificado] |
| El frame de Orca no puede cargarlo | La CSP ahora es `default-src 'self' … connect-src 'self' data: blob:; frame-src 'none'` **y** la red se corta en la sesión: `webRequest.onBeforeRequest` cancela toda URL que no sea el origen del plugin, `data:`, `blob:` o `devtools:`, y hay un proxy loopback que descarta las conexiones. El mecanismo cambió respecto de la nota previa (iframe `srcdoc` con CSP `default-src 'none'; connect-src 'none'`): ahora el frame es un `<webview>` aislado con origen propio y la red se corta en la sesión. Para el SDK el resultado es el mismo | O4 L22-39 [verificado] |
| Orca no trae Widevine | Electron 43.8.4 en `main`, sin castLabs. No hay ningún archivo `*widevine*` dentro de `/Applications/Orca.app`, y la búsqueda de código en `stablyai/orca` por "widevine" da 0 resultados | O10 L320; L2 [verificado]. La búsqueda de GitHub puede estar incompleta |
| Un worker tampoco sirve | Es Node sin DOM ni EME | [inferido] |
| Términos | Premium y "must not be used in commercial projects without Spotify's prior written approval" | S25 [verificado] |

---

## 6. Comparación y recomendación

### 6.1 AppleScript vs Web API

| Criterio | AppleScript (hoy) | Web API |
| --- | --- | --- |
| Instalación | Un paso: Git URL y aprobar el plugin. macOS pide permiso de Automatización una vez [inferido, nota previa] | Lo mismo, más: crear una app en el dashboard, registrar un redirect URI, pegar el Client ID y loguearse en el navegador |
| Fricción para el usuario final | Baja. 4 pasos en el README | Alta. Unos 9 pasos (ver 6.3) y una renovación de login cada 6 meses |
| Premium | No hace falta [inferido, no probado con Free] | **Sí**: dueño de la app (S3) y comandos de control (S28) |
| Multiplataforma | Solo macOS (`backends/applescript.mjs` L61, L124) | macOS, Linux y Windows: corre en el worker |
| Qué controla | La app de escritorio local, si está abierta | El dispositivo Connect activo de la cuenta (celular, parlante, otra PC) |
| Capacidades | Estado, carátula, play/pause/next/previous, volumen, shuffle, repeat booleano, seek, abrir Spotify | Las mismas salvo abrir, más dispositivos, transferir, cola, búsqueda (máx 10), playlists propias y repeat de 3 estados |
| Dependencia de red | Ninguna (salvo bajar la carátula) | Total: cada lectura y cada comando |
| Latencia por llamada | ~45 ms (medido, spawn) | ~260 a 420 ms (medido sin token) |
| Límites | Ninguno externo | Ventana de 30 s y cuota de Dev Mode por cuenta, sin números |
| Riesgo de cambios de política | Bajo. Depende del diccionario AppleScript de la app, que Spotify podría recortar [inferido] | **Alto.** Al menos cuatro cambios de reglas publicados desde nov-2025 (migración OAuth 27-nov-2025, feb-2026, jun-2026, jul-2026) y los Terms permiten cambiar la plataforma "without notice" (S21 VI, S32) |
| Developer Terms | No aplican [inferido] | Aplican, como Streaming SDA: atribución con logo, privacidad, desconexión |
| Credenciales | Ninguna | Client ID propio, tokens que vencen |
| Mantenimiento | Bajo | Medio a alto: login, refresh, errores 401/403/404/429, UI de conexión |

### 6.2 Recomendación

**La Web API no conviene como backend principal. AppleScript sigue siendo el default. La Web API tiene sentido como modo opcional "avanzado", y solo cuando haya un motivo concreto.**

Por qué no como principal:

1. **No se puede entregar un Client ID.** Con 5 usuarios por Client ID y Extended Quota fuera de alcance (S1), todo usuario tiene que crear su app, con Premium. Eso convierte la instalación de un paso en una de nueve.
2. **El caso de uso actual ya está cubierto.** Hoy el plugin controla la app de escritorio en macOS sin login, sin Premium y sin red. La Web API no le agrega nada a ese caso, y le suma latencia, límites y un login que vence.
3. **Riesgo de política alto y creciente.** Dev Mode se declaró "for non-commercial use by individual developers" (S8) y las reglas cambiaron cuatro veces en un año.
4. **Obligaciones de las Developer Terms** que hoy el plugin no tiene: logo de Spotify, link de vuelta, política de privacidad y botón de desconexión (S22, S24).

Por qué sí como opcional:

- Es la única vía a **Linux y Windows**, donde el plugin hoy responde "unsupported" (`backends/applescript.mjs` L61, L124). Para Linux hay otra ruta que no investigué (MPRIS por D-Bus) [no verificado].
- Es la única forma de controlar **otro dispositivo** (celular, parlante) y de agregar búsqueda, cola y playlists.
- Todo lo que necesita ya existe en el host de Orca (3.3), y el código actual está casi listo para aceptar un segundo backend: `createCommands(spotify)` y `createPanelHandlers(spotify)` solo piden `getState()` y `command(name, value)` (`src/commands.mjs`, `src/panel-protocol.mjs`). El acoplamiento que queda es que ambos importan `COMMAND_NAMES`, `MESSAGES` y `classifyError` desde `backends/applescript.mjs` (`src/commands.mjs` L3, `src/panel-protocol.mjs` L7) [verificado en L1].

**Cuándo construirlo:** si alguien pide Linux o Windows, o controlar otro dispositivo. Hasta entonces, no. Si se construye, debe ser opt-in y estar descrito en el README como "requiere Premium y tu propia app de Spotify".

### 6.3 Diseño mínimo del modo opcional

Sin implementación; solo las decisiones.

**Interfaz de backend común.** Cada backend expone lo mismo que el actual y declara qué soporta, para que el panel esconda lo que no existe:

```
Backend {
  id                       // 'applescript' o 'webapi'
  capabilities             // { seek, volume, repeatModes: 2 o 3, devices, search, queue, needsLogin }
  getState()               // estado normalizado, ver abajo
  command(name, value)     // false si no hay a quién mandárselo (Spotify cerrado o sin dispositivo)
}
Estado normalizado = el actual (status, volume, shuffle, track, positionMs)
  + repeat: 'off' | 'context' | 'track'      // AppleScript: booleano mapeado a off/context
  + device?: { name, type, supportsVolume }
  + status extra: 'unauthenticated', 'no-device', 'rate-limited'
```

Mover `COMMAND_NAMES`, `MESSAGES` y `classifyError` a un módulo compartido. `settle.mjs` se reutiliza tal cual (el orden de ejecución tampoco está garantizado en la Web API).

**Selección de backend.** Un setting `backend` con `auto`, `applescript` y `webapi`. `auto` usa AppleScript en macOS y Web API si hay Client ID configurado en otro caso. Cambiar de backend reinicia el estado del panel.

**Dónde vive el Client ID.** No va en el repo (S21 VI). Es un identificador público en un cliente PKCE, no un secreto. Con Orca ≥1.4.246 (cuando se publique), un setting declarado en `contributes.settings` (`settings:own`); para ≤1.4.245, un campo en el panel que escribe en `storage`. Los tokens van siempre a `secrets.set` (`secrets:own`), como un solo JSON `{access_token, expires_at, refresh_token, authorized_at}`. Antes de guardar, `secrets.protection` debe responder `os-keyring`; si responde `unavailable` (Linux sin keyring), avisar que la conexión no se podrá recordar. Agregar `secrets:own` y `settings:own` al manifest obliga a una re-aprobación del usuario (O2 L561-565).

**Flujo de login.**
1. El panel muestra "Conectar con Spotify" cuando el estado es `unauthenticated`.
2. Al renderizar esa pantalla, el panel pide `auth.start` al worker. El worker genera `code_verifier`, `state` y el `code_challenge`, abre un servidor `http` en `127.0.0.1` con puerto efímero (o fijo, si el dashboard no acepta la URI sin puerto) y devuelve la URL de `accounts.spotify.com/authorize` con los dos scopes de 3.2.
3. En el click, el panel llama `orca.shell.openExternal(url)` de forma síncrona. Se arma la URL antes del click porque la activación transitoria dura solo unos segundos (O1 L9). Orca pregunta una vez por `accounts.spotify.com`. Alternativa: que el worker abra la URL con `open`.
4. El servidor recibe `/callback?code=…&state=…`, valida `state`, cambia el `code` por tokens y se cierra a la primera request o a los ~2 minutos. Responde una página mínima de "ya podés volver a Orca".
5. El panel espera con `auth.status` y pasa al estado normal. El worker no deja el servidor abierto fuera del login.
6. Botón "Desconectar": borra los secretos (obligación de la Policy, S22 I).

**Token vencido.**
- Antes de cada llamada, si falta menos de 60 s para `expires_at`, refrescar con una promesa única compartida (que dos polls no refresquen a la vez).
- Si la respuesta guarda un `refresh_token` nuevo, reemplazar el viejo; si no, conservar el viejo.
- Un 401 de la API: un refresh y un único reintento. Si vuelve a dar 401, pasar a `unauthenticated`.
- `invalid_grant` al refrescar: borrar los secretos, pasar a `unauthenticated` y **no** reintentar (S9, S17).
- Con `authorized_at`, avisar desde el mes 5 que la conexión vence pronto.

**Manejo de 429 y de errores.**
- 429: leer `Retry-After` (segundos) y bloquear nuevas requests hasta ese momento. Mientras tanto devolver el último estado con `stale: true` y la hora de reintento al panel; `panel/index.html` ya sabe reprogramar con `retryAfterMs` (L404) [verificado en L1].
- Si el cuerpo trae `reason: "QUOTA_EXCEEDED"`: no es rate limit; pausa larga, mensaje propio ("la cuota de tu app de Spotify se agotó") y sin reintentos automáticos agresivos.
- 403: puede ser usuario fuera del allowlist o falta de Premium; mostrar un mensaje que mencione las dos causas, porque el cuerpo no está documentado [no verificado].
- 204 o sin dispositivo activo: estado `no-device`, con la lista de dispositivos y "Transferir acá".

**Pasos del usuario final (lo que habría que documentar en el README).**
1. Tener Spotify Premium.
2. Crear una app en el dashboard de Spotify for Developers y aceptar los Developer Terms.
3. Registrar el redirect URI loopback en la app (ver 3.1 y pendiente 3).
4. Copiar el Client ID.
5. Instalar el plugin (igual que hoy) y pegar el Client ID en Settings o en el panel.
6. Elegir el backend Web API.
7. Tocar "Conectar con Spotify", aprobar el aviso de Orca para `accounts.spotify.com` y aceptar los permisos en Spotify.
8. Tener algún dispositivo Spotify abierto.
9. Repetir el paso 7 cada 6 meses.

**Cambios en el panel solo para este backend:** pantalla de conexión, chip de dispositivo, repeat de 3 estados, logo de Spotify con link a la pista (atribución), enlace "Open in Spotify" y política de privacidad.

---

## 7. Pendientes y riesgos sin verificar

Heredados de la nota previa y todavía abiertos: el prompt de Automatización de macOS atribuido a Orca, el control por AppleScript con cuentas Free y la aceptación de #25129 (esto último quedó superado en parte: `plugin.request` ya figura en la Host API 1.2, O1 L30).

Nuevos, con cómo verificarlos:

| # | Pendiente | Cómo verificarlo |
| --- | --- | --- |
| 1 | **Rate limit numérico y buckets de la cuota de Dev Mode.** Spotify no publica números (S14, S1) | Con una app propia y un token real, hacer `GET /me/player` en bucle a 1 Hz hasta el primer 429 y anotar la cantidad y el `Retry-After` |
| 2 | Si el 429 por `QUOTA_EXCEEDED` trae `Retry-After`; si un 304 cuenta para el límite | Mismo experimento, mirando headers; repetir con `If-None-Match` |
| 3 | Que el dashboard acepte el redirect URI loopback **sin puerto** (S15) y con ruta (`/callback`) | Crear una app de prueba y guardar `http://127.0.0.1/callback` |
| 4 | Si el dueño de la app cuenta como 1 de los 5 usuarios y si hace falta agregarse al allowlist | Crear la app y loguearse sin tocar "Users Management" |
| 5 | Cuerpos de error no documentados: 403 por falta de Premium, 404 sin dispositivo activo (las páginas solo listan 204/401/403/429; `reason` documenta solo `QUOTA_EXCEEDED`, S20) | Probar con una cuenta Free y con Spotify cerrado |
| 6 | Si una cuenta Free puede leer `GET /me/player` (las páginas de lectura no mencionan Premium) | Probar con una cuenta Free |
| 7 | Semántica real de `previous` (¿reinicia la pista pasados unos segundos?), de `volume` en la app de escritorio de Mac (`supports_volume`) y si la app local aparece en `/devices` cuando está abierta pero inactiva | Token real, con la app abierta en pausa |
| 8 | Que el worker de Orca pueda en ejecución real hacer `fetch` a `accounts.spotify.com` y `api.spotify.com` y levantar `http.createServer` en `127.0.0.1`, y qué pasa tras un proxy (el entorno del worker no hereda `HTTP(S)_PROXY`, O7 L3-22) | Un handler de prueba y `orca plugin dev request . <nombre>` |
| 9 | Si `orca.shell.openExternal` sigue habilitado después de un `await` a `plugin.request` (activación transitoria de "unos segundos", O1 L9). El diseño evita el problema armando la URL antes del click | Probar el flujo completo en el panel |
| 10 | **Alcance de las Developer Terms al modelo "cada usuario crea su app" con un plugin open source**: si el plugin cuenta como SDA del autor, de cada usuario o de ninguno; cómo se aplica la cláusula de "Security Code" y la de "mimic core user experience" (S21, S22) | Consulta directa a Spotify (soporte del dashboard). El foro de la comunidad sirve solo de indicio |
| 11 | Tensión entre atribuir con el logo de Spotify (S24) y la política de listado de Orca contra el uso de marca ajena (O5 L20-23) | Preguntar a los mantenedores del catálogo de Orca antes de listar un modo Web API |
| 12 | Si hay cambios de política posteriores al 2026-11-01 | Releer S1, S3 y los changelogs; seguir el RSS (`https://developer.spotify.com/rss.xml`) |
| 13 | `contributes.connections` (login hecho por el host) podría reemplazar el servidor loopback propio | Vigilar el manifest de Orca; hoy debe ir vacío (O3 L51) |
| 14 | Soloist (WebSocket local con eventos) como backend alternativo para quien no use la app de escritorio. No investigué sus eventos ni su licencia más allá del README | Leer S29 completo y probarlo |
| 15 | `STATE_SCRIPT` real de AppleScript: latencia con el Apple Event a Spotify, no medida para no disparar un aviso de permisos | Medirlo desde dentro de Orca (`orca plugin logs`), donde el permiso ya está concedido |

Riesgos que quedan aunque todo lo anterior salga bien: el límite de 5 usuarios y el requisito de Premium pueden endurecerse sin aviso (S21 VI), los refresh tokens vencen cada 6 meses y el modelo de procesos de los workers de Orca es experimental (O2 L603-606).

---

## Fuentes consultadas

### Spotify (leídas el 2026-11-01, entre 18:24 y 19:00 UTC)

| Id | Página | URL |
| --- | --- | --- |
| S1 | Quota modes | <https://developer.spotify.com/documentation/web-api/concepts/quota-modes> |
| S2 | Apps | <https://developer.spotify.com/documentation/web-api/concepts/apps> |
| S3 | Guía de migración de feb-2026 | <https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide> |
| S4 | Changelog de feb-2026 | <https://developer.spotify.com/documentation/web-api/references/changes/february-2026> |
| S5 | Changelog de mar-2026 | <https://developer.spotify.com/documentation/web-api/references/changes/march-2026> |
| S6 | Changelog de may-2026 | <https://developer.spotify.com/documentation/web-api/references/changes/may-2026> |
| S7 | Changelog de jul-2026 | <https://developer.spotify.com/documentation/web-api/references/changes/july-2026> |
| S8 | Blog 2026-02-06, Update on Developer Access and Platform Security (con la actualización del 9-mar) | <https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security> |
| S9 | Blog 2026-06-18, Introducing refresh token expiration | <https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration> |
| S10 | Blog 2026-07-23, Web API quota updates for Development Mode | <https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates> |
| S11 | Blog 2026-08-13, Introducing Spotify Soloist | <https://developer.spotify.com/blog/2026-08-13-introducing-spotify-soloist> |
| S12 | Blog 2025-04-15, Updating the Criteria for Web API Extended Access | <https://developer.spotify.com/blog/2025-04-15-updating-the-criteria-for-web-api-extended-access> |
| S13 | Blog 2025-02-12, Increasing the security requirements | <https://developer.spotify.com/blog/2025-02-12-increasing-the-security-requirements-for-integrating-with-spotify> |
| S14 | Rate limits | <https://developer.spotify.com/documentation/web-api/concepts/rate-limits> |
| S15 | Redirect URIs | <https://developer.spotify.com/documentation/web-api/concepts/redirect_uri> |
| S16 | Authorization Code with PKCE | <https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow> |
| S17 | Refreshing tokens | <https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens> |
| S18 | Scopes | <https://developer.spotify.com/documentation/web-api/concepts/scopes> |
| S19 | Authorization | <https://developer.spotify.com/documentation/web-api/concepts/authorization> |
| S20 | API calls | <https://developer.spotify.com/documentation/web-api/concepts/api-calls> |
| S21 | Developer Terms, versión 10 (15-may-2025) | <https://developer.spotify.com/terms> |
| S22 | Developer Policy (15-may-2025) | <https://developer.spotify.com/policy> |
| S23 | Compliance Tips | <https://developer.spotify.com/compliance-tips> |
| S24 | Design guidelines | <https://developer.spotify.com/documentation/design> |
| S25 | Web Playback SDK, overview | <https://developer.spotify.com/documentation/web-playback-sdk> |
| S26 | Web Playback SDK, reference | <https://developer.spotify.com/documentation/web-playback-sdk/reference> |
| S27 | Web Playback SDK, getting started | <https://developer.spotify.com/documentation/web-playback-sdk/tutorials/getting-started> |
| S28 | Referencia de endpoints (get-information-about-the-users-current-playback, get-the-users-currently-playing-track, start-a-users-playback, pause-a-users-playback, skip-users-playback-to-next-track, skip-users-playback-to-previous-track, seek-to-position-in-currently-playing-track, set-volume-for-users-playback, toggle-shuffle-for-users-playback, set-repeat-mode-on-users-playback, get-a-users-available-devices, transfer-a-users-playback, search, get-queue, add-to-queue, get-a-list-of-current-users-playlists) | <https://developer.spotify.com/documentation/web-api/reference/> + el slug indicado |
| S29 | Soloist, WebSocket API | <https://developer.spotify.com/documentation/soloist/reference/websocket-api> |
| S30 | Soloist, getting started | <https://developer.spotify.com/documentation/soloist/tutorials/getting-started> |
| S31 | `spotify/soloist`, README | <https://github.com/spotify/soloist> |
| S32 | Índice del blog y RSS | <https://developer.spotify.com/community>, <https://developer.spotify.com/rss.xml> |

No encontré un OpenAPI oficial publicado: `https://developer.spotify.com/reference/web-api/open-api-schema.yml` devuelve 404 y el repo `spotify/web-api` está archivado, con último push en 2020 (consultado con `gh`).

### Orca (`stablyai/orca`, rama `main`, commit `225db8cfb2685f80110967527b6ec2cb19d7c4a7`, 2026-11-01)

| Id | Archivo |
| --- | --- |
| O1 | `docs/reference/plugin-host-api.md` |
| O2 | `docs/reference/plugin-authoring.md` |
| O3 | `docs/reference/plugin-manifest.md` |
| O4 | `docs/reference/plugin-isolated-frames.md` |
| O5 | `docs/reference/plugin-listing-policy.md` |
| O6 | `src/main/plugins/workers/plugin-host-process.ts` |
| O7 | `src/main/plugins/workers/plugin-worker-env.ts` |
| O8 | `src/shared/plugins/workers/plugin-host-protocol.ts` |
| O9 | `src/main/plugins/plugin-secrets-store.ts` |
| O10 | `package.json` |

### Locales

| Id | Qué |
| --- | --- |
| L1 | Este repo: `backends/applescript.mjs`, `src/commands.mjs`, `src/panel-protocol.mjs`, `src/settle.mjs`, `panel/index.html`, `orca-plugin.json`, `README.md`, `worker.mjs` |
| L2 | Mediciones y búsquedas del 2026-11-01 en esta máquina: tiempos de `osascript` y de `curl` a `api.spotify.com` (sin token), búsqueda de archivos `*widevine*` en `/Applications/Orca.app`, búsqueda de código "widevine" en `stablyai/orca` |
