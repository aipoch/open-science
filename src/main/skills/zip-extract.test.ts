import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { SKILL_IMPORT_LIMITS } from './import-limits'
import { extractZip, extractZipLenient } from './zip-extract'

// CRC-32 (used only to build genuinely valid local/central headers in the test archives).
const crcTable = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = (buffer: Buffer): number => {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

type ZipInput = { path: string; content: Buffer; method: 0 | 8 }

// Hand-assembles a minimal but structurally valid ZIP (local headers + data, central directory, EOCD)
// so the test proves extractZip decodes a real byte layout — not a mock.
const buildZip = (inputs: ZipInput[]): Buffer => {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const input of inputs) {
    const nameBuf = Buffer.from(input.path, 'utf8')
    const stored = input.method === 8 ? deflateRawSync(input.content) : input.content
    const crc = crc32(input.content)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(input.method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(input.content.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    locals.push(local, stored)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(input.method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(input.content.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)

    offset += local.length + stored.length
  }

  const localBuf = Buffer.concat(locals)
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(inputs.length, 8)
  eocd.writeUInt16LE(inputs.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)

  return Buffer.concat([localBuf, centralBuf, eocd])
}

describe('extractZip', () => {
  it('decodes STORE and DEFLATE entries from a real zip byte layout', () => {
    const skill = Buffer.from('---\nname: Foo\n---\nbody', 'utf8')
    const helper = Buffer.from('print("hello from a deflated file")', 'utf8')

    const files = extractZip(
      buildZip([
        { path: 'SKILL.md', content: skill, method: 0 },
        { path: 'references/helper.py', content: helper, method: 8 }
      ])
    )

    expect(files).toHaveLength(2)
    expect(files.find((file) => file.path === 'SKILL.md')?.content.toString('utf8')).toBe(
      skill.toString('utf8')
    )
    expect(
      files.find((file) => file.path === 'references/helper.py')?.content.toString('utf8')
    ).toBe(helper.toString('utf8'))
  })

  it('skips directories, __MACOSX metadata, root dotfiles, and zip-slip paths', () => {
    const files = extractZip(
      buildZip([
        { path: 'skill/', content: Buffer.alloc(0), method: 0 },
        { path: 'skill/SKILL.md', content: Buffer.from('ok', 'utf8'), method: 0 },
        { path: '__MACOSX/skill/._SKILL.md', content: Buffer.from('junk', 'utf8'), method: 0 },
        { path: '.DS_Store', content: Buffer.from('junk', 'utf8'), method: 0 },
        { path: '../evil.sh', content: Buffer.from('rm -rf', 'utf8'), method: 0 }
      ])
    )

    expect(files.map((file) => file.path)).toEqual(['skill/SKILL.md'])
  })

  it('rejects any entry whose name contains a backslash', () => {
    // ZIP names must use forward slashes; a backslash is never legitimate and is a Windows zip-slip
    // vector, so every backslash entry is dropped — even one that looks like a normal nested file
    // (`a\b` and `a/b` must never collapse onto the same write target).
    const files = extractZip(
      buildZip([
        { path: '..\\..\\evil.sh', content: Buffer.from('rm -rf', 'utf8'), method: 0 },
        { path: 'C:\\Windows\\system32\\x', content: Buffer.from('x', 'utf8'), method: 0 },
        { path: 'skill\\references\\helper.py', content: Buffer.from('ok', 'utf8'), method: 0 },
        // A genuine forward-slash file alongside them still extracts.
        { path: 'skill/SKILL.md', content: Buffer.from('ok', 'utf8'), method: 0 }
      ])
    )

    expect(files.map((file) => file.path)).toEqual(['skill/SKILL.md'])
  })

  it('throws when the buffer is not a zip', () => {
    expect(() => extractZip(Buffer.from('not a zip at all', 'utf8'))).toThrow()
  })

  it('rejects a bundle with more files than the count limit', () => {
    // 300 tiny STORE entries exceed SKILL_IMPORT_LIMITS.maxFiles (256).
    const inputs: ZipInput[] = Array.from({ length: 300 }, (_, i) => ({
      path: `f${i}.txt`,
      content: Buffer.from('x', 'utf8'),
      method: 0 as const
    }))
    expect(() => extractZip(buildZip(inputs))).toThrow(/too many files/)
  })

  it('rejects an oversized STORE entry from its known size', () => {
    // A single STORE file over the per-file cap is rejected without copying it out.
    const big = Buffer.alloc(SKILL_IMPORT_LIMITS.maxFileBytes + 1, 0x61)
    expect(() => extractZip(buildZip([{ path: 'big.txt', content: big, method: 0 }]))).toThrow(
      /exceeds the .* limit/
    )
  })

  it('rejects a DEFLATE bomb via the inflate output bound', () => {
    // Zeros compress to almost nothing but would inflate past the per-file cap; inflateRawSync's
    // maxOutputLength makes that throw instead of expanding into memory.
    const bomb = Buffer.alloc(SKILL_IMPORT_LIMITS.maxFileBytes + 1024, 0)
    expect(() => extractZip(buildZip([{ path: 'bomb.bin', content: bomb, method: 8 }]))).toThrow()
  })

  it('rejects a bundle whose decompressed total exceeds the cap', () => {
    // Files each at the per-file cap, enough of them to overflow the per-skill total cap.
    const chunk = Buffer.alloc(SKILL_IMPORT_LIMITS.maxFileBytes, 0x62)
    const count =
      Math.floor(SKILL_IMPORT_LIMITS.maxTotalBytes / SKILL_IMPORT_LIMITS.maxFileBytes) + 1
    const inputs: ZipInput[] = Array.from({ length: count }, (_, i) => ({
      path: `f${i}.txt`,
      content: chunk,
      method: 0 as const
    }))
    expect(() => extractZip(buildZip(inputs))).toThrow(/decompressed limit/)
  })

  it('counts directory levels for depth, not the filename (off-by-one boundary)', () => {
    // Depth is the number of directories. A file under exactly 8 directories is at the limit and is
    // accepted; a 9th directory level exceeds SKILL_IMPORT_LIMITS.maxDepth (8) and is rejected.
    const atLimit = `${Array.from({ length: 8 }, (_, i) => `d${i}`).join('/')}/x.txt`
    const files = extractZip(buildZip([{ path: atLimit, content: Buffer.from('x'), method: 0 }]))
    expect(files.map((f) => f.path)).toEqual([atLimit])

    const tooDeep = `${Array.from({ length: 9 }, (_, i) => `d${i}`).join('/')}/x.txt`
    expect(() =>
      extractZip(buildZip([{ path: tooDeep, content: Buffer.from('x'), method: 0 }]))
    ).toThrow(/nested deeper/)
  })
})

describe('extractZipLenient', () => {
  const limits = { maxFiles: 100, maxFileBytes: 1024, maxTotalBytes: 4096, maxDepth: 8 }

  it('keeps valid entries and skips an oversized one with a reason (never throws)', () => {
    const zip = buildZip([
      { path: 'ok.txt', content: Buffer.from('small'), method: 0 },
      { path: 'huge.bin', content: Buffer.alloc(limits.maxFileBytes + 1, 1), method: 0 }
    ])
    const { files, skipped } = extractZipLenient(zip, limits)
    expect(files.map((f) => f.path)).toEqual(['ok.txt'])
    expect(skipped).toEqual([{ path: 'huge.bin', reason: expect.stringMatching(/too large/) }])
  })

  it('skips entries past the file-count cap instead of failing the whole archive', () => {
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      path: `f${i}.txt`,
      content: Buffer.from('x'),
      method: 0 as const
    }))
    const { files, skipped } = extractZipLenient(buildZip(inputs), { ...limits, maxFiles: 3 })
    expect(files).toHaveLength(3)
    expect(skipped).toHaveLength(2)
    expect(skipped[0].reason).toMatch(/too many entries/)
  })

  it('skips an entry that would push the archive past the total-size cap', () => {
    const zip = buildZip([
      { path: 'a.bin', content: Buffer.alloc(900, 1), method: 0 },
      { path: 'b.bin', content: Buffer.alloc(900, 1), method: 0 }
    ])
    const { files, skipped } = extractZipLenient(zip, { ...limits, maxTotalBytes: 1000 })
    expect(files.map((f) => f.path)).toEqual(['a.bin'])
    expect(skipped[0].reason).toMatch(/exceeds/)
  })

  it('records unsafe paths as skipped so their owning root can be rejected', () => {
    const zip = buildZip([
      { path: 'tool/SKILL.md', content: Buffer.from('ok'), method: 0 },
      { path: 'tool/../evil.txt', content: Buffer.from('nope'), method: 0 }
    ])

    const { files, skipped } = extractZipLenient(zip, limits)
    expect(files.map((f) => f.path)).toEqual(['tool/SKILL.md'])
    expect(skipped).toEqual([{ path: 'tool/../evil.txt', reason: 'unsafe path' }])
  })

  it('still throws on a structurally invalid archive', () => {
    expect(() => extractZipLenient(Buffer.from('not a zip'), limits)).toThrow(/valid ZIP/)
  })

  it('records an out-of-range local-header offset as skipped, never throwing', () => {
    const zip = buildZip([
      { path: 'good.txt', content: Buffer.from('ok'), method: 0 },
      { path: 'bad.txt', content: Buffer.from('nope'), method: 0 }
    ])
    // Point bad.txt's central record at an out-of-range local-header offset. Central records follow
    // entry order, so bad.txt's is the second (after good.txt's 46 + name-length bytes).
    const centralStart = zip.readUInt32LE(zip.length - 22 + 16)
    const badCentral = centralStart + 46 + 'good.txt'.length
    zip.writeUInt32LE(0x7fffffff, badCentral + 42)

    const { files, skipped } = extractZipLenient(zip, limits)
    expect(files.map((f) => f.path)).toEqual(['good.txt'])
    expect(skipped).toEqual([{ path: 'bad.txt', reason: expect.stringMatching(/local header/) }])
  })

  it('records a corrupt local signature as skipped, keeping the other entries', () => {
    const zip = buildZip([
      { path: 'bad.txt', content: Buffer.from('nope'), method: 0 },
      { path: 'good.txt', content: Buffer.from('ok'), method: 0 }
    ])
    // bad.txt is the first entry, so its local header sits at offset 0; wipe its signature.
    zip.writeUInt32LE(0, 0)

    const { files, skipped } = extractZipLenient(zip, limits)
    expect(files.map((f) => f.path)).toEqual(['good.txt'])
    expect(skipped).toEqual([{ path: 'bad.txt', reason: 'malformed local header' }])
  })
})
