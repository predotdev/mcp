#!/usr/bin/env node
// Builds the pre.dev Chrome extension into extension/dist (unpacked, for chrome://extensions "Load
// unpacked" or --load-extension) and a zip next to it. The chrome_* tools and their guard are this
// package's own src/tools.mjs and src/web_rules.mjs, copied in unchanged except that their node:
// imports point at the small stand-ins in extension/src/node.
//
//   node extension/build.mjs                       the build for api.pre.dev
//   node extension/build.mjs --dev --api <url>     a development build against another pre.dev API

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };

const dev = flag('--dev');
const apiUrl = String(option('--api', 'https://api.pre.dev')).replace(/\/+$/, '');
if (!dev && apiUrl !== 'https://api.pre.dev') throw new Error('--api is for development builds (--dev) only.');
const out = path.resolve(option('--out', path.join(here, 'dist')));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'lib'), { recursive: true });

const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name);
    const b = path.join(to, name);
    if (fs.statSync(a).isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
};
copyDir(path.join(here, 'src'), out);
copyDir(path.join(here, 'icons'), path.join(out, 'icons'));

// The shared modules, with their node: imports pointed at the stand-ins.
const NODE_IMPORT = /^import\s+(.+?)\s+from\s+'node:([a-z_]+)';$/gm;
for (const name of ['tools.mjs', 'web_rules.mjs']) {
  let source = fs.readFileSync(path.join(root, 'src', name), 'utf8');
  const used = new Set();
  source = source.replace(NODE_IMPORT, (_, what, mod) => {
    if (!fs.existsSync(path.join(here, 'src', 'node', `${mod}.mjs`))) throw new Error(`${name} imports node:${mod}, which the extension has no stand-in for.`);
    used.add(mod);
    return `import ${what} from '../node/${mod}.mjs';`;
  });
  if (/from\s+'node:/.test(source) || /require\(/.test(source)) throw new Error(`${name} still reaches Node directly.`);
  if (/\bprocess\./.test(source)) source = `import process from '../node/process.mjs';\n${source}`;
  fs.writeFileSync(path.join(out, 'lib', name), source);
}

fs.writeFileSync(path.join(out, 'config.mjs'),
  `// Written by extension/build.mjs.\nexport const CONFIG = ${JSON.stringify({ apiUrl, dev, version: pkg.version })};\n`);

const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
if (dev) {
  manifest.name = 'pre.dev (development)';
  const origin = new URL(apiUrl);
  manifest.host_permissions = [...new Set([...manifest.host_permissions, `${origin.protocol}//${origin.hostname}/*`])];
}
fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const files = [];
const walk = dir => { for (const name of fs.readdirSync(dir).sort()) { const p = path.join(dir, name); if (fs.statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(out);

// Every script parses, and nothing in the build asks Chrome for cookies.
for (const f of files.filter(f => f.endsWith('.mjs'))) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
if (manifest.permissions.includes('cookies') || files.some(f => /\.(mjs|html)$/.test(f) && /chrome\.cookies|Network\.getAllCookies|Network\.getCookies|Storage\.getCookies/.test(fs.readFileSync(f, 'utf8')))) {
  throw new Error('The extension must never read cookies.');
}

// A plain zip (deflated, fixed timestamps): the same bytes for the same files.
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const local = [];
const central = [];
let offset = 0;
for (const f of files) {
  const name = Buffer.from(path.relative(out, f).split(path.sep).join('/'));
  const data = fs.readFileSync(f);
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0, 6); head.writeUInt16LE(8, 8);
  head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12); head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(deflated.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
  local.push(head, name, deflated);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0, 8); entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(0, 12); entry.writeUInt16LE(0x21, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(deflated.length, 20);
  entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += head.length + name.length + deflated.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
const zipFile = path.join(path.dirname(out), `predev-chrome-extension-${pkg.version}${dev ? '-dev' : ''}.zip`);
fs.writeFileSync(zipFile, Buffer.concat([...local, ...central, end]));

console.log(`Built ${path.relative(root, out)} (${files.length} files${dev ? `, development build for ${apiUrl}` : ''}) and ${path.relative(root, zipFile)}`);
console.log(`Permissions: ${manifest.permissions.join(', ')}; hosts: ${manifest.host_permissions.join(', ')}`);
