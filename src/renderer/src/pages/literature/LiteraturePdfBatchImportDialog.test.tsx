// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  literatureItemInputSchema,
  LITERATURE_IMPORT_IDENTITY_CONFLICT
} from '../../../../shared/literature'
import { LiteraturePdfBatchImportDialog } from './LiteraturePdfBatchImportDialog'

const mocks = vi.hoisted(() => ({ extract: vi.fn(), complete: vi.fn(), stage: vi.fn() }))
vi.mock('./literature-pdf-metadata', () => ({
  extractLiteraturePdfDraft: mocks.extract,
  completeLiteraturePdfDraft: mocks.complete
}))
vi.mock('../workspace/composer-upload-transfer', () => ({ stageComposerFile: mocks.stage }))
const transact = vi.fn()
const importPdf = vi.fn()
const deleteUpload = vi.fn()
const abortTransfer = vi.fn()
const claimLocalFile = vi.fn()
const close = vi.fn()
const files = ['first.pdf', 'second.pdf'].map(
  (name) => new File(['%PDF-1.7'], name, { type: 'application/pdf' })
)
const attachment = { path: '/managed/pdf' }
const createDraft = (file: File): ReturnType<typeof literatureItemInputSchema.parse> =>
  literatureItemInputSchema.parse({ itemType: 'journalArticle', title: file.name })
const deferred = <T,>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const open = (): ReturnType<typeof render> =>
  render(
    <LiteraturePdfBatchImportDialog
      files={files}
      destination={{ name: 'Captured project', projectId: 'project-original' }}
      createDraft={createDraft}
      onClose={close}
    />
  )
const start = async (): Promise<void> => {
  const button = await screen.findByRole('button', { name: 'Import selected' })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(button)
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.extract.mockImplementation(async (_file, draft) => draft)
  mocks.complete.mockImplementation(async (draft) => draft)
  mocks.stage.mockResolvedValue(attachment)
  let id = 0
  transact.mockImplementation(async (command) => ({
    id: command.kind === 'create-item' ? `item-${++id}` : command.itemId
  }))
  importPdf.mockResolvedValue({ item: {} })
  deleteUpload.mockResolvedValue(undefined)
  abortTransfer.mockResolvedValue(undefined)
  claimLocalFile.mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: { transact, importPdf },
      uploads: { deleteUpload, abortTransfer, claimLocalFile }
    }
  })
})
afterEach(cleanup)

it('shows filenames before metadata resolves and writes nothing until confirmation', async () => {
  const read = deferred<ReturnType<typeof createDraft>>()
  mocks.extract.mockReturnValueOnce(read.promise)
  open()
  expect(screen.getAllByText('first.pdf').length).toBeGreaterThan(0)
  expect(screen.getByText('Captured project')).not.toBeNull()
  expect(
    (screen.getByRole('button', { name: 'Import selected' }) as HTMLButtonElement).disabled
  ).toBe(true)
  expect(transact).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(close).toHaveBeenCalledOnce()
  await act(async () => read.resolve(createDraft(files[0])))
})

it('continues after an attachment failure and retries the existing reference without duplicating successful rows', async () => {
  importPdf.mockRejectedValueOnce(new Error('Bad PDF'))
  open()
  await start()
  await screen.findByText('1 / 2 completed')
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Retry unfinished' }) as HTMLButtonElement).disabled
    ).toBe(false)
  )
  expect(transact.mock.calls.filter(([c]) => c.kind === 'create-item')).toHaveLength(2)
  expect(transact).toHaveBeenCalledWith({
    kind: 'set-project-item',
    projectId: 'project-original',
    itemId: 'item-2',
    included: true,
    source: 'library'
  })
  fireEvent.click(screen.getByRole('button', { name: 'Retry unfinished' }))
  await screen.findByText('2 / 2 completed')
  expect(transact.mock.calls.filter(([c]) => c.kind === 'create-item')).toHaveLength(2)
  expect(importPdf.mock.calls.map(([c]) => c.itemId)).toEqual(['item-1', 'item-2', 'item-1'])
  expect(deleteUpload).toHaveBeenCalledTimes(3)
})

it('reports identifier conflicts without attaching and allows an explicit retry', async () => {
  transact.mockRejectedValueOnce(new Error(LITERATURE_IMPORT_IDENTITY_CONFLICT))
  open()
  await start()
  await screen.findByText('Conflicting identifiers')
  await screen.findByText('1 / 2 completed')
  expect(importPdf).toHaveBeenCalledTimes(1)
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Retry unfinished' }) as HTMLButtonElement).disabled
    ).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Retry unfinished' }))
  await screen.findByText('2 / 2 completed')
})

it('does not replay an unconfirmed creation and still imports other files', async () => {
  transact.mockRejectedValueOnce(new Error('Response lost'))
  open()
  await start()
  await screen.findByText(
    'The result could not be confirmed. Check your library before importing this file again.'
  )
  await screen.findByText('1 / 2 completed')
  expect(
    (screen.getByRole('button', { name: 'Retry unfinished' }) as HTMLButtonElement).disabled
  ).toBe(true)
  expect(transact.mock.calls.filter(([c]) => c.kind === 'create-item')).toHaveLength(2)
})

it('honors deselection and retains filename metadata fallback', async () => {
  mocks.extract.mockRejectedValueOnce(new Error('No metadata'))
  open()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select second.pdf' }))
  await start()
  await screen.findByText('1 / 2 completed')
  expect(transact.mock.calls.filter(([c]) => c.kind === 'create-item')).toHaveLength(1)
  expect(transact).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'create-item',
      item: expect.objectContaining({ title: 'first.pdf' })
    })
  )
})

it('stops an active upload, cleans its late stage and retries without creating a second reference', async () => {
  const staged = deferred<typeof attachment>()
  mocks.stage.mockReturnValueOnce(staged.promise)
  open()
  await start()
  await waitFor(() => expect(mocks.stage).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(mocks.stage.mock.calls[0][2].signal.aborted).toBe(true)
  expect(abortTransfer).toHaveBeenCalledOnce()
  await act(async () => staged.resolve(attachment))
  await screen.findByText('PDF upload cancelled. The reference was kept.')
  expect(deleteUpload).toHaveBeenCalledWith({ path: attachment.path })
  expect(importPdf).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Retry unfinished' }))
  await screen.findByText('2 / 2 completed')
  expect(transact.mock.calls.filter(([c]) => c.kind === 'create-item')).toHaveLength(2)
})

it('finishes a submitted import before stopping and does not start the next file', async () => {
  const result = deferred<{ item: object }>()
  importPdf.mockReturnValueOnce(result.promise)
  open()
  await start()
  await waitFor(() => expect(importPdf).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(abortTransfer).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => result.resolve({ item: {} }))
  await screen.findByText('1 / 2 completed')
  expect(transact.mock.calls.filter(([c]) => c.kind === 'create-item')).toHaveLength(1)
})

it('does not start uploads after unmount while creation is pending', async () => {
  const created = deferred<{ id: string }>()
  transact.mockReturnValueOnce(created.promise)
  const view = open()
  await start()
  await waitFor(() => expect(transact).toHaveBeenCalledOnce())
  view.unmount()
  await act(async () => created.resolve({ id: 'late-item' }))
  expect(mocks.stage).not.toHaveBeenCalled()
  expect(transact).toHaveBeenCalledOnce()
})

it('aborts the backend upload on unmount and never imports late bytes', async () => {
  const staged = deferred<typeof attachment>()
  mocks.stage.mockReturnValueOnce(staged.promise)
  const view = open()
  await start()
  await waitFor(() => expect(mocks.stage).toHaveBeenCalledOnce())
  view.unmount()
  expect(abortTransfer).toHaveBeenCalledOnce()
  await act(async () => staged.resolve(attachment))
  expect(importPdf).not.toHaveBeenCalled()
  expect(deleteUpload).toHaveBeenCalledOnce()
})

it('shows current upload progress alongside both file rows', async () => {
  const stage = deferred<typeof attachment>()
  mocks.stage.mockImplementationOnce((_file, _api, options) => {
    options.onProgress({
      transferId: options.transferId,
      name: 'first.pdf',
      receivedBytes: 4,
      totalBytes: 8
    })
    return stage.promise
  })
  open()
  await start()
  expect(await screen.findByRole('progressbar', { name: 'Upload progress' })).toHaveProperty(
    'value',
    4
  )
  const list = screen.getByRole('list')
  expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  await act(async () => stage.resolve(attachment))
  await screen.findByText('2 / 2 completed')
})

it('retries a failed destination link with the original creation receipt', async () => {
  let failLink = true
  transact.mockImplementation(async (command) => {
    if (command.kind === 'create-item') return { id: command.item.title }
    if (command.itemId === 'first.pdf' && failLink) {
      failLink = false
      throw new Error('Link failed')
    }
    return { id: command.itemId }
  })
  open()
  await start()
  await screen.findByText('1 / 2 completed')
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Retry unfinished' }) as HTMLButtonElement).disabled
    ).toBe(false)
  )
  expect(importPdf.mock.calls.map(([c]) => c.itemId)).toEqual(['second.pdf'])
  fireEvent.click(screen.getByRole('button', { name: 'Retry unfinished' }))
  await screen.findByText('2 / 2 completed')
  expect(transact.mock.calls.filter(([c]) => c.kind === 'create-item')).toHaveLength(2)
  expect(importPdf.mock.calls.map(([c]) => c.itemId)).toEqual(['second.pdf', 'first.pdf'])
})
