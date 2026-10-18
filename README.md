# stremio-local-addon

Stremio add-on that adds one extra stream per title: **Download** (nothing local yet), **Your server NN%** (downloading, playable up to what's there) or **Your server** (complete). Your normal add-ons are untouched.

Downloads run in your own torrent client: **qBittorrent** (default) or **Transmission**.

## Setup

1. **Torrent client**, one of:
   - **qBittorrent** (linuxserver/qbittorrent): note the WebUI port and credentials. Mount your downloads share at `/downloads`.
     WebUI settings: if requests from the add-on get rejected, untick *Enable Host header validation* (or add the add-on's host to the allowed domains).
   - **Transmission** (linuxserver/transmission, **4.1 or newer**): note the RPC port (9091) and credentials, mount the downloads share at `/downloads`, and set `TORRENT_CLIENT=transmission` plus the `TR_*` vars in the add-on.
     Transmission only downloads sequentially from 4.1 on. With an older version titles download in random order and only become playable once (almost) complete.
     An *incomplete dir* is fine as long as the add-on can see it under the same path mapping (e.g. `/downloads/incomplete`).
2. **Add-on**: copy this folder to Unraid, edit `docker-compose.yml`, then `docker compose up -d --build`.
   Mount the **same** host download folder read-only at `/downloads` in the add-on container (same path as in the torrent client, or set `CLIENT_PATH_PREFIX` / `LOCAL_PATH_PREFIX`).
3. **Reverse proxy**: point an HTTPS host (Nginx Proxy Manager) at port 7000. Stremio needs HTTPS for remote add-ons.
4. **Stremio**: Add-ons -> paste `https://<your-host>/<ADDON_TOKEN>/manifest.json`.
5. **Web UI**: `https://<your-host>/<ADDON_TOKEN>/`, with search/download, the download list and **Settings**.

The token is the only auth, so treat the URL like a password.

## Settings

Everything below can be changed on the **Settings** page of the web UI: torrent client (with a *Test connection* button per client), connection details, path mapping, torrent source, timeouts and the public URL. Changes are stored in `DATA_DIR/settings.json`, override the env vars, and apply right away without a restart. *Reset to default* goes back to the env value. Passwords are never shown again once saved; leave the field empty to keep the saved one.

**Rotate token** creates a new secret URL. The old URL stops working immediately, so reinstall the add-on in Stremio with the new manifest URL shown on the page.

## Env vars

These are the defaults for the settings page.

| Var | Default | |
|---|---|---|
| `ADDON_TOKEN` | required | secret path segment |
| `PUBLIC_URL` | from request | public HTTPS base URL |
| `TORRENT_CLIENT` | `qbittorrent` | `qbittorrent` or `transmission` |
| `QB_URL` / `QB_USER` / `QB_PASS` | `http://qbittorrent:8080` | qBittorrent WebUI |
| `QB_CATEGORY` | `stremio` | category for added torrents |
| `TR_URL` / `TR_USER` / `TR_PASS` | `http://transmission:9091/transmission/rpc` | Transmission RPC (a bare `http://host:9091` works too) |
| `TR_LABEL` | `stremio` | label for added torrents |
| `TR_DOWNLOAD_DIR` | Transmission's default | download dir for added torrents |
| `CLIENT_PATH_PREFIX` / `LOCAL_PATH_PREFIX` | `/downloads` | path remap between containers (`QB_PATH_PREFIX` still works) |
| `TORRENTIO_URL` | `https://torrentio.strem.fun` | torrent lookup (placeholder, see `finder.js`) |
| `MAX_RES` | `1080` | skip releases above this resolution |
| `WAIT_FOR_START_MS` | `45000` | how long `/play` waits for torrent metadata |
| `STALL_MS` | `30000` | how long a stream waits for missing pieces before dropping the connection |
| `SYNC_INTERVAL_MS` | `5000` | qBittorrent poll interval |

## How it works

- `/stream/...` checks `state.json`: no record -> Download, downloading -> NN%, complete -> Your server.
- `/play/...` starts the download if needed (sequential mode, only the needed file), waits for metadata, then serves HTTP ranges. Reads are gated by the torrent client's piece map, so the player only gets bytes that really exist and buffers for the rest.
- A 5 s sync loop keeps progress current and marks entries `missing` if the torrent and file are gone, which brings the Download button back.

## Development

```sh
npm install
npm test
```

Tests use Node's built-in test runner and in-process mocks of the qBittorrent WebUI API and the Transmission RPC (`test/helpers/`), so no real client or network is needed. The end-to-end suite runs once per client. CI runs everything on every push and pull request.

### Adding a torrent client

All torrent access goes through `clients/index.js`, which documents the interface (add, info, files, pieces, setWanted, stop/start, remove, testConnection). Implement it in `clients/<name>.js`, register it in `CLIENTS`, and add a mock plus an `addon.<name>.test.js` and a `clients.test.js` setup.
