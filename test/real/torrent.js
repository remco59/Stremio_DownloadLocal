// Just enough BitTorrent for the real-client tests: bencode, a .torrent builder and a tiny HTTP tracker.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

function bencode(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  if (typeof v === 'string') return bencode(Buffer.from(v));
  if (Number.isInteger(v)) return Buffer.from(`i${v}e`);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')]);
  const keys = Object.keys(v).sort();
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap((k) => [bencode(k), bencode(v[k])]), Buffer.from('e')]);
}

/**
 * Builds a multi-file torrent for `dir` (files in the given order).
 * @returns {{ torrent: Buffer, infoHash: string, magnet: string }}
 */
function makeTorrent(dir, files, { name, pieceLength = 256 * 1024, announce }) {
  const data = Buffer.concat(files.map((f) => fs.readFileSync(path.join(dir, f))));
  const pieces = [];
  for (let i = 0; i < data.length; i += pieceLength) pieces.push(crypto.createHash('sha1').update(data.subarray(i, i + pieceLength)).digest());
  const info = {
    name,
    'piece length': pieceLength,
    pieces: Buffer.concat(pieces),
    files: files.map((f) => ({ length: fs.statSync(path.join(dir, f)).size, path: f.split('/') })),
  };
  const infoHash = crypto.createHash('sha1').update(bencode(info)).digest('hex');
  return {
    torrent: bencode({ announce, info }),
    infoHash,
    magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}&tr=${encodeURIComponent(announce)}`,
  };
}

/** HTTP tracker that hands every announcing peer the others (compact form). */
function startTracker(port) {
  const swarms = new Map(); // info_hash (binary string) -> Map("ip:port" -> {ip, port})
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/announce') return res.writeHead(404).end();
    // info_hash is raw bytes, percent-encoded: decode as latin1 to keep each byte.
    const raw = /[?&]info_hash=([^&]*)/.exec(req.url)[1];
    const hash = unescape(raw);
    const ip = req.socket.remoteAddress.replace(/^::ffff:/, '');
    const port = Number(url.searchParams.get('port'));
    const swarm = swarms.get(hash) || new Map();
    swarms.set(hash, swarm);
    if (url.searchParams.get('event') === 'stopped') swarm.delete(`${ip}:${port}`);
    else swarm.set(`${ip}:${port}`, { ip, port });
    const others = [...swarm.values()].filter((p) => !(p.ip === ip && p.port === port));
    const compact = Buffer.concat(
      others.map((p) => Buffer.from([...p.ip.split('.').map(Number), p.port >> 8, p.port & 255]))
    );
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(bencode({ interval: 5, 'min interval': 2, peers: compact }));
  });
  return new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve({ swarms, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) })));
}

module.exports = { bencode, makeTorrent, startTracker };
