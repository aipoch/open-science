import { beforeEach, expect, it, vi } from 'vitest'
import type { ArtifactFile } from '../../shared/artifacts'
import { createArtifactHandlers } from '../artifacts/ipc'
import { composeArtifactSurfaces } from './artifact-surfaces'

vi.mock('electron', () => ({ webContents: { fromId: vi.fn() } }))
vi.mock('../artifacts/ipc', () => ({ createArtifactHandlers: vi.fn(() => ({})) }))
vi.mock('../ipc-surfaces/artifacts', () => ({ createArtifactElectronSurface: vi.fn(() => ({})) }))
vi.mock('../ipc-surfaces/session-persistence', () => ({
  createSessionPersistenceElectronSurface: vi.fn(() => ({}))
}))
vi.mock('../ipc-surfaces/uploads', () => ({ createUploadElectronSurface: vi.fn(() => ({})) }))
vi.mock('../session-deletion/owner', () => ({ SessionDeletionOwner: class {} }))
vi.mock('../session-persistence/runtime-writer', () => ({ RuntimeWriterOwner: class {} }))
vi.mock('../ipc-handler-registry', () => ({ ipcMainHandle: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

const setup = (
  onArtifactsPublished: (artifacts: readonly ArtifactFile[]) => Promise<void>
): {
  onPublished: (artifacts: readonly ArtifactFile[]) => void
  importNative: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} => {
  const importNative = vi.fn().mockResolvedValue(undefined)
  const warn = vi.fn()
  composeArtifactSurfaces({
    surfaceAdapters: [],
    declareElectronAdapter: vi.fn(),
    storageLog: { warn },
    artifactHandlersRef: { current: undefined },
    pdfAnnotationService: { importNative },
    onArtifactsPublished
  } as unknown as Parameters<typeof composeArtifactSurfaces>[0])
  const onPublished = vi.mocked(createArtifactHandlers).mock.calls[0][2]!.onPublished!
  return { onPublished, importNative, warn }
}
const artifact: ArtifactFile = {
  id: 'version',
  projectId: 'project',
  sessionId: 'session',
  name: 'report.pdf',
  path: '/fixture/report.pdf',
  fileUrl: 'artifact://version',
  size: 12,
  mtimeMs: 1,
  artifactId: 'file',
  versionId: 'version',
  mimeType: 'application/pdf'
}

it('starts publication reconciliation without waiting and retains native PDF enrichment', async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const notify = vi.fn(() => pending)
  const { onPublished, importNative, warn } = setup(notify)
  const files = [artifact]
  expect(onPublished(files)).toBeUndefined()
  expect(notify).toHaveBeenCalledExactlyOnceWith(files)
  expect(importNative).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: 'project',
      sessionId: 'session',
      sourceFileId: 'file',
      versionId: 'version'
    })
  )
  expect(warn).not.toHaveBeenCalled()
  finish()
  await pending
})

it('logs asynchronous reconciliation failure without failing completed publication or PDF enrichment', async () => {
  const notify = vi.fn().mockRejectedValue(new Error('retained outputs require later inspection'))
  const { onPublished, importNative, warn } = setup(notify)
  expect(() => onPublished([artifact])).not.toThrow()
  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith(
      'Managed output publication reconciliation failed',
      expect.any(Object)
    )
  )
  expect(importNative).toHaveBeenCalledOnce()
})
