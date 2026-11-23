// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import {
  createInitialReviewState,
  selectProjectSessionReviewLoadError,
  selectProjectSessionReviewSnapshot,
  useReviewStore
} from '@/stores/review-store'
import { ProjectFolderRecovery } from './ProjectFolderRecovery'

const checkFolder = vi.fn()
const locateFolder = vi.fn()
const pickDirectory = vi.fn()
const missing = {
  ok: false,
  kind: 'not-found',
  path: '/private/old',
  diagnostics: 'ENOENT /private/old'
}

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  useProjectStore.setState(createInitialProjectState())
  useReviewStore.setState(createInitialReviewState())
  checkFolder.mockReset().mockResolvedValue(missing)
  pickDirectory.mockReset().mockResolvedValue('/private/moved')
  locateFolder.mockReset().mockResolvedValue({
    id: 'project-1',
    name: 'Research',
    description: '',
    isExample: false,
    rootPath: '/private/moved',
    createdAt: 1,
    updatedAt: 2
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { projects: { checkFolder, locateFolder }, storage: { pickDirectory } }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-open-science-web-events')
})

it('shows missing-folder recovery in its region with collapsed diagnostics and updates the binding after locate', async () => {
  await act(async () => {
    render(<ProjectFolderRecovery projectId="project-1" rootPath="/private/old" />)
  })
  expect(screen.getByText('Project folder not found')).not.toBeNull()
  expect(screen.getByText('ENOENT /private/old').closest('details')?.open).toBe(false)
  expect(screen.queryByText('Default data location')).toBeNull()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Locate folder…' }))
  })
  expect(locateFolder).toHaveBeenCalledWith({
    projectId: 'project-1',
    path: '/private/moved',
    expectedRootPath: '/private/old'
  })
  expect(useProjectStore.getState().projects[0].rootPath).toBe('/private/moved')
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps access errors distinct and restores availability by retrying without changing the binding', async () => {
  checkFolder.mockResolvedValueOnce({
    ok: false,
    kind: 'unavailable',
    diagnostics: 'EROFS /private/old'
  })
  await act(async () => {
    render(<ProjectFolderRecovery projectId="project-1" rootPath="/private/old" />)
  })
  expect(screen.getByText('Unable to access project folder')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Locate folder…' })).toBeNull()
  expect(screen.getByText('EROFS /private/old').closest('details')?.open).toBe(false)
  checkFolder.mockResolvedValueOnce({ ok: true, path: '/private/old' })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(locateFolder).not.toHaveBeenCalled()
  expect(useProjectStore.getState().projects).toEqual([])
})

it('omits location selection in browser surfaces while retaining retry', async () => {
  document.documentElement.setAttribute('data-open-science-web-events', '')
  await act(async () => {
    render(<ProjectFolderRecovery projectId="project-1" rootPath="/private/old" />)
  })
  expect(screen.queryByRole('button', { name: 'Locate folder…' })).toBeNull()
  expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false)
})

it('retains missing-folder recovery when the system picker is canceled', async () => {
  pickDirectory.mockResolvedValueOnce(null)
  await act(async () => {
    render(<ProjectFolderRecovery projectId="project-1" rootPath="/private/old" />)
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Locate folder…' }))
  })
  expect(screen.getByText('Project folder not found')).not.toBeNull()
  expect(locateFolder).not.toHaveBeenCalled()
})

it('discards an obsolete health response after switching projects', async () => {
  let release!: (result: unknown) => void
  checkFolder.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    })
  )
  const view = render(<ProjectFolderRecovery projectId="project-1" rootPath="/private/old" />)
  checkFolder.mockResolvedValueOnce({ ok: true, path: '/private/other' })
  await act(async () => {
    view.rerender(<ProjectFolderRecovery projectId="project-2" rootPath="/private/other" />)
  })
  await act(async () => {
    release(missing)
  })
  expect(screen.queryByRole('alert')).toBeNull()
})

function ReviewResumeGate(): React.JSX.Element {
  const blocked = useReviewStore(
    (state) =>
      selectProjectSessionReviewSnapshot(
        state.reviewsBySession,
        'project-1',
        'session-1',
        state.loadedReviewSessions
      ) === undefined ||
      selectProjectSessionReviewLoadError(state.loadErrorsBySession, 'project-1', 'session-1') !==
        undefined
  )
  return <button disabled={blocked}>Resume</button>
}

it.each(['locate', 'retry'])(
  'restores the review-dependent Resume gate after folder %s succeeds',
  async (recovery) => {
    const getForSession = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Folder unavailable'), { code: 'project-folder-not-found' })
      )
      .mockResolvedValueOnce([])
    Object.assign(window.api, { reviewer: { getForSession } })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await act(async () => {
      await useReviewStore.getState().loadReviewsForSession('session-1', 'project-1')
      render(
        <>
          <ProjectFolderRecovery
            projectId="project-1"
            sessionId="session-1"
            rootPath="/private/old"
          />
          <ReviewResumeGate />
        </>
      )
    })
    expect(screen.getByRole('button', { name: 'Resume' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Project folder not found')).not.toBeNull()
    if (recovery === 'retry') checkFolder.mockResolvedValueOnce({ ok: true, path: '/private/old' })
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: recovery === 'locate' ? 'Locate folder…' : 'Retry' })
      )
    })
    expect(getForSession).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Resume' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(consoleError).not.toHaveBeenCalled()
  }
)
