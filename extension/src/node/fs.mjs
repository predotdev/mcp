// The extension has no files: every read finds nothing and every write is refused, so the parts of
// tools.mjs that need this computer's files (uploads, the handed-task list) say so instead.
const none = path => Object.assign(new Error(`ENOENT: no files in the pre.dev extension (${path})`), { code: 'ENOENT' });
const fs = {
  readFileSync(path) { throw none(path); },
  writeFileSync(path) { throw none(path); },
  renameSync(path) { throw none(path); },
  realpathSync(path) { throw none(path); },
  statSync(path) { throw none(path); },
  existsSync() { return false; },
  mkdirSync() {},
  rmSync() {},
};
export default fs;
