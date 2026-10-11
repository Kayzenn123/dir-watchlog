'use strict';
// End-to-end CLI tests: spawn the real binary as a child process.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'dir-watchlog.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeout = 15000, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await cond()) return; } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error('timed out waiting for: ' + what);
}

function runSync(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

// Start the watcher; `ready` resolves when the startup banner hits stderr
// (so the watcher is guaranteed up before the test touches the directory).
// Do NOT pass --quiet to launch(): the banner is the readiness signal.
function launch(dir, args = []) {
  const child = spawn(process.execPath, [BIN, dir, '--debounce', '30', ...args], { encoding: 'utf8' });
  let out = '', err = '';
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* noop */ }
    readyReject(new Error('watcher never became ready, stderr was: ' + err));
  }, 20000);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => {
    err += d;
    if (String(d).includes('watching')) { clearTimeout(timer); readyResolve(); }
  });
  child.on('error', (e) => { clearTimeout(timer); readyReject(e); });
  return {
    child,
    ready,
    text: () => ({ out, err }),
    stop: () => new Promise((resolve) => { child.on('exit', resolve); child.kill('SIGINT'); setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 5000); }),
  };
}

describe('CLI end-to-end', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwcli-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('--help exits 0 and shows usage', () => {
    const r = runSync(['--help']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('Usage:'));
    assert.ok(r.stdout.includes('--exec'));
  });

  it('--version prints semver', () => {
    const r = runSync(['--version']);
    assert.equal(r.status, 0);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('unknown option exits 2', () => {
    const r = runSync([dir, '--bogus']);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('unknown option'));
  });

  it('missing directory exits 2', () => {
    const r = runSync(['--json']);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('required'));
  });

  it('nonexistent directory exits 1 with actionable message', () => {
    const r = runSync([path.join(dir, 'nope')]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('does not exist'));
  });

  it('emits JSON event lines for added files and exits 0 on SIGINT', async () => {
    const w = launch(dir, ['--json']);
    await w.ready;
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi');
    await waitFor(() => w.text().out.includes('"event":"added"'), 15000, 'added JSON line');
    const code = await w.stop();
    assert.equal(code, 0);
    const lines = w.text().out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const added = lines.find((e) => e.event === 'added' && e.path === 'hello.txt');
    assert.ok(added, 'no added event in: ' + w.text().out);
    assert.equal(added.size, 2);
  });

  it('--log appends JSONL audit rows', async () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwout-'));
    const log = path.join(outdir, 'audit.jsonl');
    const w = launch(dir, ['--log', log]);
    await w.ready;
    fs.writeFileSync(path.join(dir, 'a.txt'), '1');
    await waitFor(() => {
      const t = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      return t.includes('"event":"added"') && t.includes('"path":"a.txt"');
    }, 15000, 'added row in log');
    fs.writeFileSync(path.join(dir, 'a.txt'), '22');
    await waitFor(() => {
      const t = fs.readFileSync(log, 'utf8');
      return t.includes('"event":"modified"');
    }, 15000, 'modified row in log');
    await w.stop();
    const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.event === 'added' && r.path === 'a.txt'));
    assert.ok(rows.some((r) => r.event === 'modified' && r.path === 'a.txt'));
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  it('--log --format csv writes header and escaped rows', async () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwout-'));
    const log = path.join(outdir, 'audit.csv');
    const w = launch(dir, ['--log', log, '--format', 'csv']);
    await w.ready;
    fs.writeFileSync(path.join(dir, 'weird,name".txt'), 'x');
    await waitFor(() => {
      const t = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      return t.includes('"weird,name"".txt"');
    }, 15000, 'escaped csv row');
    await w.stop();
    const text = fs.readFileSync(log, 'utf8');
    assert.ok(text.startsWith('time,event,path,size\n'));
    assert.ok(text.includes('"weird,name"".txt"'), 'csv escaping broken: ' + text);
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  it('--exec runs the command with DIRWATCH_* env vars', async () => {
    // NOTE: the marker must live OUTSIDE the watched dir, otherwise the
    // exec output triggers the watcher itself (documented limitation).
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwout-'));
    const marker = path.join(outdir, 'marker.txt');
    const w = launch(dir, ['--exec', `printf '%s|%s' "$DIRWATCH_EVENT" "$DIRWATCH_PATH" > "${marker}"`]);
    await w.ready;
    fs.writeFileSync(path.join(dir, 'trigger.txt'), 'go');
    await waitFor(() => fs.existsSync(marker), 15000, 'exec marker');
    await w.stop();
    const content = fs.readFileSync(marker, 'utf8');
    assert.ok(content.startsWith('added|'), 'bad env: ' + content);
    assert.ok(content.endsWith('trigger.txt'), 'bad path env: ' + content);
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  it('NO_COLOR disables ANSI codes', async () => {
    const w = launch(dir, []);
    await w.ready;
    // piped stdout is not a TTY, so no escape codes may appear
    fs.writeFileSync(path.join(dir, 'plain.txt'), 'x');
    await waitFor(() => w.text().out.includes('plain.txt'), 15000, 'plain event line');
    await w.stop();
    assert.ok(!w.text().out.includes('\x1b['), 'found ANSI codes in output');
  });
});
