// Minimal glob matcher (zero dependencies).
// Supports: * (within one segment), ** (across segments), ? (one char),
// {a,b} alternation, [abc] classes. Paths use posix separators.
'use strict';

function globToRegExp(glob) {
  let re = '';
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' -> zero or more segments; '**' alone -> anything
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; }
        else { re += '.*'; i += 2; }
      } else { re += '[^/]*'; i += 1; }
    } else if (c === '?') { re += '[^/]'; i += 1; }
    else if (c === '{') {
      const j = glob.indexOf('}', i);
      if (j === -1) { re += '\\{'; i += 1; }
      else {
        re += '(?:' + glob.slice(i + 1, j).split(',').map(escapeAlt).join('|') + ')';
        i = j + 1;
      }
    } else if (c === '[') {
      const j = glob.indexOf(']', i + 1);
      if (j === -1) { re += '\\['; i += 1; }
      else { re += glob.slice(i, j + 1); i = j + 1; }
    } else if ('\\.+^$()|'.includes(c)) { re += '\\' + c; i += 1; }
    else { re += c; i += 1; }
  }
  return new RegExp('^(?:' + re + ')$');
}

function escapeAlt(s) {
  return s.replace(/[\\.+^$()|]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
}

function toPosix(p) { return String(p).split('\\').join('/'); }

/**
 * True when relPath matches at least one pattern.
 * A bare filename pattern like "*.log" also matches inside subdirectories.
 */
function matchesAny(relPath, patterns) {
  const list = (patterns || []).filter(Boolean);
  if (list.length === 0) return false;
  const p = toPosix(relPath);
  return list.some((g) => {
    const gg = toPosix(g);
    const candidates = gg.includes('/') || gg.startsWith('**') ? [gg] : [gg, '**/' + gg];
    return candidates.some((c) => globToRegExp(c).test(p));
  });
}

/** True when relPath passes the include/exclude filter rules. */
function isWanted(relPath, include, exclude) {
  const inc = (include || []).filter(Boolean);
  const exc = (exclude || []).filter(Boolean);
  if (exc.length > 0 && matchesAny(relPath, exc)) return false;
  if (inc.length > 0 && !matchesAny(relPath, inc)) return false;
  return true;
}

module.exports = { globToRegExp, matchesAny, isWanted, toPosix };
