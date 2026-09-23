// @vitest-environment jsdom
import { act, fireEvent, render, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProjectFileItem } from '../../../../shared/project-files'
import { HiddenArtifactFiles } from './HiddenArtifactFiles'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      key.replace(/{{(\w+)}}/g, (_, name) => String(args?.[name] ?? name))
  })
}))
const viewport = vi.hoisted(() => ({ visible: true }))
vi.mock('./previews/useNearViewport', () => ({
  useNearViewport: () => [() => {}, viewport.visible]
}))
vi.mock('./artifact-preview', () => ({
  ArtifactPreview: ({ preview }: { preview?: { content: string } }) => (
    <span data-testid="safe-thumbnail">{preview?.content}</span>
  )
}))
const file: ProjectFileItem = {
  id: 'artifact:a',
  source: 'artifact',
  hidden: true,
  sourceFileId: 'a',
  sourceVersionId: 'v',
  projectId: 'p',
  sessionId: 's',
  name: 'secret.txt',
  path: '/never-read-directly',
  mimeType: 'text/plain',
  size: 2048,
  sortAtMs: 1
}
const listFiles = vi.fn()
const readHiddenArtifact = vi.fn()
const ordinaryRead = vi.fn()
const saveProjectArtifacts = vi.fn()
const setArtifactHidden = vi.fn()
let changed: (event: { projectId: string }) => void
beforeEach(() => {
  vi.clearAllMocks()
  viewport.visible = true
  listFiles.mockResolvedValue({ items: [file], totalCount: 1 })
  readHiddenArtifact.mockResolvedValue({ content: 'secret contents', truncated: false })
  saveProjectArtifacts.mockResolvedValue({ saved: true })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      projectFiles: {
        listFiles,
        readHiddenArtifact,
        setArtifactHidden,
        onChanged: (cb: typeof changed) => {
          changed = cb
          return () => {}
        }
      },
      readArtifactPreview: ordinaryRead,
      saveProjectArtifacts
    }
  })
})
afterEach(cleanup)

it('shares grid/list metadata and reports filtered counts without ordinary preview access', async () => {
  const onCountChange = vi.fn()
  const view = render(
    <HiddenArtifactFiles projectId="p" query="" viewMode="grid" onCountChange={onCountChange} />
  )
  await waitFor(() =>
    expect(view.container.querySelector('[data-view-mode="grid"]')).not.toBeNull()
  )
  expect(view.getByTestId('project-file-meta').textContent).toContain('2 KB')
  expect(onCountChange).toHaveBeenLastCalledWith(1)
  expect(view.getByTestId('project-files-end').textContent).toBe('No more')
  view.rerender(
    <HiddenArtifactFiles projectId="p" query="" viewMode="list" onCountChange={onCountChange} />
  )
  expect(view.container.querySelector('[data-view-mode="list"]')).not.toBeNull()
  expect(view.getByTestId('project-file-list-meta').textContent).toContain('2 KB')
  expect(listFiles).toHaveBeenCalledTimes(1)
  expect(ordinaryRead).not.toHaveBeenCalled()
})

it('keeps preview, download and unhide confined to the Hidden surface', async () => {
  const view = render(<HiddenArtifactFiles projectId="p" query="" viewMode="list" />)
  fireEvent.click(await view.findByRole('button', { name: 'Preview generated file secret.txt' }))
  expect(await view.findByRole('dialog', { name: 'secret.txt' })).toBeTruthy()
  await view.findByText('secret contents')
  expect(readHiddenArtifact).toHaveBeenCalledWith({
    projectId: 'p',
    fileId: 'a',
    versionId: 'v',
    encoding: 'utf8'
  })
  fireEvent.click(view.getAllByRole('button', { name: 'Download secret.txt' }).at(-1)!)
  await waitFor(() =>
    expect(saveProjectArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [expect.objectContaining({ hidden: true, fileId: 'a', versionId: 'v' })]
      })
    )
  )
  fireEvent.click(view.getAllByRole('button', { name: 'Unhide secret.txt' }).at(-1)!)
  await waitFor(() =>
    expect(setArtifactHidden).toHaveBeenCalledWith({ projectId: 'p', fileId: 'a', hidden: false })
  )
  act(() => changed({ projectId: 'p' }))
  await waitFor(() => expect(view.queryByRole('dialog')).toBeNull())
  expect(ordinaryRead).not.toHaveBeenCalled()
})

it('uses the shared search empty state and filtered count', async () => {
  listFiles.mockResolvedValue({ items: [], totalCount: 0 })
  const onCountChange = vi.fn()
  const view = render(
    <HiddenArtifactFiles
      projectId="p"
      query="absent"
      viewMode="grid"
      onCountChange={onCountChange}
    />
  )
  await view.findByText('No files match “absent”')
  expect(listFiles).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: { kind: 'hidden' },
      search: { filenameContains: 'absent' }
    })
  )
  expect(onCountChange).toHaveBeenLastCalledWith(0)
})

it('bounds thumbnail reads, avoids re-reading on rerender and drops offscreen bytes', async () => {
  const view = render(<HiddenArtifactFiles projectId="p" query="" viewMode="grid" />)
  await view.findByText('secret contents')
  expect(readHiddenArtifact).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 32 * 1024 }))
  view.rerender(<HiddenArtifactFiles projectId="p" query="" viewMode="grid" />)
  expect(readHiddenArtifact).toHaveBeenCalledTimes(1)
  viewport.visible = false
  view.rerender(<HiddenArtifactFiles projectId="p" query="" viewMode="grid" />)
  expect(view.queryByText('secret contents')).toBeNull()
  viewport.visible = true
  view.rerender(<HiddenArtifactFiles projectId="p" query="" viewMode="grid" />)
  await view.findByText('secret contents')
  expect(readHiddenArtifact).toHaveBeenCalledTimes(2)
})

it('discards a pending old page when the search changes', async () => {
  let finishOldPage!: (page: unknown) => void
  listFiles
    .mockResolvedValueOnce({ items: [file], totalCount: 2, nextCursor: 'next' })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldPage = resolve
        })
    )
    .mockResolvedValue({ items: [], totalCount: 0 })
  const onCountChange = vi.fn()
  const view = render(
    <HiddenArtifactFiles projectId="p" query="" viewMode="list" onCountChange={onCountChange} />
  )
  await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2))
  view.rerender(
    <HiddenArtifactFiles projectId="p" query="new" viewMode="list" onCountChange={onCountChange} />
  )
  await view.findByText('No files match “new”')
  await act(async () => {
    finishOldPage({ items: [file], totalCount: 2 })
  })
  expect(view.queryByRole('button', { name: 'Preview generated file secret.txt' })).toBeNull()
  expect(onCountChange).toHaveBeenLastCalledWith(0)
})
