/** Upper bound for an unpacked file; a gzip bomb must not fill the memory. */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

export function isGzipName(filename: string): boolean {
  return /\.gz$/i.test(filename);
}

/** `daten.csv.gz` → `daten.csv`. */
export function stripGzipSuffix(filename: string): string {
  return filename.replace(/\.gz$/i, '');
}

/** Unpacks a gzip file with the platform's own decompressor. */
export async function gunzip(bytes: Uint8Array, filename: string): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error(`"${filename}" ist keine gzip-Datei.`);
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Dieses System kann gzip-Dateien nicht entpacken (macOS 13.3 oder neuer nötig).');
  }
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UNPACKED_BYTES) {
        await reader.cancel();
        throw new Error(`"${filename}" ist entpackt größer als 1 GB und wird nicht geöffnet.`);
      }
      chunks.push(value);
    }
  } catch (err: any) {
    if (err instanceof Error && err.message.includes('1 GB')) throw err;
    throw new Error(`"${filename}" konnte nicht entpackt werden: ${err?.message || err}`);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
