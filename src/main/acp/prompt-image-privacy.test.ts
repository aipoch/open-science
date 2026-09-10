import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})
it.each(['reference', 'current', 'history'] as const)(
  'omits private EXIF from outgoing %s images and preserves the source',
  async (kind) => {
    const { AcpPromptContentOwner } = await import('./prompt-content-owner')
    const { FileReferenceResolver } = await import('./file-reference-resolver')
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } })
      .jpeg()
      .withExif({ IFD0: { Artist: 'AUDIT_PERSON_CANARY' } })
      .toBuffer()
    root = await mkdtemp(join(tmpdir(), 'privacy-prompt-'))
    const path = join(root, 'private.jpg')
    await writeFile(path, bytes)
    const trustedLease = {
      size: bytes.length,
      read: vi.fn(async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        const chunk = bytes.subarray(position, position + length)
        buffer.set(chunk, offset)
        return { bytesRead: chunk.length }
      }),
      readRange: vi.fn(async (begin: number, end: number) => bytes.subarray(begin, end)),
      copyTo: vi.fn(async (destination: string) => writeFile(destination, bytes, { flag: 'wx' })),
      verifyUnchanged: vi.fn(async () => {}),
      close: vi.fn(async () => {})
    }
    const owner = new AcpPromptContentOwner({
      fileReferenceResolver: new FileReferenceResolver([
        {
          source: 'artifact',
          resolve: async () =>
            ({
              absolutePath: path,
              name: 'private.jpg',
              mimeType: 'image/jpeg',
              allowSkillImportReference: false,
              trustedLease
            }) as never
        }
      ])
    })
    const prepared = await owner.prepare({
      appSessionId: 'audit-session',
      projectId: 'audit-project',
      text: 'Describe this image',
      historyImages:
        kind === 'history'
          ? [{ mimeType: 'image/jpeg', data: bytes.toString('base64'), byteLength: bytes.length }]
          : [],
      currentImages:
        kind === 'current'
          ? [{ mimeType: 'image/jpeg', data: bytes.toString('base64'), byteLength: bytes.length }]
          : [],
      historyUploads: [],
      currentUploads: [],
      references:
        kind === 'reference'
          ? [
              {
                id: 'audit-file',
                name: 'private.jpg',
                path: 'artifact-version:audit',
                source: 'artifact',
                mimeType: 'image/jpeg'
              }
            ]
          : [],
      codexSkillInputs: [],
      skillImportEnabled: false
    })
    try {
      const block = (typeof prepared.content === 'string' ? [] : prepared.content).find(
        (x) => x.type === 'image'
      )
      expect(block).toBeTruthy()
      expect(
        (await sharp(Buffer.from(block!.data, 'base64')).metadata()).exif?.includes(
          Buffer.from('AUDIT_PERSON_CANARY')
        ) ?? false
      ).toBe(false)
    } finally {
      prepared.close()
      expect(await readFile(path)).toEqual(bytes)
    }
  }
)
