# stremio-local-addon

Stremio add-on that adds one extra stream per title: **Download** (nothing local yet), **Your server NN%** (downloading, playable up to what's there) or **Your server** (complete). Your normal add-ons are untouched.

Downloads run in your own torrent client: **qBittorrent** (default) or **Transmission**.

## Install

Copy/paste install for a Docker host: Unraid (with the *Docker Compose Manager* plugin) or any Linux box with Docker and the compose plugin. Only step 1 needs editing. Run all steps in **the same terminal**, as later steps use the values from step 1.

### 1. Your values

Edit these, then paste the block:

```sh
APP_DIR=/mnt/user/appdata/stremio-local-addon    # add-on code (app/) and its data (data/)
DOWNLOADS=/mnt/user/downloads/qbittorrent        # host folder the torrent client has mounted at /downloads
PUBLIC_URL=https://stremio.example.com           # HTTPS host your reverse proxy will point at port 7000
TORRENT_CLIENT=qbittorrent                       # or: transmission (4.1 or newer)
CLIENT_URL=http://192.168.1.10:8080              # qBittorrent WebUI, or http://192.168.1.10:9091 for Transmission
CLIENT_USER=admin
CLIENT_PASS=changeme                             # avoid " and $ in here (or change it later in Settings)
```

### 2. Torrent client (skip if you already have one)

qBittorrent (`PUID`/`PGID` 99/100 are Unraid's defaults; elsewhere use the output of `id -u` / `id -g`):

```sh
docker run -d --name qbittorrent --restart unless-stopped \
  -e PUID=99 -e PGID=100 -e TZ=Europe/Amsterdam -e WEBUI_PORT=8080 \
  -p 8080:8080 -p 6881:6881 -p 6881:6881/udp \
  -v "$APP_DIR/../qbittorrent:/config" -v "$DOWNLOADS:/downloads" \
  lscr.io/linuxserver/qbittorrent:latest
sleep 10; docker logs qbittorrent 2>&1 | grep -i password
```

Log in at `http://<host-ip>:8080` with `admin` and the temporary password printed above, set your own password under *Tools → Options → Web UI*, and put it in `CLIENT_PASS` (paste the step 1 block again).

Or Transmission:

```sh
docker run -d --name transmission --restart unless-stopped \
  -e PUID=99 -e PGID=100 -e TZ=Europe/Amsterdam -e USER="$CLIENT_USER" -e PASS="$CLIENT_PASS" \
  -p 9091:9091 -p 51413:51413 -p 51413:51413/udp \
  -v "$APP_DIR/../transmission:/config" -v "$DOWNLOADS:/downloads" \
  lscr.io/linuxserver/transmission:latest
```

### 3. Download the add-on

```sh
mkdir -p "$APP_DIR/app" "$APP_DIR/data"
curl -fsSL https://github.com/remco59/Stremio_DownloadLocal/archive/refs/heads/main.tar.gz \
  | tar xz --strip-components=1 -C "$APP_DIR/app"
cd "$APP_DIR/app"
```

### 4. Write your config

This creates a random token and a `docker-compose.override.yml` next to `docker-compose.yml` (compose merges the two). Run it once: running it again makes a new token, so you would have to reinstall the add-on in Stremio.

```sh
ADDON_TOKEN=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
if [ "$TORRENT_CLIENT" = transmission ]; then P=TR; else P=QB; fi
cat > docker-compose.override.yml <<EOF
services:
  stremio-local-addon:
    environment:
      ADDON_TOKEN: "$ADDON_TOKEN"
      PUBLIC_URL: "$PUBLIC_URL"
      TORRENT_CLIENT: "$TORRENT_CLIENT"
      ${P}_URL: "$CLIENT_URL"
      ${P}_USER: "$CLIENT_USER"
      ${P}_PASS: "$CLIENT_PASS"
    volumes:
      - "$APP_DIR/data:/data"
      - "$DOWNLOADS:/downloads:rw"
EOF
```

The downloads folder is mounted read-write so *Delete files* in the web UI works; append `:ro` instead of `:rw` if you don't want that. Every other setting can be changed later in the web UI (see [Settings](#settings) and [Env vars](#env-vars)).

### 5. Start it

```sh
docker compose up -d --build
sleep 5; docker logs --tail 20 stremio-local-addon
curl -fsS "http://localhost:7000/$ADDON_TOKEN/manifest.json" >/dev/null && echo "Add-on is running"
echo "Stremio add-on URL: $PUBLIC_URL/$ADDON_TOKEN/manifest.json"
echo "Web UI:             $PUBLIC_URL/$ADDON_TOKEN/"
```

Save the two URLs (the container log prints them too). Lost them? `grep ADDON_TOKEN /mnt/user/appdata/stremio-local-addon/app/docker-compose.override.yml` shows the token (use your `APP_DIR` if you changed it).

### 6. HTTPS and Stremio

Stremio only installs remote add-ons over HTTPS. In Nginx Proxy Manager, add a proxy host:

- **Domain**: the host from `PUBLIC_URL`
- **Forward**: `http`, the Docker host's IP, port `7000`
- **SSL**: request a Let's Encrypt certificate, tick *Force SSL*

Then open the web UI URL, go to **Settings** and click **Test connection** for your torrent client. In Stremio go to Add-ons, paste the add-on URL in the search box and install it.

### Updating

```sh
cd /mnt/user/appdata/stremio-local-addon/app    # your APP_DIR + /app
curl -fsSL https://github.com/remco59/Stremio_DownloadLocal/archive/refs/heads/main.tar.gz \
  | tar xz --strip-components=1 -C .
docker compose up -d --build
```

Your `docker-compose.override.yml` and everything in `data/` (settings, download list) are kept.

### Without Docker

Needs Node.js 20 or newer. Paste the step 1 block first, then:

```sh
mkdir -p "$APP_DIR/app" && cd "$APP_DIR/app"
curl -fsSL https://github.com/remco59/Stremio_DownloadLocal/archive/refs/heads/main.tar.gz | tar xz --strip-components=1
npm ci --omit=dev
export ADDON_TOKEN=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32) DATA_DIR="$APP_DIR/data" PUBLIC_URL TORRENT_CLIENT
if [ "$TORRENT_CLIENT" = transmission ]; then export TR_URL="$CLIENT_URL" TR_USER="$CLIENT_USER" TR_PASS="$CLIENT_PASS"; \
else export QB_URL="$CLIENT_URL" QB_USER="$CLIENT_USER" QB_PASS="$CLIENT_PASS"; fi
echo "Add-on URL: $PUBLIC_URL/$ADDON_TOKEN/manifest.json"
node server.js
```

Here the torrent client's `/downloads` must be reachable on this machine under the same path; if it isn't, set `CLIENT_PATH_PREFIX=/downloads` and `LOCAL_PATH_PREFIX=<local path>`.

### Torrent client notes

- **qBittorrent** (linuxserver/qbittorrent, 4.x or 5.x): qBittorrent 5.2+ refuses requests that arrive on another port than its own WebUI port (*Invalid Host header, port mismatch* in its log, *login refused (401)* in *Test connection*). Map the same port on both sides (`WEBUI_PORT=8080` with `-p 8080:8080`, as in step 2), or untick *Enable Host header validation* in the WebUI options. *Keep incomplete torrents in* and *Append .!qB extension* both work.
- **Transmission** (linuxserver/transmission) needs **4.1 or newer**: older versions don't download sequentially, so titles download in random order and only become playable once (almost) complete. *Test connection* warns about this. The linuxserver image's incomplete dir (`/downloads/incomplete`, `.part` files) and download dir (`/downloads/complete`) work as-is when both containers mount the same folder at `/downloads`.
- The add-on must see the **same** host download folder at `/downloads` as the torrent client. If your client uses a different path inside its container, set `CLIENT_PATH_PREFIX` (client's path) and `LOCAL_PATH_PREFIX` (add-on's path).

## Playing

- **First tap** on *Download*: the add-on starts the download and waits up to 15 s (*First tap* setting). If the start of the file is there by then (2 MB, or the whole file), it plays right away. Otherwise Stremio plays a short built-in status clip (*Download started*, *Looking for the torrent* or *Could not start the download*) and the download carries on in the background. Next time, the entry shows *⏳ Your server NN%* with how far it plays.
- **While downloading**, the file plays up to the downloaded part (sequential download). If playback catches up with the download, the player buffers for up to 30 s (*While playing* setting), then the connection drops and the player retries.
- **Seeking past the downloaded part** waits up to 8 s (*Seek* setting) and then answers *503 Not downloaded this far yet*, so the player shows an error instead of hanging. Seek back to an earlier point, or wait.
- The clips are 10 minutes long on purpose: a clip that ends could make Stremio auto-play the next episode. *Download* entries are also kept out of Stremio's binge group, so the next episode never starts a download by itself. Close the clip with Back. Stremio may remember a few seconds of progress from the clip; just start from the beginning.
- The clips live in `clips/` and are generated by `scripts/make-clips.sh` (ffmpeg).

## Choosing torrents

Torrents come from **Torrentio**, **Jackett / Prowlarr** (Torznab), or both (Settings → Torrent source). Results from all sources are merged per info hash, then filtered and scored with the *Torrent choice* settings:

- **Filters** (never picked): blocked words / release groups (CAM and telesync releases by default), minimum/maximum size (season packs are exempt from the maximum), minimum seeders.
- **Score**: seeders, then bonuses for the preferred resolution, a preferred language (`nl`, `en`, `multi`, ...; from release names and Torrentio's flags), preferred words / release groups, and season packs for batch downloads. Releases above the max resolution are only used when nothing else exists.

The best one is picked automatically. To pick one yourself, use **Choose...** next to a movie or an episode under **Add**, or **More → Choose another torrent** on the **Downloads** page. This lists every candidate with size, seeders, language, source and why it scored as it did, including filtered ones. Choosing a different torrent for something that is already downloading replaces it; files already downloaded stay on disk.

Jackett: use the *all indexers* Torznab URL (`http://jackett:9117/api/v2.0/indexers/all/results/torznab/`) and its API key. Prowlarr has one URL per indexer (`http://prowlarr:9696/<id>/api`); list several separated by commas.

## Pre-downloading series

Search a series under **Add**, open **Episodes**, and download a single episode, **Download season** or **Download whole show**. A batch queues every released episode (specials skipped) that is not already on the server or on its way, and retries ones that failed. Torrent lookups run one at a time in the background. Episodes of one season prefer a shared season pack when the source has a reasonably seeded one. Every episode still gets its own entry, so each shows up in Stremio on its own.

## Managing downloads

The web UI opens on the **Downloads** page. It lists everything the add-on knows about in three groups: *Needs attention* (failed or removed), *Downloading* and *On your server*. Episodes are grouped per show, and titles, episode names and posters come from Cinemeta. Each item shows its size, speed and ETA, and how far it already plays from the start (the bright part of the bar). Per item:

- **Play** opens the stream URL (works in a browser or VLC). It shows up once the start of the file is there.
- **Pause / Resume** the torrent.
- **Try again / Download again** an item that failed or was removed.
- Under **More**:
  - **Choose another torrent** opens the torrent picker.
  - **Remove from torrent client** takes it out of the torrent client and keeps the files. A finished file stays playable from Stremio.
  - **Forget** removes it from the list only.
  - **Delete files** deletes it from disk (after a confirmation). This goes through the torrent client while it still has the torrent, otherwise the add-on deletes the file itself (needs the read-write mount). It never touches anything outside the downloads folder.

Season packs are shared between episodes: removing or deleting one episode only drops that episode's file, and the torrent stays for the others.

## Security

The token is the only auth, so treat the URL like a password. On top of that:

- The token is compared in constant time. Wrong URLs get a plain `404 Not found`, and an IP that keeps guessing (20 misses in 10 minutes by default) is locked out for a minute, doubling up to an hour.
- New downloads started from Stremio are limited per IP (10/min) and in total (30/min), and web UI actions per IP (120/min). Playing what is already there is never limited. All limits are under Settings → Security (0 = off).
- The client IP is only taken from `X-Forwarded-For` when the request comes from a private or loopback address (your reverse proxy), so clients cannot fake it.
- The web UI sends a strict Content-Security-Policy and `Referrer-Policy: no-referrer`, so the token never leaks via the `Referer` header, e.g. when posters load.

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
| `TORRENTIO_URL` | `https://torrentio.strem.fun` | Torrentio (or compatible) instance |
| `SOURCES` | `torrentio` | `torrentio`, `torznab` or `both` |
| `TORZNAB_URLS` / `TORZNAB_APIKEY` | | Jackett/Prowlarr Torznab URL(s), comma separated, and API key |
| `MAX_RES` | `1080` | skip releases above this resolution (unless nothing else exists) |
| `PREFERRED_RES` | `0` (none) | resolution that gets a bonus |
| `LANGUAGES` | | preferred language codes, e.g. `nl, multi` |
| `MIN_SEEDERS` / `MIN_SIZE_MB` / `MAX_SIZE_GB` | `0` (off) | hard filters |
| `PREFER_KEYWORDS` / `BLOCK_KEYWORDS` | `` / `cam, camrip, hdcam, telesync, hdts, telecine` | preferred / blocked words and release groups |
| `CINEMETA_URL` | `https://v3-cinemeta.strem.io` | title/episode metadata (search, seasons) |
| `WAIT_FOR_START_MS` | `15000` | first tap: how long `/play` waits before showing the status clip |
| `SEEK_WAIT_MS` | `8000` | seek past the downloaded part: how long to wait before answering 503 |
| `STALL_MS` | `30000` | while playing: how long to wait for missing pieces before dropping the connection |
| `STALL_SWITCH_MIN` | `10` | a download still at 0% after this many minutes (not paused or queued in the client) moves to the next best untried torrent; `0` = never |
| `SYNC_INTERVAL_MS` | `5000` | torrent client poll interval |
| `PLAY_STARTS_PER_IP_PER_MIN` / `PLAY_STARTS_PER_MIN` | `10` / `30` | new downloads from Stremio per minute (0 = off) |
| `API_WRITES_PER_IP_PER_MIN` | `120` | web UI actions per minute (0 = off) |
| `TOKEN_FAILURES_LOCKOUT` | `20` | wrong URLs within 10 minutes before an IP is locked out (0 = off) |

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

### Against real clients

`npm run test:real` runs the whole flow against real torrent clients in Docker (needs Docker; pulls the linuxserver images):

- qBittorrent 5.x and 4.x, and Transmission 4.1+, each downloading a generated video from the other client through a tiny local tracker: connection test, category/label, sequential download, file selection, playing while downloading (incomplete dir, `.!qB` / `.part`), pause/resume, completion, remove, delete files (directly and through the client).
- Transmission 4.0: the connection test warns about the missing sequential download.
- The add-on's own image next to a qBittorrent container, like `docker-compose.yml`: container-to-container connection, settings kept in `/data` across a restart, refusing to start without a token.

If Docker Hub rate-limits the `node:20-alpine` base image, pull it from a mirror first (`docker pull mirror.gcr.io/library/node:20-alpine && docker tag mirror.gcr.io/library/node:20-alpine node:20-alpine`). `REAL_ADDON_IMAGE=<image>` skips the build and tests a prebuilt image instead.

### Adding a torrent client

All torrent access goes through `clients/index.js`, which documents the interface (add, info, files, pieces, setWanted, stop/start, remove, testConnection). Implement it in `clients/<name>.js`, register it in `CLIENTS`, and add a mock plus an `addon.<name>.test.js` and a `clients.test.js` setup.
