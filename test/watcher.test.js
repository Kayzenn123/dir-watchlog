'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DirWatcher, classifyEvent } = require('../src/watcher');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until cond() is true or timeout ms elapses. */
async function waitFor(cond, timeout = 8000, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error('timed out waiting for: ' + what);
}

describe('classifyEvent (pure)', () => {
  it('added when no previous snapshot', () => {
    assert.equal(classifyEvent(undefined, { size: 10, mtimeMs: 5 }), 'added');
  });
  it('deleted when stat is gone', () => {
    assert.equal(classifyEvent({ size: 10, mtimeMs: 5 }, null), 'deleted');
    assert.equal(classifyEvent(undefined, null), null);
  });
  it('modified when size or mtime changed', () => {
    assert.equal(classifyEvent({ size: 10, mtimeMs: 5 }, { size: 11, mtimeMs: 5 }), 'modified');
    assert.equal(classifyEvent({ size: 10, mtimeMs: 5 }, { size: 10, mtimeMs: 6 }), 'modified');
  });
  it('null when nothing meaningful changed (chmod-only noise)', () => {
    assert.equal(classifyEvent({ size: 10, mtimeMs: 5 }, { size: 10, mtimeMs: 5 }), null);
  });
});

describe('DirWatcher integration', () => {
  let dir;
  let watcher;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-')); });
  afterEach(() => { if (watcher) watcher.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('emits added/modified/deleted for real file operations', async () => {
    const events = [];
    watcher = new DirWatcher(dir, { debounceMs: 30, onEvent: (m) => { if (m.type === 'event') events.push(m); } });
    watcher.start();
    const kinds = () => events.map((e) => e.event);
    const f = path.join(dir, 'note.txt');
    fs.writeFileSync(f, 'hello');
    await waitFor(() => kinds().includes('added'), 8000, 'added event');
    fs.writeFileSync(f, 'hello world, edited');
    await waitFor(() => kinds().includes('modified'), 8000, 'modified event');
    fs.rmSync(f);
    await waitFor(() => kinds().includes('deleted'), 8000, 'deleted event');
    const added = events.find((e) => e.event === 'added');
    assert.equal(added.path, 'note.txt');
    assert.ok(added.time);
    assert.equal(typeof added.size, 'number');
  });

  it('coalesces rapid bursts into one event per path', async () => {
    const events = [];
    watcher = new DirWatcher(dir, { debounceMs: 200, onEvent: (m) => { if (m.type === 'event') events.push(m); } });
    watcher.start();
    const f = path.join(dir, 'burst.txt');
    for (let i = 0; i < 5; i++) fs.writeFileSync(f, 'v' + i);
    await waitFor(() => events.length >= 1, 8000, 'first event');
    await sleep(600); // let any stray duplicate arrive
    assert.equal(events.length, 1, 'expected 1 coalesced event, got ' + events.length);
    assert.equal(events[0].event, 'added');
  });

  it('respects exclude patterns', async () => {
    const events = [];
    watcher = new DirWatcher(dir, { debounceMs: 30, exclude: ['*.tmp'], onEvent: (m) => { if (m.type === 'event') events.push(m); } });
    watcher.start();
    fs.writeFileSync(path.join(dir, 'skip.tmp'), 'x');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    await waitFor(() => events.some((e) => e.path === 'keep.txt'), 8000, 'keep.txt event');
    await sleep(300);
    assert.ok(events.every((e) => e.path === 'keep.txt'));
  });

  it('watches new subdirectories when recursive', async () => {
    const events = [];
    watcher = new DirWatcher(dir, { debounceMs: 30, recursive: true, onEvent: (m) => { if (m.type === 'event') events.push(m); } });
    watcher.start();
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    await waitFor(() => watcher.watchers.has(sub), 8000, 'subdir watcher registered');
    fs.writeFileSync(path.join(sub, 'deep.txt'), 'deep');
    await waitFor(() => events.some((e) => e.path === 'sub/deep.txt'), 8000, 'nested file event');
  });

  it('throws a clear error for a missing directory', () => {
    assert.throws(() => new DirWatcher(path.join(dir, 'nope')).start(), /does not exist/);
  });
});
