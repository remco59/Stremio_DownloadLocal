# Plan: Stremio "Download and watch" add-on

## Goal

Keep using the usual Stremio add-ons (Torrentio etc.) untouched. A new, lightweight add-on adds **one extra stream** per title/episode. When a torrent's swarm is too thin to stream, tap it and the title is downloaded to the Unraid server, then played from there, all inside the Stremio UI.

Requirements that shaped the design:

- Existing add-ons stay as they are; this add-on only injects its own entry.
- qBittorrent stays a separate container; the add-on talks to its WebUI API.
- Downloads can take hours. Come back the next day and Stremio shows the title as available locally; playback continues from there. Files stay on the server.
- Partially downloaded files are playable up to the downloaded part.
- A separate web page with a search bar can also trigger downloads (no Stremio needed).
- Out of scope: watch history (Stremio does not expose it to add-ons).

## Architecture

```
Stremio ──(manifest + /stream)──▶ add-on server (Node, Docker) ──(WebUI API)──▶ qBittorrent (separate container)
   │                                   │  state.json (per Stremio ID)                │
   └────────(HTTP range requests)──────┘◀──── reads files from shared /downloads ───┘
```

Three pieces on Unraid:

1. **qBittorrent**: official/linuxserver container, unchanged. Does the actual torrenting.
2. **Add-on + backend** (this repo): speaks the Stremio add-on protocol, tracks state, serves video over HTTP ranges, hosts the search UI.
3. **Reverse proxy**: HTTPS in front (Nginx Proxy Manager); Stremio requires HTTPS for remote add-ons. The secret token in the URL is the only auth.

Both containers mount the same host downloads folder at `/downloads` (read-only in the add-on).

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

**Search UI** (`/<token>/`) → search via Cinemeta, pick movie or episode, hit Download; live list of downloads with progress.

## Decisions

- Plain Express, JSON file store (no native deps, easy to run on Unraid).
- Add-on and qBittorrent kept as separate containers, so the downloader can be swapped without touching the add-on logic.
- Piece-map gating instead of guessing from file size (qBittorrent files are sparse while downloading).
- Secret token in the URL path for all routes (manifest, streams, UI, API).

## Status

Done and checked locally (boot, manifest, stream entries, range serving against a mock qBittorrent incl. `.!qB` files and the downloaded-edge cutoff):

- [x] Add-on manifest and stream endpoint
- [x] qBittorrent client, state machine, sync loop
- [x] Range streaming with piece-map gating
- [x] Search/download web UI
- [x] Dockerfile + compose file

Not yet verified on the real setup:

- [ ] Run against a real qBittorrent (auth, Host header validation / CSRF, `torrents/add` form encoding)
- [ ] Docker build on Unraid and HTTPS via Nginx Proxy Manager
- [ ] Real playback in Stremio (desktop and mobile)

## Next steps / open points

1. **Torrent picker** (`finder.js`): currently a placeholder (Torrentio API, most seeders at ≤ `MAX_RES`). Replace with something better: Jackett/Prowlarr, own scoring (language, release group, size), optionally let the user choose from a list.
2. **First-tap UX**: the first tap can hit the 45 s metadata wait and show a Stremio error; options: placeholder "downloading" video, or return a short status clip.
3. **Seeking past the downloaded part** stalls 30 s then errors; consider an explicit message or a clamp.
4. **Housekeeping**: UI actions to remove a download, free disk space, delete finished files.
5. **Auth hardening**: token rotation, rate limiting on `/play`.
6. **Tests**: automated tests for range parsing and piece-map gating (currently verified by a manual mock run).
