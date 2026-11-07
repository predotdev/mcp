// POSIX path helpers, enough for what tools.mjs does with paths (none of them name a real file here).
const norm = p => {
  const abs = p.startsWith('/');
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (out.length && out.at(-1) !== '..') out.pop(); else if (!abs) out.push('..'); } else out.push(part);
  }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
};
const path = {
  sep: '/',
  join: (...parts) => norm(parts.filter(Boolean).join('/')),
  resolve: (...parts) => { let p = ''; for (const part of parts) p = String(part).startsWith('/') ? String(part) : `${p}/${part}`; return norm(p.startsWith('/') ? p : `/${p}`); },
  basename: p => String(p).replace(/\/+$/, '').split('/').pop() || '',
  dirname: p => { const n = norm(String(p)); const i = n.lastIndexOf('/'); return i <= 0 ? (n.startsWith('/') ? '/' : '.') : n.slice(0, i); },
  isAbsolute: p => String(p).startsWith('/'),
  relative(from, to) {
    const a = path.resolve(from).split('/').filter(Boolean);
    const b = path.resolve(to).split('/').filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
  },
};
export default path;
