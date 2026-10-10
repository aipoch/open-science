import { describe, expect, it, vi } from 'vitest'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import { MAX_MANAGED_INLINE_BINARY_BYTES } from './managed-execution-output'
import { saveAuxiliaryOutput, type AuxiliaryOutput } from './managed-auxiliary-output'

const artifact = { versionId: 'version-a' } as ArtifactVersionFile
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cVZ0AAAAASUVORK5CYII='

describe('Main-only optional inline evidence', () => {
  it('passes canonical binary bytes and UTF-8 through the same tracked writer contract', async () => {
    const save = vi.fn(async () => artifact)
    const beforeWrite = vi.fn()
    const binary: AuxiliaryOutput = {
      filename: 'frame.png',
      contentType: 'image/png',
      source: { kind: 'inline', content: png, encoding: 'base64' },
      publication: { beforeWrite }
    }
    expect(await saveAuxiliaryOutput(binary, save)).toEqual({ status: 'saved', artifact })
    expect(save).toHaveBeenLastCalledWith(binary)
    const text: AuxiliaryOutput = {
      filename: 'notes.txt',
      source: { kind: 'inline', content: '研究\nΩ😀' }
    }
    expect(await saveAuxiliaryOutput(text, save)).toEqual({ status: 'saved', artifact })
    expect(save).toHaveBeenLastCalledWith(text)
  })

  it.each([
    'Zg',
    'Zg=',
    'Zg===',
    'Zg==\n',
    ' Zg==',
    'Zm 8=',
    'Zg==extra',
    'AA=A',
    '====',
    '!!!!',
    '-_8=',
    'Zh==',
    'Zm9='
  ])('rejects malformed or noncanonical base64 %j before invoking the writer', async (content) => {
    const save = vi.fn(async () => artifact)
    expect(
      await saveAuxiliaryOutput(
        { filename: 'frame.png', source: { kind: 'inline', content, encoding: 'base64' } },
        save
      )
    ).toEqual({ status: 'failed', code: 'invalid-output' })
    expect(save).not.toHaveBeenCalled()
  })

  it('bounds decoded bytes, including overflow with the same encoded character count', async () => {
    const save = vi.fn(async () => artifact)
    const completeTriples = 'AAAA'.repeat(Math.floor(MAX_MANAGED_INLINE_BINARY_BYTES / 3))
    const exact = `${completeTriples}AA==`
    const over = `${completeTriples}AAA=`
    expect(exact.length).toBe(over.length)
    expect(Buffer.byteLength(exact, 'base64')).toBe(MAX_MANAGED_INLINE_BINARY_BYTES)
    expect(
      await saveAuxiliaryOutput(
        { filename: 'limit.bin', source: { kind: 'inline', content: exact, encoding: 'base64' } },
        save
      )
    ).toEqual({ status: 'saved', artifact })
    expect(
      await saveAuxiliaryOutput(
        { filename: 'overflow.bin', source: { kind: 'inline', content: over, encoding: 'base64' } },
        save
      )
    ).toEqual({ status: 'failed', code: 'invalid-output' })
    expect(save).toHaveBeenCalledOnce()
  })

  it('bounds default UTF-8 by bytes rather than UTF-16 character count', async () => {
    const save = vi.fn(async () => artifact)
    const content = '字'.repeat(Math.ceil(MAX_MANAGED_INLINE_BINARY_BYTES / 3))
    expect(content.length).toBeLessThan(MAX_MANAGED_INLINE_BINARY_BYTES)
    expect(
      await saveAuxiliaryOutput(
        { filename: 'oversize.txt', source: { kind: 'inline', content } },
        save
      )
    ).toEqual({ status: 'failed', code: 'invalid-output' })
    expect(save).not.toHaveBeenCalled()
  })

  it.each([
    { filename: '../frame.png', source: { kind: 'inline', content: png, encoding: 'base64' } },
    { filename: 'frame.png', source: { kind: 'localPath', path: '/private/frame.png' } },
    {
      filename: 'frame.png',
      source: { kind: 'inline', content: png, encoding: 'base64' },
      producerRunId: 'forged-run'
    },
    {
      filename: 'frame.png',
      source: { kind: 'inline', content: png, encoding: 'base64' },
      failurePolicy: 'ignore'
    },
    {
      filename: 'frame.png',
      source: { kind: 'inline', content: png, encoding: 'base64', path: '/private/frame.png' }
    },
    { filename: 'frame.png', source: { kind: 'inline', content: png, encoding: 'hex' } }
  ])('does not expand the auxiliary authority for %j', async (input) => {
    const save = vi.fn(async () => artifact)
    expect(await saveAuxiliaryOutput(input as AuxiliaryOutput, save)).toEqual({
      status: 'failed',
      code: 'invalid-output'
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('returns an explicit optional failure instead of rejecting the tracked turn write', async () => {
    const save = vi.fn(async () => {
      throw new Error('actual writer rejected')
    })
    expect(
      await saveAuxiliaryOutput(
        { filename: 'frame.png', source: { kind: 'inline', content: png, encoding: 'base64' } },
        save
      )
    ).toEqual({ status: 'failed', code: 'artifact-save-failed' })
  })
})
