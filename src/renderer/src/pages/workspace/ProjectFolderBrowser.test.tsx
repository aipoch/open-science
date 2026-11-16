// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const mount = (): ReturnType<typeof render> =>
  render(
    <ProjectFolderBrowser
      projectId="research"
      rootPath="/Research/cohort-study"
      onEntryCountChange={count}
    />
  )

describe('Project folder browser', () => {
  it('reads only the selected directory and navigates back to its parent', async () => {
    mount()
    await screen.findByRole('button', { name: 'analysis' })
    expect(listFolder).toHaveBeenCalledWith({
      projectId: 'research',
      relativePath: '',
      query: '',
      limit: 100
    })
    listFolder.mockResolvedValue(page([entry('nested.csv')], { relativePath: 'analysis' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'analysis' })))
    expect(listFolder).toHaveBeenLastCalledWith({
      projectId: 'research',
      relativePath: 'analysis',
      query: '',
      limit: 100
    })
    expect(screen.getByRole('button', { name: /nested.csv/ })).not.toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Go up one level' })))
    expect(listFolder).toHaveBeenLastCalledWith({
      projectId: 'research',
      relativePath: '',
      query: '',
      limit: 100
    })
  })

  it('appends bounded pages and refreshes external changes when the window regains focus', async () => {
    listFolder
      .mockResolvedValueOnce(page([entry('first.csv')], { totalCount: 2, nextCursor: 'next' }))
      .mockResolvedValueOnce(page([entry('second.csv')], { totalCount: 2 }))
      .mockResolvedValueOnce(page([entry('external.csv')]))
    mount()
    await screen.findByRole('button', { name: 'Load more' })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load more' })))
    expect(listFolder).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next' }))
    expect(screen.getByRole('button', { name: /first.csv/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /second.csv/ })).not.toBeNull()
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(screen.getByRole('button', { name: /external.csv/ })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /first.csv/ })).toBeNull()
  })

  it('debounces filename search without scanning child folders', async () => {
    mount()
    await screen.findByRole('button', { name: 'analysis' })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'raw' } })
    await waitFor(() =>
      expect(listFolder).toHaveBeenLastCalledWith({
        projectId: 'research',
        relativePath: '',
        query: 'raw',
        limit: 100
      })
    )
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
