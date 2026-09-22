import { access, readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { UploadedAttachment } from '../../shared/uploads'
import { saveRecoveryText } from './recovery-text-storage'

const fixture = (): {
  uploads: Pick<
    import('../uploads/repository').UploadRepository,
    'stageLocalFile' | 'finalizePendingSessionUploads' | 'deleteUpload'
  > & {
    stageLocalFile: ReturnType<typeof vi.fn>
    finalizePendingSessionUploads: ReturnType<typeof vi.fn>
    deleteUpload: ReturnType<typeof vi.fn>
  }
  staged: UploadedAttachment
  finalized: UploadedAttachment
  source: () => string
  text: () => string
} => {
  const staged: UploadedAttachment = {
    id: 'upload',
    sessionId: 'pending',
    name: 'text.txt',
    originalName: 'text.txt',
    path: '/managed/pending/text.txt',
    size: 10
  }
  const finalized = {
    ...staged,
    sessionId: 'session',
    versionId: 'v1',
    path: 'upload-version://v1'
  }
  let source = ''
  let savedText = ''
  const uploads = {
    stageLocalFile: vi.fn(async (request) => {
      source = request.sourcePath
      savedText = await readFile(source, 'utf8')
      return staged
    }),
    finalizePendingSessionUploads: vi.fn(async () => [finalized]),
    deleteUpload: vi.fn(async () => {})
  }
  return { uploads, staged, finalized, source: () => source, text: () => savedText }
}

describe('saveRecoveryText', () => {
  it('publishes full text before binding its immutable Version to the source message', async () => {
    const f = fixture()
    const attach = vi.fn(async () => {})
    const text = '完整用户要求\n'.repeat(10000)
    const result = await saveRecoveryText({
      projectId: 'project',
      sessionId: 'session',
      messageId: 'message',
      text,
      uploads: f.uploads,
      attach
    })
    expect(f.text()).toBe(text)
    expect(result).toEqual(f.finalized)
    expect(attach.mock.calls).toEqual([['message', f.finalized]])
    expect(attach.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.uploads.finalizePendingSessionUploads.mock.invocationCallOrder[0]
    )
    await expect(access(f.source())).rejects.toThrow()
  })
  it('retains published Session-owned bytes but returns no reference when the message bind fails', async () => {
    const f = fixture()
    await expect(
      saveRecoveryText({
        projectId: 'project',
        sessionId: 'session',
        messageId: 'message',
        text: 'full',
        uploads: f.uploads,
        attach: async () => {
          throw new Error('save failed')
        }
      })
    ).rejects.toThrow('save failed')
    expect(f.uploads.finalizePendingSessionUploads).toHaveBeenCalledOnce()
    expect(f.uploads.deleteUpload).not.toHaveBeenCalled()
    await expect(access(f.source())).rejects.toThrow()
  })
  it('leaves pending bytes with the upload recovery owner when publication fails', async () => {
    const f = fixture()
    f.uploads.finalizePendingSessionUploads.mockRejectedValueOnce(new Error('disk failed'))
    const attach = vi.fn(async () => {})
    await expect(
      saveRecoveryText({
        projectId: 'project',
        sessionId: 'session',
        messageId: 'message',
        text: 'full',
        uploads: f.uploads,
        attach
      })
    ).rejects.toThrow('disk failed')
    expect(attach).not.toHaveBeenCalled()
    expect(f.uploads.deleteUpload).not.toHaveBeenCalled()
    await expect(access(f.source())).rejects.toThrow()
  })
})
