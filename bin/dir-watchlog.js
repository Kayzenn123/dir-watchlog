#!/usr/bin/env node
// dir-watchlog — watch a folder for file changes, log an audit trail,
// optionally run a command per event. Zero dependencies.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DirWatcher } = require('../src/watcher');

const VERSION = '1.0.0';
const FORMATS = ['jsonl', 'csv'];
const EVENT_COLORS = { added: 32, modified: 33, deleted: 31 };

function help() {
  return `dir-watchlog ${VERSION} — folder change monitor with audit log

Usage:
  dir-watchlog <dir> [options]

Options:
  -r, --recursive        watch subdirectories too
  -i, --include <glob>   only track paths matching glob (repeatable)
  -e, --exclude <glob>   skip paths matching glob (repeatable)
      --log <file>       append every event to an audit file
      --format <fmt>     audit file format: jsonl (default) or csv
      --json             print events as JSON lines on stdout
      --exec <cmd>       run shell command per event; env gets
                         DIRWATCH_EVENT, DIRWATCH_PATH, DIRWATCH_TIME, DIRWATCH_SIZE
      --debounce <ms>    coalesce bursts per path (default 150)
  -q, --quiet            no startup banner
  -h, --help             show this help
  -V, --version          show version

Exit codes: 0 ok (Ctrl-C exits cleanly), 1 runtime error, 2 bad arguments.

Examples:
  dir-watchlog ~/Downloads --log changes.jsonl
  dir-watchlog ./src -r -e "*.map" --json
  dir-watchlog ./incoming --exec 'cp "$DIRWATCH_PATH" ./sorted/'

Note: keep --log and --exec outputs outside the watched directory,
or their writes will trigger new events.`;
}

function failUsage(msg) {
  process.stderr.write(`error: ${msg}\nRun 'dir-watchlog --help' for usage.\n`);
  process.exit(2);
}

function failRuntime(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const o = {
    dir: null, recursive: false, include: [], exclude: [],
    log: null, format: 'jsonl', json: false, exec: null,
    debounceMs: 150, quiet: false,
  };
  const args = argv.slice();
  const takeVal = (flag, cur) => {
    const eq = cur.indexOf('=');
    if (eq !== -1) return cur.slice(eq + 1);
    if (args.length === 0) failUsage(`${flag} needs a value`);
    return args.shift();
  };
  while (args.length) {
    const a = args.shift();
    if (a === '--') { if (args.length && !o.dir) o.dir = args.shift(); else if (args.length) failUsage('only one directory can be watched'); }
    else if (a === '-h' || a === '--help') { process.stdout.write(help() + '\n'); process.exit(0); }
    else if (a === '-V' || a === '--version') { process.stdout.write(VERSION + '\n'); process.exit(0); }
    else if (a === '-r' || a === '--recursive') o.recursive = true;
    else if (a === '-q' || a === '--quiet') o.quiet = true;
    else if (a === '--json') o.json = true;
    else if (a === '-i' || a.startsWith('--include')) o.include.push(takeVal('--include', a));
    else if (a === '-e' || a.startsWith('--exclude')) o.exclude.push(takeVal('--exclude', a));
    else if (a.startsWith('--log')) o.log = takeVal('--log', a);
    else if (a.startsWith('--exec')) o.exec = takeVal('--exec', a);
    else if (a.startsWith('--debounce')) {
      const v = Number(takeVal('--debounce', a));
      if (!Number.isFinite(v) || v < 0) failUsage('--debounce needs a non-negative number of ms');
      o.debounceMs = v;
    }
    else if (a.startsWith('--format')) {
      const v = takeVal('--format', a).toLowerCase();
      if (!FORMATS.includes(v)) failUsage(`--format must be one of: ${FORMATS.join(', ')}`);
      o.format = v;
    }
    else if (a.startsWith('-')) failUsage(`unknown option: ${a}`);
    else if (!o.dir) o.dir = a;
    else failUsage('only one directory can be watched');
  }
  if (!o.dir) failUsage('a directory to watch is required');
  return o;
}

function useColor() {
  return !process.env.NO_COLOR && !!process.stdout.isTTY;
}

function humanSize(n) {
  if (n === null || n === undefined) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return (u === 0 ? String(v) : v.toFixed(1)) + ' ' + units[u];
}

function formatTable(ev) {
  const c = EVENT_COLORS[ev.event];
  const label = ev.event.toUpperCase().padEnd(8);
  const colored = useColor() ? `\x1b[${c}m${label}\x1b[0m` : label;
  return `${ev.time}  ${colored}  ${humanSize(ev.size).padStart(9)}  ${ev.path}`;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function formatCsv(ev) {
  return [ev.time, ev.event, ev.path, ev.size ?? ''].map(csvCell).join(',');
}

const CSV_HEADER = 'time,event,path,size';

function main() {
  const o = parseArgs(process.argv.slice(2));
  const root = path.resolve(o.dir);

  let logStream = null;
  if (o.log) {
    const logPath = path.resolve(o.log);
    try {
      const exists = fs.existsSync(logPath) && fs.statSync(logPath).size > 0;
      logStream = fs.createWriteStream(logPath, { flags: 'a' });
      if (o.format === 'csv' && !exists) logStream.write(CSV_HEADER + '\n');
    } catch (e) { failRuntime(`cannot open log file "${o.log}": ${e.message}`); }
    logStream.on('error', (e) => { process.stderr.write(`error: log write failed: ${e.message}\n`); process.exit(1); });
  }

  let count = 0;
  const watcher = new DirWatcher(root, {
    recursive: o.recursive,
    include: o.include,
    exclude: o.exclude,
    debounceMs: o.debounceMs,
    onEvent: (m) => {
      if (m.type === 'error') { process.stderr.write(`watch error: ${m.message}\n`); return; }
      count += 1;
      process.stdout.write((o.json ? JSON.stringify(m) : formatTable(m)) + '\n');
      if (logStream) logStream.write((o.format === 'csv' ? formatCsv(m) : JSON.stringify(m)) + '\n');
      if (o.exec) {
        const child = spawn(o.exec, {
          shell: true,
          env: {
            ...process.env,
            DIRWATCH_EVENT: m.event,
            DIRWATCH_PATH: path.join(root, m.path),
            DIRWATCH_TIME: m.time,
            DIRWATCH_SIZE: String(m.size ?? ''),
          },
          stdio: 'inherit',
        });
        child.on('error', (e) => process.stderr.write(`exec failed: ${e.message}\n`));
      }
    },
  });

  try { watcher.start(); }
  catch (e) { failRuntime(e.message); }

  if (!o.quiet) {
    process.stderr.write(
      `watching ${root} (${o.recursive ? 'recursive' : 'top-level only'}, ` +
      `debounce ${o.debounceMs}ms, ${watcher.trackedFiles} files tracked)` +
      (o.log ? ` -> audit log ${path.resolve(o.log)} (${o.format})` : '') + '\n'
    );
  }

  const shutdown = () => {
    watcher.stop();
    const done = () => { process.stderr.write(`stopped, ${count} event(s) logged\n`); process.exit(0); };
    if (logStream) logStream.end(done); else done();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
