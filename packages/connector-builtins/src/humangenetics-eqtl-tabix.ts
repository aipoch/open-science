import { gunzipSync } from 'node:zlib'
import { abortableDelay, ConnectorHttpError, type ToolContext } from '@aipoch/connector-core'

// Read-only, bounded TBI/BGZF access. No executables, downloads to disk or persistent cache.
// https://samtools.github.io/hts-specs/tabix.pdf
export type EqtlRegion = { chrom: string; start: number; end: number }
type Chunk = { start: bigint; end: bigint }
const MAX_COMPRESSED = 16 * 1024 * 1024
const MAX_INFLATED = 64 * 1024 * 1024
const TOO_LARGE =
  'eQTL query exceeds the bounded remote-read budget; use a smaller region or local Tabix for bulk analysis'
let nextRequestAt = 0

async function admit(signal?: AbortSignal): Promise<void> {
  // EBI recommends one remote Tabix request every couple of seconds. Share admission across calls.
  for (;;) {
    signal?.throwIfAborted()
    const wait = nextRequestAt - Date.now()
    if (wait <= 0) {
      nextRequestAt = Date.now() + 2000
      return
    }
    await abortableDelay(wait, signal)
  }
}

async function receive(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!response.body) throw new Error('eQTL file response has no body')
  const reader = response.body.getReader()
  const buffers: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new Error(TOO_LARGE)
      buffers.push(Buffer.from(value))
    }
    return Buffer.concat(buffers, size)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

class RemoteFile {
  private total: number | null = null
  private validator: string | null = null
  private remaining = MAX_COMPRESSED

  constructor(
    private readonly ctx: ToolContext,
    private readonly url: string
  ) {}

  async read(start?: number, end?: number): Promise<Buffer> {
    const { ctx, url } = this
    if (!ctx.rawFetch) throw new Error('Connector runtime does not support eQTL binary reads')
    if (start !== undefined && end! - start + 1 > this.remaining) throw new Error(TOO_LARGE)
    await admit(ctx.signal)
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000)
    const headers: Record<string, string> = { Accept: 'application/octet-stream' }
    if (start !== undefined) {
      headers.Range = `bytes=${start}-${end}`
      if (this.validator) headers['If-Range'] = this.validator
    }
    const response = await ctx.rawFetch(url, { headers, signal, redirect: 'error' })
    try {
      if (response.status !== (start === undefined ? 200 : 206)) {
        if (!response.ok) throw new ConnectorHttpError(response.status, url)
        throw new Error('eQTL server did not honor the byte range; refusing a full-file transfer')
      }
      let expected: number | null = null
      if (start !== undefined) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
        if (!match) throw new Error('Invalid eQTL Content-Range')
        const [from, to, total] = match.slice(1).map(Number)
        if (
          ![from, to, total].every(Number.isSafeInteger) ||
          from !== start ||
          to !== Math.min(end!, total - 1) ||
          total <= to ||
          to < from ||
          (this.total !== null && this.total !== total)
        )
          throw new Error('Mismatched eQTL Content-Range or changed file size')
        this.total = total
        if (this.validator === null) {
          this.validator = response.headers.get('etag')
          if (!this.validator || !/^"[^"\r\n]*"$/.test(this.validator)) {
            throw new Error('eQTL range response requires a strong ETag')
          }
        } else if (response.headers.get('etag') !== this.validator) {
          throw new Error('eQTL file changed during the query')
        }
        expected = to - from + 1
      }
      const body = await receive(
        response,
        Math.min(this.remaining, expected ?? 4 * 1024 * 1024),
        signal
      )
      this.remaining -= body.length
      if (expected !== null && body.length !== expected)
        throw new Error('Incomplete eQTL range response')
      return body
    } catch (error) {
      await response.body?.cancel().catch(() => {})
      throw error
    }
  }
}

// BGZF virtual offsets encode a compressed block address in the high 48 bits and a byte
// offset in its inflated (at most 64 KiB) payload in the low 16 bits.
function block(data: Buffer, offset: number): { bytes: number; payload: Buffer } {
  if (offset + 12 > data.length || data.readUInt32LE(offset) !== 0x04088b1f) {
    throw new Error('Invalid eQTL BGZF header')
  }
  const extraEnd = offset + 12 + data.readUInt16LE(offset + 10)
  let size = 0
  for (let p = offset + 12; p + 4 <= extraEnd && extraEnd <= data.length;) {
    const length = data.readUInt16LE(p + 2)
    if (p + 4 + length > extraEnd) throw new Error('Invalid eQTL BGZF extra field')
    if (data.toString('ascii', p, p + 2) === 'BC' && length === 2)
      size = data.readUInt16LE(p + 4) + 1
    p += 4 + length
  }
  if (size < extraEnd - offset + 8 || size > 65536 || offset + size > data.length) {
    throw new Error('Incomplete or invalid eQTL BGZF block')
  }
  return {
    bytes: size,
    payload: gunzipSync(data.subarray(offset, offset + size), { maxOutputLength: 65536 })
  }
}

function chunksFor(index: Buffer, region: EqtlRegion, decoder: TextDecoder): Chunk[] {
  let offset = 0
  const take = (size: number): number => {
    if (size < 0 || offset + size > index.length)
      throw new Error('Invalid or truncated eQTL TBI index')
    const at = offset
    offset += size
    return at
  }
  const int = (): number => index.readInt32LE(take(4))
  const count = (): number => {
    const n = int()
    if (n < 0 || n > index.length / 4) throw new Error('Invalid eQTL TBI count')
    return n
  }
  if (index.toString('binary', take(4), 4) !== 'TBI\x01')
    throw new Error('Unsupported eQTL index; expected TBI')
  const refs = count()
  const format = int()
  const seqColumn = int()
  const startColumn = int()
  const endColumn = int()
  const comment = int()
  const skip = int()
  // Intentionally support only the official point-coordinate layout, not general interval files.
  if (
    format !== 0 ||
    seqColumn !== 2 ||
    startColumn !== 3 ||
    endColumn !== 3 ||
    comment !== 35 ||
    skip !== 1
  ) {
    throw new Error('Unsupported eQTL Tabix coordinate layout')
  }
  const namesLength = count()
  const names = decoder.decode(index.subarray(take(namesLength), offset)).split('\0')
  if (names.pop() !== '' || names.length !== refs || new Set(names).size !== refs) {
    throw new Error('Invalid eQTL TBI chromosome names')
  }
  // Query every covering TBI level. A point's initial leaf bin does not constrain how a
  // valid index writer may pack/promote its chunks; selection must follow the index protocol.
  const bins = new Set([0])
  for (const [base, width] of [
    [1, 67108864],
    [9, 8388608],
    [73, 1048576],
    [585, 131072],
    [4681, 16384]
  ]) {
    for (
      let bin = base + Math.floor((region.start - 1) / width);
      bin <= base + Math.floor((region.end - 1) / width);
      bin++
    )
      bins.add(bin)
  }
  const chunks: Chunk[] = []
  for (let r = 0; r < refs; r++) {
    const wanted = names[r] === region.chrom
    const nBins = count()
    for (let b = 0; b < nBins; b++) {
      const bin = index.readUInt32LE(take(4))
      if (bin > 37448 && bin !== 37450) throw new Error('Invalid eQTL TBI bin')
      const nChunks = count()
      for (let c = 0; c < nChunks; c++) {
        const start = index.readBigUInt64LE(take(8))
        const end = index.readBigUInt64LE(take(8))
        if (wanted && bins.has(bin)) {
          if (end < start) throw new Error('Invalid eQTL TBI chunk')
          chunks.push({ start, end })
        }
      }
    }
    const nIntervals = count()
    take(nIntervals * 8) // Validated but not used: binning alone covers every indexed point.
  }
  if (offset !== index.length && offset + 8 !== index.length)
    throw new Error('Invalid eQTL TBI trailing data')
  chunks.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  const merged: Chunk[] = []
  for (const chunk of chunks) {
    const previous = merged.at(-1)
    if (previous && chunk.start <= previous.end)
      previous.end = chunk.end > previous.end ? chunk.end : previous.end
    else merged.push({ ...chunk })
  }
  return merged
}

export async function* eqtlTabixLines(
  ctx: ToolContext,
  url: string,
  region: EqtlRegion
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const indexBytes = await new RemoteFile(ctx, `${url}.tbi`).read()
  const index = gunzipSync(indexBytes, { maxOutputLength: MAX_INFLATED })
  const chunks = chunksFor(index, region, decoder)
  const file = new RemoteFile(ctx, url)
  const first = await file.read(0, 65535)
  const payload = block(first, 0).payload
  const lineEnd = payload.indexOf(10)
  const header = decoder
    .decode(payload.subarray(0, lineEnd < 0 ? payload.length : lineEnd))
    .replace(/\r$/, '')
  const names = header.split('\t')
  if (names[1] !== 'chromosome' || names[2] !== 'position')
    throw new Error('eQTL header coordinate columns disagree with the TBI layout')
  yield header
  let inflated = 0
  for (const chunk of chunks) {
    ctx.signal?.throwIfAborted()
    const from = Number(chunk.start >> 16n)
    const last = Number(chunk.end >> 16n)
    const endOffset = Number(chunk.end & 65535n)
    const to = endOffset ? last + 65535 : last - 1
    const data = from === 0 && to < first.length ? first : await file.read(from, to)
    let offset = 0
    const parts: Buffer[] = []
    for (;;) {
      const address = from + offset
      if (address > last || (address === last && endOffset === 0)) break
      const current = block(data, offset)
      const begin = offset === 0 ? Number(chunk.start & 65535n) : 0
      const end = address === last ? endOffset : current.payload.length
      if (begin > end || end > current.payload.length)
        throw new Error('Invalid eQTL BGZF virtual offset')
      parts.push(current.payload.subarray(begin, end))
      inflated += current.payload.length
      if (inflated > MAX_INFLATED) throw new Error(TOO_LARGE)
      offset += current.bytes
      if (address === last) break
    }
    const text = decoder.decode(Buffer.concat(parts))
    if (text && !text.endsWith('\n')) throw new Error('Incomplete eQTL Tabix record')
    for (const line of text.split('\n')) {
      if (line && line.replace(/\r$/, '') !== header) yield line.replace(/\r$/, '')
    }
  }
}
