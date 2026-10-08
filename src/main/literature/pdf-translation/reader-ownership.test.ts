import { expect, it, vi } from 'vitest'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import { PdfTranslationOwner } from './index'
import type { PdfTranslationCheckpoints } from './checkpoints'
vi.mock('electron', () => ({ net: {} }))

const input = {
  resourceRequestKey: 'reader',
  fingerprint: 'pdf',
  language: 'Chinese',
  glossary: [],
  sources: ['Cells grew.'],
  attachmentVersionId: 'v'
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve mock method inference in the test fixture.
const setup = (checkpoints?: PdfTranslationCheckpoints) => {
  const registry = new ApplicationCallerLeaseRegistry()
  const first = registry.acquire({ leaseId: 'first', surface: 'electron' })
  const second = registry.acquire({ leaseId: 'second', surface: 'electron' })
  const captureTarget = vi.fn(async () => ({
    frameworkId: 'claude-code' as const,
    providerId: 'provider',
    model: { kind: 'required' as const, id: 'model' },
    reasoningEffort: 'default' as const
  }))
  const owner = new PdfTranslationOwner({
    captureTarget,
    runner: {
      supportsTarget: () => true,
      run: vi.fn(),
      shutdown: async () => {},
      sweepStaleProfiles: async () => {}
    },
    checkpoints:
      checkpoints ?? ({ open: async () => undefined } as unknown as PdfTranslationCheckpoints),
    usage: { start: async () => async () => {}, recover: async () => {}, flush: async () => {} }
  })
  return { owner, captureTarget, first, second }
}

it('reserves a document before asynchronous admission and releases it on close', async () => {
  const { owner, captureTarget, first, second } = setup()
  const pending = owner.begin(input, first.lease)
  await expect(owner.begin(input, second.lease)).rejects.toMatchObject({ code: 'document-busy' })
  expect(captureTarget).toHaveBeenCalledTimes(1)
  const admitted = await pending
  const different = await owner.begin({ ...input, attachmentVersionId: 'other' }, second.lease)
  owner.close(admitted.operationId, first.lease)
  const handedOff = await owner.begin(input, second.lease)
  owner.close(handedOff.operationId, second.lease)
  owner.close(different.operationId, second.lease)
})

it('treats structured literature identity and version ID as the same document', async () => {
  const { owner, first, second } = setup()
  const admitted = await owner.begin(input, first.lease)
  await expect(
    owner.begin(
      {
        ...input,
        attachmentVersionId: undefined,
        documentSource: {
          kind: 'literature-attachment-version',
          sourceFileId: 'file',
          versionId: 'v',
          checksum: 'a'.repeat(64),
          name: 'paper.pdf',
          path: 'paper.pdf'
        }
      },
      second.lease
    )
  ).rejects.toMatchObject({ code: 'document-busy' })
  owner.close(admitted.operationId, first.lease)
})

it('releases admission on failure and on caller loss', async () => {
  const { owner, captureTarget, first, second } = setup()
  captureTarget.mockRejectedValueOnce(new Error('provider unavailable'))
  await expect(owner.begin(input, first.lease)).rejects.toThrow('provider unavailable')
  await owner.begin(input, first.lease)
  first.release()
  const admitted = await owner.begin(input, second.lease)
  owner.close(admitted.operationId, second.lease)
})

const workspaceInput = {
  ...input,
  attachmentVersionId: undefined,
  documentSource: {
    kind: 'upload-version' as const,
    projectId: 'project',
    sourceFileId: 'file',
    versionId: 'upload-v',
    checksum: 'a'.repeat(64),
    name: 'paper.pdf',
    path: 'upload-version:upload-v'
  }
}

it.each(['workspace', 'literature'] as const)(
  'blocks duplicate content before the first checkpoint opens when %s starts first',
  async (source) => {
    let finishOpen!: () => void
    const open = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishOpen = resolve
        })
    )
    const contentKey = vi.fn().mockResolvedValue(`${'b'.repeat(64)}:1000`)
    const { owner, captureTarget, first, second } = setup({
      contentKey,
      open
    } as unknown as PdfTranslationCheckpoints)
    const [firstInput, secondInput] =
      source === 'workspace' ? [workspaceInput, input] : [input, workspaceInput]
    const pending = owner.begin(firstInput, first.lease)
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    await expect(owner.begin(secondInput, second.lease)).rejects.toMatchObject({
      code: 'document-busy'
    })
    expect(captureTarget).toHaveBeenCalledOnce()
    expect(contentKey).toHaveBeenCalledWith('v')
    expect(contentKey).toHaveBeenCalledWith(workspaceInput.documentSource)
    finishOpen()
    const admitted = await pending
    owner.close(admitted.operationId, first.lease)
  }
)

it('admits different verified content even when the caller claims the same checksum', async () => {
  const contentKey = vi
    .fn()
    .mockResolvedValueOnce('verified-a:1000')
    .mockResolvedValueOnce('verified-b:1000')
  const { owner, first, second } = setup({
    contentKey,
    open: async () => undefined
  } as unknown as PdfTranslationCheckpoints)
  const admitted = await owner.begin(workspaceInput, first.lease)
  const different = await owner.begin(
    {
      ...workspaceInput,
      documentSource: { ...workspaceInput.documentSource, versionId: 'upload-v2' }
    },
    second.lease
  )
  owner.close(admitted.operationId, first.lease)
  owner.close(different.operationId, second.lease)
})

it('releases shared content admission after target failure and caller cancellation', async () => {
  const { owner, captureTarget, first, second } = setup({
    contentKey: async () => 'verified:1000',
    open: async () => undefined
  } as unknown as PdfTranslationCheckpoints)
  captureTarget.mockRejectedValueOnce(new Error('provider unavailable'))
  await expect(owner.begin(input, first.lease)).rejects.toThrow('provider unavailable')
  const workspace = await owner.begin(workspaceInput, second.lease)
  second.release()
  const literature = await owner.begin(input, first.lease)
  owner.close(literature.operationId, first.lease)
  owner.close(workspace.operationId, second.lease)
})

it('does not reserve content or resolve a model after cancellation during source verification', async () => {
  let finishIdentity!: (key: string) => void
  const contentKey = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishIdentity = resolve
        })
    )
    .mockResolvedValue('verified:1000')
  const { owner, captureTarget, first, second } = setup({
    contentKey,
    open: async () => undefined
  } as unknown as PdfTranslationCheckpoints)
  const pending = owner.begin(input, first.lease)
  const rejected = expect(pending).rejects.toThrow()
  first.release()
  finishIdentity('verified:1000')
  await rejected
  expect(captureTarget).not.toHaveBeenCalled()
  const admitted = await owner.begin(workspaceInput, second.lease)
  owner.close(admitted.operationId, second.lease)
})

it('rejects failed source verification before model resolution and releases admission', async () => {
  const contentKey = vi
    .fn()
    .mockRejectedValueOnce(new Error('source unavailable'))
    .mockResolvedValue('verified:1000')
  const { owner, captureTarget, first, second } = setup({
    contentKey,
    open: async () => undefined
  } as unknown as PdfTranslationCheckpoints)
  await expect(owner.begin(input, first.lease)).rejects.toMatchObject({ code: 'checkpoint-failed' })
  expect(captureTarget).not.toHaveBeenCalled()
  const admitted = await owner.begin(input, second.lease)
  owner.close(admitted.operationId, second.lease)
})
