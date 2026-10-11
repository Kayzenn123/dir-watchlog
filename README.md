# dir-watchlog

> Watch a folder for file changes, log them as an audit trail, and run a command per event. Daily Tools #5.

## Why

Shared folders have a habit of changing when nobody is looking: a download
appears, a config gets edited, a file vanishes, and nobody knows when. Full
monitoring stacks are overkill for a simple "what changed in here?" question.
`dir-watchlog` is one small file with zero dependencies — it watches a
directory (recursively if you want), classifies every change as
added/modified/deleted, and writes timestamped audit rows you can grep, tail,
or feed into a spreadsheet. The closest existing tool found on GitHub
(RaiMUmar/Monitor, 1 star) only appends raw events; dir-watchlog classifies
events via stat, debounces the noisy bursts `fs.watch` produces, filters with
glob include/exclude rules, watches new subdirectories automatically on Linux
(where `fs.watch` is not recursive), and can run your own command per event.

## Install

```bash
git clone https://github.com/Kayzenn123/dir-watchlog.git
cd dir-watchlog
```

No dependencies — just Node.js.

Requires: Node >= 18

You can also run it directly without installing:

```bash
node bin/dir-watchlog.js <dir> [options]
```

## Usage

```bash
dir-watchlog <dir> [options]
```

| Flag | Function | Default |
| --- | --- | --- |
| `-r, --recursive` | watch subdirectories too | off |
| `-i, --include <glob>` | only track paths matching glob (repeatable) | all |
| `-e, --exclude <glob>` | skip paths matching glob (repeatable) | none |
| `--log <file>` | append every event to an audit file | off |
| `--format <fmt>` | audit file format: `jsonl` or `csv` | `jsonl` |
| `--json` | print events as JSON lines on stdout | table |
| `--exec <cmd>` | run shell command per event (env: `DIRWATCH_EVENT`, `DIRWATCH_PATH`, `DIRWATCH_TIME`, `DIRWATCH_SIZE`) | off |
| `--debounce <ms>` | coalesce bursts per path | `150` |
| `-q, --quiet` | no startup banner | off |
| `-h, --help` | show help | — |
| `-V, --version` | show version | — |

Exit codes: `0` ok (Ctrl-C exits cleanly), `1` runtime error, `2` bad arguments.
Colors are used only on a TTY and never when `NO_COLOR` is set.

## Example output

Command:

```bash
dir-watchlog shared
```

(then, in another terminal: create `invoice-okt.pdf`, `foto-liburan-1.jpg`,
`catatan.txt`; edit `catatan.txt`; delete `foto-liburan-1.jpg`)

Output (real, copied from an actual run):

```text
watching /tmp/dwrun/shared (top-level only, debounce 150ms, 0 files tracked)
2026-10-11T03:28:44.860Z  ADDED          24 B  invoice-okt.pdf
2026-10-11T03:28:44.861Z  ADDED          19 B  foto-liburan-1.jpg
2026-10-11T03:28:44.861Z  ADDED          15 B  catatan.txt
2026-10-11T03:28:45.865Z  MODIFIED       24 B  catatan.txt
2026-10-11T03:28:46.872Z  DELETED           -  foto-liburan-1.jpg
stopped, 5 event(s) logged
```

Audit log example — command:

```bash
dir-watchlog proj -r --log logs/audit.jsonl -e "*.tmp"
```

`logs/audit.jsonl` (real, copied from an actual run):

```text
{"type":"event","time":"2026-10-11T03:28:53.682Z","event":"modified","path":"src/app.js","size":25}
{"type":"event","time":"2026-10-11T03:28:55.050Z","event":"deleted","path":"README.md","size":null}
```

Auto-sort example — command:

```bash
dir-watchlog incoming --exec 'if [ "$DIRWATCH_EVENT" = added ]; then case "$DIRWATCH_PATH" in *.txt) cp "$DIRWATCH_PATH" ./sorted/ ;; esac; fi'
```

Every new `.txt` file dropped into `incoming/` is copied to `sorted/`
(real run: `laporan.txt` copied, `data.bin` ignored).

## How it works

1. On start, the tool snapshots the directory (sizes + mtimes) silently and
   registers one `fs.watch` per directory — this is how recursion works on
   Linux, where `fs.watch` is not recursive. New subdirectories get their own
   watcher automatically.
2. Raw watch callbacks are debounced per path (default 150 ms) to coalesce
   the duplicate bursts `fs.watch` is famous for.
3. After the debounce window, the path is re-statted and compared with the
   snapshot: missing snapshot → `added`, missing file → `deleted`, changed
   size/mtime → `modified`, identical → ignored (filters chmod-only noise).
4. Matching events are printed (table or `--json`), appended to `--log`
   (`jsonl` or `csv`), and trigger `--exec` with `DIRWATCH_*` env vars.

File layout: `bin/dir-watchlog.js` (CLI, arg parsing, output formatting),
`src/watcher.js` (watch logic + `classifyEvent`), `src/match.js` (glob
matcher), `test/` (24 tests, run with `npm test`).

## Limitations

- `fs.watch` behavior differs per OS; on very busy directories some rapid
  successive changes to the same file may coalesce into one event (that is
  the debounce doing its job).
- Files created inside a brand-new subdirectory within the debounce window
  may be learned silently during that directory's initial scan instead of
  emitting `added`.
- Directory creations/deletions themselves are not audit rows — only files.
- Keep `--log` and `--exec` outputs outside the watched directory, or their
  writes will trigger new events (a feedback loop).
- `--exec` runs through the system shell; quote paths defensively in your
  command. Symlinked directories are followed by the initial scan.

## Development

```bash
npm test
```

24 tests (glob matcher, event classification, debounce, filters, recursive
watch, CLI end-to-end incl. `--exec`, `--log` jsonl/csv, exit codes), green
twice in a row before release.

## License

MIT

---
Ringkasan (Bahasa Indonesia): dir-watchlog memantau folder dan mencatat setiap
perubahan file (ditambah/diubah/dihapus) sebagai baris audit berstempel waktu
ke terminal atau file (JSONL/CSV), dengan filter glob dan opsi menjalankan
perintah tiap ada kejadian. Cara pakai: `dir-watchlog <folder> -r --log
audit.jsonl`. Batasan utama: perubahan sangat cepat pada file yang sama bisa
tergabung jadi satu event (debounce), dan output --log/--exec jangan ditaruh
di dalam folder yang dipantau.
