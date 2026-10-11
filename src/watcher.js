// Core watcher: recursive directory monitoring with event classification,
// debounce, and glob filtering. Pure helpers are exported for testing.
'use strict';

const fs = require('fs');
const path = require('path');
const { isWanted, toPosix } = require('./match');

/**
 * Classify a change for relPath given previous snapshot and fresh stat.
 * prev: {size, mtimeMs} | undefined ; stat: fs.Stats | null (null = gone)
 * Returns 'added' | 'modified' | 'deleted' | null (no meaningful change).
 */
function classifyEvent(prev, stat) {
  if (!stat) return prev ? 'deleted' : null;
  if (!prev) return 'added';
  if (stat.size !== prev.size || stat.mtimeMs !== prev.mtimeMs) return 'modified';
  return null; // e.g. chmod-only or duplicate notification
}

function snapOf(stat) {
  return { size: stat.size, mtimeMs: stat.mtimeMs, isDir: stat.isDirectory() };
}

class DirWatcher {
  /**
   * @param {string} root absolute directory to watch
   * @param {object} opts { recursive, include, exclude, debounceMs, onEvent }
   */
  constructor(root, opts = {}) {
    this.root = path.resolve(root);
    this.recursive = !!opts.recursive;
    this.include = opts.include || [];
    this.exclude = opts.exclude || [];
    this.debounceMs = Math.max(0, Number(opts.debounceMs ?? 150));
    this.onEvent = opts.onEvent || (() => {});
    this.watchers = new Map(); // absDir -> fs.FSWatcher
    this.known = new Map();     // relPosix -> snapshot
    this.pending = new Map();   // relPosix -> timeout
    this.running = false;
    this.trackedFiles = 0;
  }

  wanted(rel) { return isWanted(rel, this.include, this.exclude); }

  start() {
    let st;
    try { st = fs.statSync(this.root); }
    catch (e) { throw new Error(`cannot watch "${this.root}": ${e.code === 'ENOENT' ? 'directory does not exist' : e.message}`); }
    if (!st.isDirectory()) throw new Error(`cannot watch "${this.root}": not a directory`);
    this.running = true;
    this._scanDir(this.root, true);
    this._watchDir(this.root);
    if (this.recursive) {
      for (const [rel, snap] of this.known) {
        if (snap.isDir) this._watchDir(path.join(this.root, rel));
      }
    }
    return this;
  }

  stop() {
    this.running = false;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    for (const w of this.watchers.values()) { try { w.close(); } catch { /* noop */ } }
    this.watchers.clear();
  }

  // Initial (silent) scan; counts files.
  _scanDir(absDir, silent) {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const abs = path.join(absDir, e.name);
      const rel = toPosix(path.relative(this.root, abs));
      if (!this.wanted(rel)) continue;
      let s;
      try { s = fs.statSync(abs); } catch { continue; }
      this.known.set(rel, snapOf(s));
      if (!s.isDirectory()) this.trackedFiles += 1;
      if (s.isDirectory() && this.recursive && silent) this._scanDir(abs, true);
    }
  }

  _watchDir(absDir) {
    if (this.watchers.has(absDir)) return;
    let w;
    try { w = fs.watch(absDir, { persistent: true }, (ev, filename) => this._onRaw(ev, absDir, filename)); }
    catch (e) { this.onEvent({ type: 'error', message: `watch failed on ${absDir}: ${e.message}` }); return; }
    w.on('error', (e) => this.onEvent({ type: 'error', message: `watch error on ${absDir}: ${e.message}` }));
    this.watchers.set(absDir, w);
  }

  _onRaw(ev, absDir, filename) {
    if (!this.running || !filename) return;
    const rel = toPosix(path.relative(this.root, path.join(absDir, String(filename))));
    if (!this.wanted(rel)) return;
    if (this.pending.has(rel)) clearTimeout(this.pending.get(rel));
    this.pending.set(rel, setTimeout(() => {
      this.pending.delete(rel);
      this._resolve(rel);
    }, this.debounceMs));
    // Allow the event loop to exit only via explicit stop; keep ref'd timers.
    if (this.pending.get(rel).unref) this.pending.get(rel).unref();
  }

  _resolve(rel) {
    if (!this.running) return;
    const abs = path.join(this.root, rel);
    let stat = null;
    try { stat = fs.statSync(abs); } catch { stat = null; }
    const prev = this.known.get(rel);
    const kind = classifyEvent(prev ? { size: prev.size, mtimeMs: prev.mtimeMs } : undefined, stat);
    if (!kind) return;
    if (kind === 'deleted') this.known.delete(rel);
    else this.known.set(rel, snapOf(stat));
    const isDir = !!stat && stat.isDirectory();
    if (kind === 'added' && isDir && this.recursive) {
      this._scanDir(abs, true);          // learn children silently
      this._watchDir(abs);               // watch the new subtree
    }
    if (isDir) return; // directories themselves are infrastructure, not audit rows
    this.onEvent({
      type: 'event',
      time: new Date().toISOString(),
      event: kind,
      path: rel,
      size: stat ? stat.size : null,
    });
  }
}

module.exports = { DirWatcher, classifyEvent, snapOf };
