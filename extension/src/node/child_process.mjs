// No programs to run from the extension.
export function execFile(file, args, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  queueMicrotask(() => done?.(new Error(`${file} is not available in the pre.dev extension.`), '', ''));
}
