// Leave ample space for the RPC envelope, totals and progress under the Web 16 MiB limit.
const PAGE_BYTES = 10 * 1024 * 1024
export function boundedLiteraturePage<T>(
  rows: T[],
  offset = 0,
  limit = rows.length,
  oversized: (row: T) => Error = () =>
    new Error('This reference is too large to display. Export it to read the complete metadata.')
): { entries: T[]; nextOffset?: number } {
  const entries: T[] = []
  let bytes = 2
  for (let index = offset; index < Math.min(rows.length, offset + limit); index++) {
    const size = Buffer.byteLength(JSON.stringify(rows[index])) + 1
    if (bytes + size > PAGE_BYTES) {
      if (entries.length === 0) throw oversized(rows[index])
      break
    }
    entries.push(rows[index])
    bytes += size
  }
  const next = offset + entries.length
  return { entries, nextOffset: next < rows.length ? next : undefined }
}
