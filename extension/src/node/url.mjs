export function fileURLToPath(value) { throw new Error(`No files in the pre.dev extension (${String(value).slice(0, 60)})`); }
export function pathToFileURL(value) { return new URL(`file://${value}`); }
