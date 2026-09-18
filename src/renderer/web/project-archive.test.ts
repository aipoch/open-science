import { describe, expect, it, vi } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { saveWebProjectArchive } from './project-archive'

const file = {
  source: 'artifact' as const,
  hidden: true,
  sessionId: 'session',
  fileId: 'secret',
  versionId: 'v1',
  suggestedName: '../secret.txt'
}
const request = { projectId: 'project', suggestedArchiveName: 'project', files: [file] }

describe('browser project archives', () => {
  it('downloads every Hidden chunk into its own safe category without ordinary acquisition', async () => {
    const invoke = vi.fn(async (channel: string, args: unknown[]) => {
      expect(channel).toBe('project-files:read-hidden-artifact')
      const offset = (args[0] as { offset: number }).offset
      return {
        content: btoa(offset === 0 ? 'first' : 'second'),
        size: 11,
        encoding: 'base64',
        truncated: offset === 0
      }
    })
    const download = vi.fn<(blob: Blob, name: string) => void>()
    expect(await saveWebProjectArchive(request, invoke, download, 100)).toEqual({ saved: true })
    expect(invoke).toHaveBeenCalledTimes(3)
    const archive = unzipSync(new Uint8Array(await download.mock.calls[0]![0].arrayBuffer()))
    expect(Object.keys(archive)).toEqual(['hidden/secret.txt'])
    expect(strFromU8(archive['hidden/secret.txt']!)).toBe('firstsecond')
  })

  it('does not publish a truncated or revoked Hidden download', async () => {
    const download = vi.fn()
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ content: btoa('first'), size: 11 })
      .mockRejectedValueOnce(new Error('hidden access revoked'))
    expect(await saveWebProjectArchive(request, invoke, download, 100)).toMatchObject({
      saved: true,
      failures: [{ fileId: 'secret', message: 'hidden access revoked' }]
    })
    expect(download).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'cancels publication if an earlier member is revoked while reading another (hidden=%s)',
    async (hidden) => {
      let revoked = false
      const invoke = vi.fn(async (channel: string, args: unknown[]) => {
        const value = args[0] as { fileId?: string; resourceId?: string; offset?: number }
        const id = value.fileId ?? value.resourceId
        if (channel === 'preview-resources:release') return undefined
        if (id === 'a' && revoked) throw new Error('file visibility changed')
        if (channel === 'preview-resources:acquire') return { id, size: 1 }
        if (id === 'b') revoked = true
        if (hidden) return { content: btoa(id!), size: 1 }
        return { begin: 0, end: 1, total: 1, data: Uint8Array.of(id!.charCodeAt(0)) }
      })
      const download = vi.fn()
      await expect(
        saveWebProjectArchive(
          {
            ...request,
            files: ['a', 'b'].map((fileId) => ({
              ...file,
              hidden,
              fileId,
              suggestedName: fileId + '.txt'
            }))
          },
          invoke,
          download,
          100
        )
      ).rejects.toThrow('file visibility changed')
      expect(download).not.toHaveBeenCalled()
    }
  )

  it('keeps ordinary downloads on their ordinary lease and releases it after failure', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ id: 'lease', size: 10 })
      .mockRejectedValueOnce(new Error('file hidden'))
      .mockResolvedValueOnce(undefined)
    const download = vi.fn()
    await saveWebProjectArchive(
      { ...request, files: [{ ...file, hidden: undefined }] },
      invoke,
      download,
      100
    )
    expect(invoke).toHaveBeenLastCalledWith('preview-resources:release', [{ resourceId: 'lease' }])
    expect(download).not.toHaveBeenCalled()
  })
})
