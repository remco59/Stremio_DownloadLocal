// Torrent client registry + facade. The rest of the add-on only talks to this module; the active client
// is looked up per call (cfg.torrentClient), so switching clients needs no restart.
//
// Every client module exports the same interface. All hashes are lower-case info hashes.
//
//   add({ magnet, hash })            add with sequential download (+ first/last piece priority where
//                                    supported) and the add-on's category/label; a duplicate is fine.
//                                    Throws if the client rejects it.
//   info(hashes) -> [{ hash, name, state, error, savePath, progress, size, dlSpeed, eta }]
//                                    state: metadata | queued | checking | downloading | paused | seeding | error
//                                    error: message when the torrent is broken (state 'error'), else null
//                                    Unknown hashes are simply absent.
//   files(hash) -> [{ index, name, size, progress }] | [] (no metadata yet) | null (unknown torrent)
//   pieces(hash) -> { pieceSize, have: boolean[] }
//   setWanted(hash, wantedIndexes, fileCount)   download only these files
//   stop(hash) / start(hash)
//   remove(hash, { deleteFiles })
//   testConnection({ url, user, pass }) -> { ok, version?, warning?, error? }   (no args = saved settings)
//   partialSuffixes: string[]        suffixes the client adds to incomplete files ('.!qB', '.part')
//   partialDirs() -> string[]        extra client-side dirs incomplete files may live in
//   label, settings: { fields, connection }   name and connection fields for the settings page;
//                                    connection maps the field keys to testConnection()'s url/user/pass
//
// To add a client: implement the interface in clients/<name>.js and register it below.
const cfg = require('../config');

const CLIENTS = {
  qbittorrent: require('./qbittorrent'),
  transmission: require('./transmission'),
};

function active() {
  const c = CLIENTS[cfg.torrentClient];
  if (!c) throw new Error(`Unknown torrent client "${cfg.torrentClient}" (known: ${Object.keys(CLIENTS).join(', ')})`);
  return c;
}

module.exports = {
  CLIENTS,
  active,
  add: (opts) => active().add(opts),
  info: (hashes) => active().info(hashes),
  files: (hash) => active().files(hash),
  pieces: (hash) => active().pieces(hash),
  setWanted: (hash, wanted, fileCount) => active().setWanted(hash, wanted, fileCount),
  stop: (hash) => active().stop(hash),
  start: (hash) => active().start(hash),
  remove: (hash, opts) => active().remove(hash, opts),
  testConnection: (opts) => active().testConnection(opts),
  partialSuffixes: () => active().partialSuffixes,
  partialDirs: () => active().partialDirs(),
};
