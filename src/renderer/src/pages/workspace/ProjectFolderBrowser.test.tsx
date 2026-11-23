// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectFolderBrowser } from './ProjectFolderBrowser'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import type { LocalDirEntry } from '../../../../shared/local-fs'
import type { ProjectFolderListing } from '../../../../shared/project-folder-files'

const entry = (name: string, isDirectory = false): LocalDirEntry => ({
  name,
  isDirectory,
  size: isDirectory ? 0 : 20,
  mtimeMs: 100
})
const page = (
  entries = [entry('analysis', true), entry('raw.csv')],
  overrides: Partial<ProjectFolderListing> = {}
): ProjectFolderListing => ({
  path: '/Research/cohort-study',
  relativePath: '',
  totalCount: entries.length,
  entries,
  ...overrides
})
const listFolder = vi.fn()
const reveal = vi.fn()
const count = vi.fn()
beforeEach(() => {
  listFolder.mockReset().mockResolvedValue(page())
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  reveal.mockReset().mockResolvedValue(undefined)
  count.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { platform: 'darwin', projects: { listFolder }, localFs: { reveal } }
  })
})
afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-open-science-web-events')
})
const mount = (rootPath = '/Research/cohort-study'): ReturnType<typeof render> =>
  render(
    <ProjectFolderBrowser projectId="research" rootPath={rootPath} onEntryCountChange={count} />
  )

describe('Project folder browser', () => {
  it('reads only the selected directory and navigates via clickable ancestors', async () => {
    mount()
    await screen.findByRole('button', { name: 'analysis' })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(listFolder).toHaveBeenCalledWith({
      projectId: 'research',
      relativePath: '',
      limit: 100
    })
    listFolder.mockResolvedValue(page([entry('figures', true)], { relativePath: 'analysis' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'analysis' })))
    expect(listFolder).toHaveBeenLastCalledWith({
      projectId: 'research',
      relativePath: 'analysis',
      limit: 100
    })
    listFolder.mockResolvedValue(page([entry('nested.csv')], { relativePath: 'analysis/figures' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'figures' })))
    const path = within(screen.getByRole('navigation', { name: 'Folder path' }))
    expect(path.getByText('figures').getAttribute('aria-current')).toBe('page')
    expect(listFolder).toHaveBeenLastCalledWith({
      projectId: 'research',
      relativePath: 'analysis/figures',
      limit: 100
    })
    expect(screen.getByRole('button', { name: /nested.csv/ })).not.toBeNull()
    listFolder.mockResolvedValue(page())
    await act(async () => fireEvent.click(path.getByRole('button', { name: 'cohort-study' })))
    expect(listFolder).toHaveBeenLastCalledWith({
      projectId: 'research',
      relativePath: '',
      limit: 100
    })
  })

  it('collapses intermediate folders and opens the selected Windows ancestor', async () => {
    Object.defineProperty(window.api, 'platform', { value: 'win32' })
    const root = 'D:\\Research\\cohort-study'
    const folders = ['notebooks', 'run-id', 'execution-id', 'data']
    listFolder.mockImplementation(async ({ relativePath }: { relativePath: string }) => {
      const depth = relativePath ? relativePath.split('\\').length : 0
      return page([depth < folders.length ? entry(folders[depth], true) : entry('result.csv')], {
        relativePath
      })
    })
    mount(root)
    for (const name of folders) {
      const folder = await screen.findByRole('button', { name })
      await act(async () => fireEvent.click(folder))
    }

    const nav = screen.getByRole('navigation', { name: 'Folder path' })
    const path = within(nav)
    expect(path.getByText('data').getAttribute('title')).toBe([root, ...folders].join('\\'))
    expect(path.getByRole('button', { name: 'cohort-study' })).toBeTruthy()
    expect(path.getByRole('button', { name: 'execution-id' })).toBeTruthy()
    expect(path.queryByText('notebooks')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.keyDown(path.getByRole('button', { name: 'Show parent folders' }), { key: 'Enter' })
    const menu = within(await screen.findByRole('menu', { name: 'Show parent folders' }))
    expect(menu.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'notebooks',
      'run-id'
    ])
    fireEvent.click(menu.getByRole('menuitem', { name: 'run-id' }))
    await waitFor(() =>
      expect(listFolder).toHaveBeenLastCalledWith({
        projectId: 'research',
        relativePath: 'notebooks\\run-id',
        limit: 100
      })
    )
    expect(document.activeElement).toBe(nav)
    expect(path.getByText('run-id').getAttribute('aria-current')).toBe('page')
    expect(path.queryByRole('button', { name: 'Show parent folders' })).toBeNull()
  })

  it('appends bounded pages and refreshes external changes when the window regains focus', async () => {
    listFolder
      .mockResolvedValueOnce(page([entry('first.csv')], { totalCount: 2, nextCursor: 'next' }))
      .mockResolvedValueOnce(page([entry('second.csv')], { totalCount: 2 }))
      .mockResolvedValueOnce(page([entry('external.csv')]))
    mount()
    await screen.findByRole('button', { name: 'Load more' })
    const firstFile = screen.getByRole('button', { name: /first.csv/ })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load more' })))
    expect(listFolder).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next' }))
    expect(screen.getByRole('button', { name: /first.csv/ })).toBe(firstFile)
    expect(screen.getByRole('button', { name: /second.csv/ })).not.toBeNull()
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(screen.getByRole('button', { name: /external.csv/ })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /first.csv/ })).toBeNull()
  })

  it('opens the shared preview dialog with a Project-scoped file item', async () => {
    mount()
    await screen.findByRole('button', { name: /raw.csv/ })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /raw.csv/ })))
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      projectId: 'research',
      path: 'raw.csv',
      name: 'raw.csv',
      source: 'project-folder',
      format: 'csv'
    })
  })

  it('keeps folder errors stable and details collapsed while offering retry', async () => {
    listFolder.mockRejectedValueOnce({
      code: 'project-folder-unavailable',
      message: 'EPERM: /Research/cohort-study'
    })
    mount()
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toBe('Unable to access project folder')
    expect(document.querySelector('details')?.open).toBe(false)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: /raw.csv/ })).not.toBeNull()
  })

  it('reveals the saved folder locally and leaves the same action disabled remotely', async () => {
    const view = mount()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' })))
    expect(reveal).toHaveBeenCalledWith('/Research/cohort-study')
    document.documentElement.setAttribute('data-open-science-web-events', 'true')
    view.rerender(
      <ProjectFolderBrowser
        projectId="research"
        rootPath="/Research/cohort-study"
        onEntryCountChange={count}
      />
    )
    expect(
      (screen.getByRole('button', { name: 'Reveal in Finder' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
})
