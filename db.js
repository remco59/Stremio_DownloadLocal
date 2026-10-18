// Tiny JSON-file store. One record per Stremio ID (e.g. "tt0133093" or "tt0944947:1:2").
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./config');

class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'state.json');
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* first run */
    }
  }

  get(id) {
    return this.data[id] || null;
  }

  all() {
    return Object.values(this.data);
  }

  set(id, patch) {
    const prev = this.data[id];
    const next = { ...(prev || { id }), ...patch };
    if (prev) {
      const same = Object.keys(next).every(
        (k) => k === 'updatedAt' || JSON.stringify(next[k]) === JSON.stringify(prev[k])
      );
      if (same) return prev;
    }
    next.updatedAt = Date.now();
    this.data[id] = next;
    this.save();
    return next;
  }

  delete(id) {
    if (!(id in this.data)) return false;
    delete this.data[id];
    this.save();
    return true;
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = new Store(dataDir);
