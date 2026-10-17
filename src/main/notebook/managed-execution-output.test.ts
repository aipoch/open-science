import { createHash } from 'node:crypto'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import {
  createManagedExecutionOutputWriter,
  isCanonicalManagedInlineBase64,
  type ManagedExecutionOutput,
  type ManagedExecutionOutputScope
} from './managed-execution-output'

const scope: ManagedExecutionOutputScope = {
  projectId: 'project-a',
  sessionId: 'session-a',
  operationId: 'operation-a',
  workspaceCwd: '',
  artifactRunId: 'artifact-turn-a',
  artifactStorageSessionId: 'session-a',
  writeNamespace: 'observation',
  provenanceContext: {
    rootFrameId: 'root-a',
    agentFrameId: 'agent-a',
    messageBranchId: 'branch-a',
    runtimeSegmentId: 'segment-a',
    promptMessageId: 'prompt-a'
  },
  messageAncestry: ['prompt-a']
}
function setup(): {
  writer: ReturnType<typeof createManagedExecutionOutputWriter>
  saveVersion: Mock<() => Promise<ArtifactVersionFile>>
} {
  const saveVersion = vi.fn(async () => ({ versionId: 'version-a' }) as ArtifactVersionFile)
  const writer = createManagedExecutionOutputWriter(
    {
      dataRoot: '/managed-app-data',
      artifacts: { saveVersion, replayVersion: vi.fn() },
      notebooks: { readSessionDocuments: vi.fn(async () => []) }
    },
    scope,
    new AbortController().signal
  )
  return { writer, saveVersion }
}

describe('managed inline output byte encoding', () => {
  it('passes binary data unchanged and freezes publication proof from decoded bytes', async () => {
    const { writer, saveVersion } = setup()
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 10])
    const content = bytes.toString('base64')
    const beforeWrite = vi.fn()
    await writer.saveOutput({
      filename: 'frame.png',
      contentType: 'image/png',
      source: { kind: 'inline', content, encoding: 'base64' },
      publication: { beforeWrite }
    })
    expect(beforeWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          kind: 'inline',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength
        }
      })
    )
    expect(saveVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'frame.png',
        source: { kind: 'inline', content, encoding: 'base64' },
        producerRunId: undefined
      }),
      expect.objectContaining({
        expectedContent: {
          checksum: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength
        }
      }),
      expect.any(AbortSignal)
    )
    expect(beforeWrite.mock.invocationCallOrder[0]).toBeLessThan(
      saveVersion.mock.invocationCallOrder[0]
    )
  })

  it('preserves default UTF-8, including non-ASCII text and base64-looking text', async () => {
    const { writer, saveVersion } = setup()
    for (const content of ['研究 Ω😀\n', 'Zg==', '']) {
      const beforeWrite = vi.fn()
      await writer.saveOutput({
        filename: 'text.txt',
        source: { kind: 'inline', content },
        publication: { beforeWrite }
      })
      expect(saveVersion).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source: {
            kind: 'inline',
            content: Buffer.from(content, 'utf8').toString('base64'),
            encoding: 'base64'
          }
        }),
        expect.anything(),
        expect.anything()
      )
      expect(beforeWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          source: {
            kind: 'inline',
            sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
            sizeBytes: Buffer.byteLength(content, 'utf8')
          }
        })
      )
    }
  })

  it.each(['Zg', 'Zh==', 'Zm9=', 'Zg==\n', 'AA=A', '===='])(
    'rejects direct malformed base64 %j before a write intent or Artifact save',
    async (content) => {
      const { writer, saveVersion } = setup()
      const beforeWrite = vi.fn()
      await expect(
        writer.saveOutput({
          filename: 'bad.png',
          source: { kind: 'inline', content, encoding: 'base64' },
          publication: { beforeWrite }
        })
      ).rejects.toThrow('canonical base64')
      expect(beforeWrite).not.toHaveBeenCalled()
      expect(saveVersion).not.toHaveBeenCalled()
    }
  )

  it('rejects unsupported runtime encoding instead of silently treating it as UTF-8', async () => {
    const { writer, saveVersion } = setup()
    await expect(
      writer.saveOutput({
        filename: 'bad.png',
        source: { kind: 'inline', content: 'ffff', encoding: 'hex' }
      } as unknown as ManagedExecutionOutput)
    ).rejects.toThrow('Unsupported inline')
    expect(saveVersion).not.toHaveBeenCalled()
  })

  it.each(['', 'Zg==', 'Zm8=', 'Zm9v', 'AA==', '/w==', '//8=', '////'])(
    'accepts standard canonical base64 %j',
    (content) => {
      expect(isCanonicalManagedInlineBase64(content)).toBe(true)
      expect(Buffer.from(content, 'base64').toString('base64')).toBe(content)
    }
  )
})
