// The two things tools.mjs takes from node:crypto, for the pre.dev Chrome extension: random bytes
// (page marks) and a SHA-1 of its own page script (a version tag). Synchronous, as Node's are.

class Bytes extends Uint8Array {
  toString(encoding) {
    if (encoding === 'hex') return [...this].map(b => b.toString(16).padStart(2, '0')).join('');
    if (encoding === 'base64url' || encoding === 'base64') {
      const b64 = btoa(String.fromCharCode(...this));
      return encoding === 'base64' ? b64 : b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return new TextDecoder().decode(this);
  }
}

function randomBytes(n) {
  const out = new Bytes(n);
  crypto.getRandomValues(out);
  return out;
}

function sha1(bytes) {
  const words = new Uint32Array(80);
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32));
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(at + i * 4);
    for (let i = 16; i < 80; i++) words[i] = rotl(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + words[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Bytes(20);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => ov.setUint32(i * 4, h));
  return out;
}

function createHash(algorithm) {
  if (algorithm !== 'sha1') throw new Error(`${algorithm} is not available in the extension.`);
  const parts = [];
  const hash = {
    update(data) { parts.push(typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)); return hash; },
    digest(encoding) {
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) { all.set(p, at); at += p.length; }
      const out = sha1(all);
      return encoding ? out.toString(encoding) : out;
    },
  };
  return hash;
}

export { randomBytes, createHash };
export default { randomBytes, createHash };
