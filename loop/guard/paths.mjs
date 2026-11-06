// Path helpers shared by the guard and the pre-merge checks. Windows paths arrive as C:\…\x and
// must match the same rules as POSIX paths.

import path from 'node:path';

export const toPosix = (p) => String(p || '').replace(/\\/g, '/');

/** `p` relative to `root`, with forward slashes. Null when `p` lies outside `root`. */
export function repoRelative(root, p) {
  if (!p) return null;
  const abs = path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ? p : path.join(root, p);
  let rel = toPosix(path.relative(root, abs));
  if (process.platform === 'win32' || /^[A-Za-z]:/.test(root)) {
    // Drive letters and case differ between tools on Windows.
    const r = toPosix(path.resolve(root)).toLowerCase();
    const a = toPosix(path.resolve(abs));
    if (a.toLowerCase().startsWith(r + '/')) rel = a.slice(r.length + 1);
    else if (a.toLowerCase() === r) rel = '';
  }
  if (rel.startsWith('../') || rel === '..' || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
  return rel;
}

/** A small glob: `**` any depth, `*` within one segment, `?` one char. A pattern without `/` also matches any basename. */
export function globToRegExp(glob) {
  const g = toPosix(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(g.includes('/') ? `^${re}$` : `(^|/)${re}$`, 'i');
}

export function matchesAny(rel, globs) {
  return (globs || []).some((g) => globToRegExp(g).test(rel));
}
