# Plan: Stremio "Download and watch" add-on

## Goal

Keep using the usual Stremio add-ons (Torrentio etc.) untouched. A new, lightweight add-on adds **one extra stream** per title/episode. When a torrent's swarm is too thin to stream, tap it and the title is downloaded to the Unraid server, then played from there, all inside the Stremio UI.

Requirements that shaped the design:

- Existing add-ons stay as they are; this add-on only injects its own entry.
- The torrent client stays a separate container; the add-on talks to its API. qBittorrent is the default, Transmission is supported too, and more clients can be added behind the same interface (`clients/`).
- Downloads can take hours. Come back the next day and Stremio shows the title as available locally; playback continues from there. Files stay on the server.
- Partially downloaded files are playable up to the downloaded part.
- The Stremio add-on is thin: per title/episode it shows one entry that is either a **download** button or a **watch local stream** button, depending on state.
- The whole backend runs on the Unraid server, in one container, and connects to the existing qBittorrent container (no changes to that container).
- That same container serves a **web interface** (no Stremio needed) to: manage downloads, change all settings, and search shows/movies to queue downloads in advance (single episode, a season, or a whole show).
- Out of scope: watch history (Stremio does not expose it to add-ons).

## Architecture

```
Stremio ──(manifest + /stream)──▶ add-on server (Node, Docker) ──(client API)──▶ qBittorrent / Transmission (separate container)
   │                                   │  state.json (per Stremio ID)                │
   └────────(HTTP range requests)──────┘◀──── reads files from shared /downloads ───┘
```

Three pieces on Unraid:

1. **Torrent client**: qBittorrent or Transmission (4.1+ for sequential download), official/linuxserver container, unchanged. Does the actual torrenting. The add-on only uses a small client interface (`clients/index.js`), so another client is one extra file.
2. **Add-on + backend** (this repo): speaks the Stremio add-on protocol, tracks state, serves video over HTTP ranges, hosts the search UI.
3. **Reverse proxy**: HTTPS in front (Nginx Proxy Manager); Stremio requires HTTPS for remote add-ons. The secret token in the URL is the only auth.

Both containers mount the same host downloads folder at `/downloads` (read-write in the add-on, so the web UI can delete files the torrent client no longer tracks).

## State machine (per Stremio ID, e.g. `tt0133093` or `tt0944947:1:2`)

| State | Stream entry shown in Stremio |
|---|---|
| no record / `missing` / `error` | ⬇️ Download (Download and watch) |
| `queued` / `downloading` | ⏳ Your server NN% (playable up to the downloaded part) |
| `complete` | 🏠 Your server |

`missing` = torrent gone from qBittorrent and file gone from disk. A completed file stays playable even if the torrent is removed from qBittorrent.

## Flows

**Tap "Download"** → `/play/:type/:id` → find a torrent (`finder.js`) → add to qBittorrent with sequential download + first/last piece priority → wait for metadata (up to 45 s) → select only the needed file (priority 0 for the rest; other episodes of a shared season pack are kept) → serve ranges.

**Sync loop (5 s)** → poll qBittorrent, update progress and status, detect `complete` / `missing` / `error`.

**Streaming** → for each range request, read qBittorrent's piece map and only send bytes whose pieces are downloaded. If the player asks for bytes not there yet, the response waits (player buffers), up to 30 s, then the connection is dropped so the player retries. Handles `.!qB` partial file names.

**Come back later** → Stremio asks `/stream/...`; the add-on sees the record and shows the percentage or "Your server". Playing continues from the server.

**Web interface** (`/`, behind a username/password login), served by the same container, three areas:

1. **Add / pre-download**: search via Cinemeta, pick a movie, a single episode, a whole season or a whole show (queues every episode; episodes that are already downloaded are skipped), hit Download.
2. **Manage downloads**: live list with progress, status and size; per item: pause/resume, remove from qBittorrent, delete files from disk (with confirmation), re-download, open/play link.
3. **Settings**: edit all settings in the UI and persist them in `DATA_DIR/settings.json` (env vars only provide the defaults). Covers: torrent client choice (qBittorrent / Transmission) with per-client URL/user/password/category or label and a "test connection" button, path mapping, torrent source (Torrentio URL or Jackett/Prowlarr), max resolution and language/size preferences, timeouts, public URL, and token rotation. Changes apply without restarting the container.

## Decisions

- Plain Express, JSON file store (no native deps, easy to run on Unraid).
- Add-on and torrent client kept as separate containers; all client access goes through one interface (add, info, files, pieces, set wanted files, stop/start, remove, test connection), so the downloader can be swapped without touching the add-on logic.
- Transmission needs 4.1+ for sequential download (`sequential_download`); older versions work but only play once (almost) complete.
- Piece-map gating instead of guessing from file size (qBittorrent files are sparse while downloading).
- Secret token in the URL path for the add-on routes Stremio uses (manifest, streams, play). The web UI and its API use a username/password login with signed session cookies instead; the first login is created through the token URL or set with `UI_USER`/`UI_PASSWORD`.
- Settings live in a JSON file in the data volume and override env vars, so the web UI can edit them at runtime.
- "Whole show" downloads are just a batch of per-episode downloads, so each episode keeps its own state record and shows up correctly in Stremio.

## Status

Done and checked locally (boot, manifest, stream entries, range serving against a mock qBittorrent incl. `.!qB` files and the downloaded-edge cutoff):

- [x] Add-on manifest and stream endpoint
- [x] qBittorrent client, state machine, sync loop
- [x] Range streaming with piece-map gating
- [x] Search/download web UI
- [x] Dockerfile + compose file
- [x] Automated tests (range parsing, piece-map gating, end-to-end against a mock qBittorrent) + CI
- [x] Pluggable torrent client: qBittorrent and Transmission behind one interface, end-to-end tests against both mocks
- [x] Auth hardening: constant-time token check, plain 404s, rate limits for new downloads and UI actions, wrong-token lockout, security headers, body size limits
- [x] Web UI login: username/password (scrypt) with signed session cookies, set up via the token URL or `UI_USER`/`UI_PASSWORD`; Stremio keeps the URL token
- [x] Playback UX: first tap plays or shows a status clip, clean 503 when seeking past the downloaded part, "playable up to NN%" in Stremio
- [x] Torrent picker: Torrentio and/or Jackett/Prowlarr (Torznab), filters + scoring from settings, manual pick in the web UI
- [x] Pre-download a whole season or show from the web UI (background queue, season-pack preference, skips what is there)
- [x] Download management in the web UI and API (pause/resume, remove, delete files, re-download, play link, forget), season-pack aware
- [x] Settings page: client choice, per-client connection fields + connection test, persisted in `settings.json`, applied at runtime, token rotation
- [x] Player in the web UI: audio track choice, subtitles (embedded, files from the torrent, online via a Stremio subtitles add-on), seeking with on-the-fly ffmpeg remux/conversion (`player.js`, `subtitles.js`)

Still to build to meet the requirements above (not in the code yet):


Verified against real clients in Docker (`npm run test:real`):

- [x] qBittorrent 5.2 and 4.6: auth (5.2's 204 login, port-specific cookie, Host header validation), CSRF Referer, `torrents/add` multipart, category, sequential + first/last piece, file priorities, incomplete dir + `.!qB`, stop/start vs pause/resume, delete
- [x] Transmission 4.1: RPC auth + session-id handshake, labels, `sequential_download`, wanted files, piece bitfield, incomplete dir + `.part`, `/downloads/complete` download dir, start/stop, remove with/without data; 4.0 gets the sequential-download warning
- [x] The add-on's Docker image next to a qBittorrent container (compose layout), settings persisted in `/data`

Only the owner can check (see issue #9):

- [ ] Docker build/run on Unraid and HTTPS via Nginx Proxy Manager
- [ ] Real playback in Stremio (desktop and mobile), with each client

## Next steps / open points

1. ~~**Torrent picker**~~: done (Torrentio + Jackett/Prowlarr, scoring, manual pick).
2. ~~**First-tap UX**~~: done (plays when the start is there, otherwise a status clip).
3. ~~**Seeking past the downloaded part**~~: done (short wait, then a clean 503).
4. ~~**Download management**~~: done.
5. ~~**Settings page**~~: done.
6. ~~**Season/show batch download**~~: done.
7. ~~**Auth hardening**~~: done (constant-time token check, rate limits, wrong-token lockout, CSP/no-referrer, body limits).
8. ~~**Tests**~~: done, see `test/` (`npm test`).
