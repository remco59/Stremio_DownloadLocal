# stremio-local-addon

Stremio add-on that adds one extra stream per title: **Download** (nothing local yet), **Your server NN%** (downloading, playable up to what's there) or **Your server** (complete). Your normal add-ons are untouched.

## Setup

1. **qBittorrent** (linuxserver/qbittorrent): note the WebUI port and credentials. Mount your downloads share at `/downloads`.
   - WebUI settings: if requests from the add-on get rejected, untick *Enable Host header validation* (or add the add-on's host to the allowed domains).
2. **Add-on**: copy this folder to Unraid, edit `docker-compose.yml`, then `docker compose up -d --build`.
   Mount the **same** host download folder read-only at `/downloads` in the add-on container.
3. **Reverse proxy**: point an HTTPS host (Nginx Proxy Manager) at port 7000. Stremio needs HTTPS for remote add-ons.
4. **Stremio**: Add-ons -> paste `https://<your-host>/<ADDON_TOKEN>/manifest.json`.
5. **Download UI** (search bar): `https://<your-host>/<ADDON_TOKEN>/`

The token is the only auth, so treat the URL like a password.

## Env vars

| Var | Default | |
|---|---|---|
| `ADDON_TOKEN` | required | secret path segment |
| `PUBLIC_URL` | from request | public HTTPS base URL |
| `QB_URL` / `QB_USER` / `QB_PASS` | `http://qbittorrent:8080` | qBittorrent WebUI |
| `QB_CATEGORY` | `stremio` | category for added torrents |
| `QB_PATH_PREFIX` / `LOCAL_PATH_PREFIX` | `/downloads` | path remap between containers |
| `TORRENTIO_URL` | `https://torrentio.strem.fun` | torrent lookup (placeholder, see `finder.js`) |
| `MAX_RES` | `1080` | skip releases above this resolution |

## How it works

- `/stream/...` checks `state.json`: no record -> Download, downloading -> NN%, complete -> Your server.
- `/play/...` starts the download if needed (sequential mode, only the needed file), waits for metadata, then serves HTTP ranges. Reads are gated by qBittorrent's piece map, so the player only gets bytes that really exist and buffers for the rest.
- A 5 s sync loop keeps progress current and marks entries `missing` if the torrent and file are gone, which brings the Download button back.
