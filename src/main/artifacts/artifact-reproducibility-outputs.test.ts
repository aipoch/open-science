import { link, mkdtemp, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256 } from './provenance-canonical'
import {
  MAX_REPRODUCIBILITY_OUTPUT_BYTES,
  outputPreview,
  pruneReproducibilityOutputs,
  readReproducibilityOutputFile,
  readRetainedReproducibilityOutput,
  retainReproducibilityOutput,
  validateReproducibilityOutputs
} from './artifact-reproducibility-outputs'

const roots: string[] = []
const directory = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'reproduced-outputs-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('retained reproduction outputs', () => {
  it('deduplicates concurrent content writes and verifies size and identity on reads', async () => {
    const root = await directory()
    const bytes = Buffer.from('group,n\nCtrl,33\n')
    expect(
      await Promise.all(Array.from({ length: 8 }, () => retainReproducibilityOutput(root, bytes)))
    ).toEqual(Array(8).fill(true))
    expect(await readdir(join(root, 'outputs'))).toEqual([`sha256-${sha256(bytes)}.bin`])
    await expect(
      readRetainedReproducibilityOutput(root, sha256(bytes), bytes.length)
    ).resolves.toEqual(bytes)
    await expect(readRetainedReproducibilityOutput(root, sha256(bytes), 0)).rejects.toThrow(
      'checksum mismatch'
    )
    await expect(
      readRetainedReproducibilityOutput(root, '../escape', bytes.length)
    ).rejects.toThrow('Invalid')
    await writeFile(join(root, 'outputs', `sha256-${sha256(bytes)}.bin`), 'modified')
    await expect(
      readRetainedReproducibilityOutput(root, sha256(bytes), bytes.length)
    ).rejects.toThrow('checksum mismatch')
    await expect(validateReproducibilityOutputs(root)).rejects.toThrow('checksum mismatch')
  })

  it('rejects linked files and linked output directories', async () => {
    const root = await directory()
    const file = join(root, 'original.txt')
    await writeFile(file, 'original')
    await symlink(file, join(root, 'symlink.txt'))
    await expect(readReproducibilityOutputFile(join(root, 'symlink.txt'))).rejects.toThrow()
    await link(file, join(root, 'hardlink.txt'))
    await expect(readReproducibilityOutputFile(join(root, 'hardlink.txt'))).rejects.toThrow()
    await symlink(await directory(), join(root, 'outputs'))
    await expect(retainReproducibilityOutput(root, Buffer.from('changed'))).rejects.toThrow(
      'Invalid'
    )
  })

  it('bounds reads and stored bytes without losing already retained output', async () => {
    const root = await directory()
    const oversized = join(root, 'large.dat')
    await writeFile(oversized, '')
    await truncate(oversized, MAX_REPRODUCIBILITY_OUTPUT_BYTES + 1)
    await expect(readReproducibilityOutputFile(oversized)).rejects.toThrow('cannot be retained')
    // Sparse existing entries exercise the aggregate quota without allocating 256 MB.
    await retainReproducibilityOutput(root, Buffer.from('keep'))
    for (let index = 0; index < 8; index++) {
      const file = join(root, 'outputs', `sha256-${index.toString(16).padStart(64, '0')}.bin`)
      await writeFile(file, '')
      await truncate(file, MAX_REPRODUCIBILITY_OUTPUT_BYTES)
    }
    await expect(retainReproducibilityOutput(root, Buffer.from('new'))).resolves.toBe(false)
    await expect(retainReproducibilityOutput(root, Buffer.from('keep'))).resolves.toBe(true)
  })

  it('prunes cancelled or interrupted output while keeping content referenced by history', async () => {
    const root = await directory()
    await retainReproducibilityOutput(root, Buffer.from('saved'))
    await retainReproducibilityOutput(root, Buffer.from('cancelled'))
    await pruneReproducibilityOutputs(root, new Set([sha256('saved')]))
    expect(await readdir(join(root, 'outputs'))).toEqual([`sha256-${sha256('saved')}.bin`])
    await expect(validateReproducibilityOutputs(root)).resolves.toBeUndefined()
  })

  it('only embeds raster bytes, escapes active formats through text, and bounds text previews', () => {
    expect(outputPreview('plot.png', Buffer.from('<svg onload="evil()"/>'))).toEqual({
      kind: 'unsupported'
    })
    expect(outputPreview('plot.svg', Buffer.from('<svg/>'))).toEqual({ kind: 'unsupported' })
    expect(outputPreview('plot.png', Buffer.from('89504e470d0a1a0a', 'hex'))).toMatchObject({
      kind: 'image',
      dataUrl: expect.stringContaining('data:image/png;base64,')
    })
    const preview = outputPreview('table.csv', Buffer.alloc(65537, 65))
    expect(preview).toEqual({ kind: 'text', text: 'A'.repeat(65536), truncated: true })
  })
})
