import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import type { ToolContext } from '@aipoch/connector-core'
import { eqtlTabixLines, type EqtlRegion } from './humangenetics-eqtl-tabix'

vi.mock('@aipoch/connector-core', async (original) => ({
  ...(await original<typeof import('@aipoch/connector-core')>()),
  abortableDelay: vi.fn(async (ms: number, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    vi.setSystemTime(Date.now() + ms)
  })
}))
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// Independent oracle: scan complete TSV records, not the reader's bins, virtual offsets or chunks.
// Build the point index from individual source lines, including shuffled bins/references, overlapping
// chunks, populated linear indexes, and nonzero offsets within a single BGZF payload.
const names = ['1', '10', '20']
const positions = [
  1, 2, 16383, 16384, 16385, 32768, 32769, 131071, 131072, 131073, 1048575, 1048576, 1048577,
  536870912
]
const records = names.flatMap((chrom) =>
  positions.map((pos, i) => ({ chrom, pos, line: `trait_${chrom}_${i}\t${chrom}\t${pos}\t${i}\n` }))
)
const header = 'molecular_trait_id\tchromosome\tposition\tvalue\n'
const url =
  'https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/sumstats/QTS000002/QTD000021/QTD000021.all.tsv.gz'
const i32 = (value: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeInt32LE(value)
  return b
}
const u64 = (value: bigint): Buffer => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(value)
  return b
}
const text = header + records.map((r) => r.line).join('')
const zip = gzipSync(text)
const extra = Buffer.from([31, 139, 8, 4, 0, 0, 0, 0, 0, 255, 6, 0, 66, 67, 2, 0, 0, 0])
extra.writeUInt16LE(extra.length + zip.length - 11, 16)
const data = Buffer.concat([extra, zip.subarray(10)])
const references = [...names].reverse()
const offsets = new Map<string, { begin: bigint; end: bigint }>()
let address = Buffer.byteLength(header)
for (const r of records) {
  offsets.set(r.line, { begin: BigInt(address), end: BigInt(address + Buffer.byteLength(r.line)) })
  address += Buffer.byteLength(r.line)
}
function index(linear: boolean, level = 5): Buffer {
  const strings = references.join('\0') + '\0'
  const parts: Buffer[] = [
    Buffer.from('TBI\x01'),
    ...[references.length, 0, 2, 3, 3, 35, 1, Buffer.byteLength(strings)].map(i32),
    Buffer.from(strings)
  ]
  for (const chrom of references) {
    const bins = new Map<number, typeof records>()
    for (const r of records.filter((r) => r.chrom === chrom)) {
      // Each chosen container must cover the source point. Vary writer packing independently
      // of the reader: valid chunks can be stored in any covering ancestor, not only a leaf.
      const bin =
        [0, 1, 9, 73, 585, 4681][level] + Math.trunc((r.pos - 1) / Math.pow(2, 29 - 3 * level))
      bins.set(bin, [...(bins.get(bin) ?? []), r])
    }
    parts.push(i32(bins.size))
    for (const [bin, rows] of [...bins].reverse()) {
      // Repeated virtual chunks must not turn one source row into duplicate observations.
      const chunks = rows.flatMap((r) => [offsets.get(r.line)!, offsets.get(r.line)!])
      parts.push(i32(bin), i32(chunks.length), ...chunks.flatMap((c) => [u64(c.begin), u64(c.end)]))
    }
    const intervals = linear ? 32768 : 0
    const linearBytes = Buffer.alloc(intervals * 8)
    for (let i = 0; i < intervals; i++) {
      const first = records.find((r) => r.chrom === chrom && r.pos > i * 16384)
      if (first) linearBytes.writeBigUInt64LE(offsets.get(first.line)!.begin, i * 8)
    }
    parts.push(i32(intervals), linearBytes)
  }
  return gzipSync(Buffer.concat(parts))
}
function context(tbi: Buffer): { ctx: ToolContext; requests: string[]; bytes: () => number } {
  let transferred = 0
  const requests: string[] = []
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected nonbinary request')
  }
  const ctx: ToolContext = {
    credentials: {},
    fetchJson: unexpected,
    fetchText: unexpected,
    fetchJsonWithHeaders: unexpected,
    postJson: unexpected,
    postForm: unexpected,
    rawFetch: async (input, init) => {
      requests.push(String(input))
      if (String(input).endsWith('.tbi')) {
        transferred += tbi.length
        return new Response(Uint8Array.from(tbi))
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')!
      const start = Number(range[1]),
        end = Math.min(Number(range[2]), data.length - 1)
      const body = data.subarray(start, end + 1)
      transferred += body.length
      return new Response(body, {
        status: 206,
        headers: {
          etag: '"oracle-fixture"',
          'content-range': `bytes ${start}-${end}/${data.length}`
        }
      })
    }
  }
  return { ctx, requests, bytes: () => transferred }
}
async function read(
  region: EqtlRegion,
  linear: boolean,
  level = 5
): Promise<{ rows: string[]; requests: number; bytes: number }> {
  const c = context(index(linear, level)),
    rows: string[] = []
  for await (const line of eqtlTabixLines(c.ctx, url, region)) {
    if (line === header.trimEnd()) continue
    const fields = line.split('\t')
    if (
      fields[1] === region.chrom &&
      Number(fields[2]) >= region.start &&
      Number(fields[2]) <= region.end
    )
      rows.push(line)
  }
  return { rows, requests: c.requests.length, bytes: c.bytes() }
}

describe('Tabix full-scan oracle', () => {
  const queries = [
    ...names.flatMap((chrom) => positions.map((pos) => ({ chrom, start: pos, end: pos }))),
    ...names.map((chrom) => ({ chrom, start: 16384, end: 131073 })),
    { chrom: '20', start: 3, end: 16382 },
    { chrom: 'X', start: 1, end: 2 }
  ]
  it.each(queries)('matches an independent full scan at $chrom:$start-$end', async (region) => {
    const expected = records
      .filter((r) => r.chrom === region.chrom && r.pos >= region.start && r.pos <= region.end)
      .map((r) => r.line.trimEnd())
    expect((await read(region, true)).rows).toEqual(expected)
  })
  it.each([0, 1, 2, 3, 4, 5])(
    'matches the full-scan oracle when writer packing uses level %i',
    async (level) => {
      for (const region of [
        { chrom: '1', start: 1, end: 1 },
        { chrom: '20', start: 16384, end: 131073 },
        { chrom: '10', start: 536870912, end: 536870912 }
      ]) {
        const expected = records
          .filter((r) => r.chrom === region.chrom && r.pos >= region.start && r.pos <= region.end)
          .map((r) => r.line.trimEnd())
        expect((await read(region, true, level)).rows).toEqual(expected)
      }
    }
  )
  it('does not decode unrelated 16-KiB bins', async () => {
    const c = context(index(true)),
      candidates: string[] = []
    for await (const line of eqtlTabixLines(c.ctx, url, { chrom: '20', start: 1, end: 1 })) {
      if (line !== header.trimEnd()) candidates.push(line)
    }
    expect(candidates).toEqual(
      records.filter((r) => r.chrom === '20' && r.pos <= 16384).map((r) => r.line.trimEnd())
    )
  })
  it('unused linear-metadata invariance preserves rows and request count on leaf fixtures', async () => {
    for (const region of [
      { chrom: '20', start: 1, end: 1 },
      { chrom: '20', start: 16384, end: 131073 },
      { chrom: '20', start: 3, end: 16382 }
    ]) {
      const baseline = await read(region, true),
        without = await read(region, false)
      expect(without.rows).toEqual(baseline.rows)
      expect(without.requests).toBe(baseline.requests)
      // Only the compressed index metadata differs; data requests are identical.
      expect(without.bytes).toBeLessThanOrEqual(baseline.bytes)
    }
  })
})
