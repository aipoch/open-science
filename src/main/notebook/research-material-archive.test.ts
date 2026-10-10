import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { zipSync } from 'fflate'
import { Header } from 'tar'
import { describe, expect, it } from 'vitest'
import { inspectResearchMaterialArchive } from './research-material-archive'

const limits = { maxExpandedBytes: 4096, maxEntries: 20 }
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const tar = (
  files: Array<{
    path: string
    content?: Buffer
    type?: 'File' | 'Directory' | 'SymbolicLink' | 'Link' | 'FIFO'
  }>
): Buffer =>
  Buffer.concat([
    ...files.flatMap(({ path, content = Buffer.alloc(0), type = 'File' }) => {
      const header = Buffer.alloc(512)
      new Header({
        path,
        type,
        size: content.length,
        mode: 0o644,
        linkpath: type === 'Link' || type === 'SymbolicLink' ? 'target' : undefined
      }).encode(header)
      return [header, content, Buffer.alloc((512 - (content.length % 512)) % 512)]
    }),
    Buffer.alloc(1024)
  ])

describe('bounded research archive inspection', () => {
  it.each(['tar', 'tar.gz', 'zip'] as const)(
    'enumerates real %s bytes with exact content identities',
    async (format) => {
      const content = Buffer.from('export const answer = 42\n')
      const raw = tar([
        { path: 'project/', type: 'Directory' },
        { path: 'project/index.js', content }
      ])
      const bytes =
        format === 'tar.gz'
          ? gzipSync(raw)
          : format === 'zip'
            ? Buffer.from(zipSync({ 'project/': Buffer.alloc(0), 'project/index.js': content }))
            : raw
      const entries = await inspectResearchMaterialArchive(bytes, format, limits)
      expect(entries).toEqual([
        { path: 'project', type: 'directory' },
        {
          path: 'project/index.js',
          type: 'file',
          sizeBytes: content.length,
          sha256: sha(content),
          content
        }
      ])
    }
  )

  it.each([
    '../escape',
    '/absolute',
    'a/../escape',
    'a\\escape',
    'C:/escape',
    'a//b',
    'CON',
    'name.'
  ])('refuses nonportable path %s', async (path) => {
    await expect(inspectResearchMaterialArchive(tar([{ path }]), 'tar', limits)).rejects.toThrow()
  })

  it.each([
    ['same', 'same'],
    ['Foo', 'foo'],
    ['parent', 'parent/child'],
    ['a/one', 'A/two'],
    ['é', 'e\u0301']
  ])('refuses duplicate, Unicode or ancestor conflicts: %s / %s', async (first, second) => {
    await expect(
      inspectResearchMaterialArchive(tar([{ path: first }, { path: second }]), 'tar', limits)
    ).rejects.toThrow()
  })

  it.each(['SymbolicLink', 'Link', 'FIFO'] as const)('refuses tar %s entries', async (type) => {
    await expect(
      inspectResearchMaterialArchive(tar([{ path: 'a', type }]), 'tar', limits)
    ).rejects.toThrow(/links|special/)
  })

  it('checks actual tar headers, content boundaries and trailing records', async () => {
    const bytes = tar([{ path: 'file', content: Buffer.from('abc') }])
    const checksum = Buffer.from(bytes)
    checksum[0] ^= 1
    await expect(inspectResearchMaterialArchive(checksum, 'tar', limits)).rejects.toThrow(
      /checksum/
    )
    await expect(
      inspectResearchMaterialArchive(bytes.subarray(0, bytes.length - 512), 'tar', limits)
    ).rejects.toThrow(/terminator/)
    await expect(
      inspectResearchMaterialArchive(
        Buffer.concat([bytes, tar([{ path: 'hidden' }])]),
        'tar',
        limits
      )
    ).rejects.toThrow(/trailing/)
    const padding = Buffer.from(bytes)
    padding[515] = 1
    await expect(inspectResearchMaterialArchive(padding, 'tar', limits)).rejects.toThrow(/padding/)
  })

  it('bounds expansion and entry counts for all supported transports', async () => {
    const body = Buffer.alloc(5000)
    await expect(
      inspectResearchMaterialArchive(tar([{ path: 'large', content: body }]), 'tar', limits)
    ).rejects.toThrow(/limit/)
    await expect(
      inspectResearchMaterialArchive(
        gzipSync(tar([{ path: 'large', content: Buffer.alloc(50000) }])),
        'tar.gz',
        limits
      )
    ).rejects.toThrow()
    await expect(
      inspectResearchMaterialArchive(Buffer.from(zipSync({ large: body })), 'zip', limits)
    ).rejects.toThrow(/limit/)
    await expect(
      inspectResearchMaterialArchive(tar([{ path: 'one' }, { path: 'two' }]), 'tar', {
        ...limits,
        maxEntries: 1
      })
    ).rejects.toThrow(/entry limit/)
  })

  it('checks local/central ZIP agreement, output CRC and unsafe Unix file types', async () => {
    const bytes = Buffer.from(zipSync({ file: Buffer.from('content') }, { level: 0 }))
    const localMismatch = Buffer.from(bytes)
    localMismatch.writeUInt32LE(5000, 22)
    await expect(inspectResearchMaterialArchive(localMismatch, 'zip', limits)).rejects.toThrow(
      /does not match/
    )
    const badContent = Buffer.from(bytes)
    badContent[34] ^= 1
    await expect(inspectResearchMaterialArchive(badContent, 'zip', limits)).rejects.toThrow(
      /checksum/
    )
    const central = bytes.readUInt32LE(bytes.length - 6)
    for (const type of [0o120000, 0o010000, 0o060000]) {
      const special = Buffer.from(bytes)
      special.writeUInt32LE((type * 65536) >>> 0, central + 38)
      await expect(inspectResearchMaterialArchive(special, 'zip', limits)).rejects.toThrow(
        /special/
      )
    }
    const hidden = Buffer.concat([Buffer.from('hidden'), bytes])
    await expect(inspectResearchMaterialArchive(hidden, 'zip', limits)).rejects.toThrow()
  })

  it('rejects misleading declared ZIP expansion before materialization', async () => {
    const bytes = Buffer.from(zipSync({ file: Buffer.alloc(4000) }))
    const central = bytes.readUInt32LE(bytes.length - 6)
    bytes.writeUInt32LE(1, 22)
    bytes.writeUInt32LE(1, central + 24)
    await expect(inspectResearchMaterialArchive(bytes, 'zip', limits)).rejects.toThrow()
  })

  it('honors cancellation without inspecting an archive', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(
      inspectResearchMaterialArchive(Buffer.alloc(0), 'tar', limits, abort.signal)
    ).rejects.toThrow()
  })
})
