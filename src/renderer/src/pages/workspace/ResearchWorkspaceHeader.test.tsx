// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { ResearchWorkspaceHeader } from './ResearchWorkspaceHeader'
import { FOCUS_COMPOSER_EVENT } from './composer-focus-events'

const openResearch = vi.hoisted(() => vi.fn())
vi.mock('react-i18next', () => createI18nTestStub())
vi.mock('./workspace-discussion-navigation', () => ({ openResearchWorkspace: openResearch }))
const source = {
  sourceProjectId: 'project',
  sourceSessionId: 'source',
  sourceImportId: 'import',
  sourceTitle: 'Snapshot title'
}
const record: ChatSession = {
  id: 'source',
  projectId: 'project',
  title: 'Current title',
  cwd: '',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  importedResearch: { importId: 'import' },
  contentLoaded: false
}
beforeEach(() => {
  vi.clearAllMocks()
  useSessionStore.setState({ sessions: [record], selectedSessionId: 'discussion' })
  usePreviewWorkbenchStore.setState({
    byProject: {},
    activeProjectId: 'project',
    items: [],
    activeItemId: undefined,
    panelState: 'collapsed'
  })
  openResearch.mockResolvedValue(true)
})
afterEach(cleanup)

it('uses the current research title and opens the source replay without leaving the discussion', () => {
  render(
    <ResearchWorkspaceHeader source={source} historical={false}>
      <span>Question one</span>
    </ResearchWorkspaceHeader>
  )
  expect(screen.getByText('Current title')).toBeTruthy()
  expect(screen.getByText('Discussion')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'View replay' }))
  expect(usePreviewWorkbenchStore.getState().panelState).toBe('open')
  expect(useSessionStore.getState().selectedSessionId).toBe('discussion')
  expect(usePreviewWorkbenchStore.getState().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        replaySourceProjectId: 'project',
        replaySourceSessionId: 'source',
        replayRevealRequest: expect.any(Number)
      })
    ])
  )
  fireEvent.click(screen.getByRole('button', { name: 'View replay' }))
  expect(usePreviewWorkbenchStore.getState().panelState).toBe('open')
  expect(usePreviewWorkbenchStore.getState().items).toHaveLength(1)
})

it('keeps a discussion visible with its saved title when the source is missing', () => {
  useSessionStore.setState({ sessions: [] })
  render(
    <ResearchWorkspaceHeader source={source} historical={false}>
      <span>Question one</span>
    </ResearchWorkspaceHeader>
  )
  expect(screen.getByText('Snapshot title')).toBeTruthy()
  expect(screen.getByText('Question one')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'New discussion' }).hasAttribute('disabled')).toBe(true)
})

it('keeps the original record open and focuses its inline question without navigating', async () => {
  const focus = vi.fn()
  window.addEventListener(FOCUS_COMPOSER_EVENT, focus)
  render(
    <ResearchWorkspaceHeader source={source} historical>
      <span>Original title</span>
    </ResearchWorkspaceHeader>
  )
  expect(screen.getByText('Original record · Read-only')).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this research' }))
  })
  expect(openResearch).not.toHaveBeenCalled()
  expect(focus).toHaveBeenCalledOnce()
  window.removeEventListener(FOCUS_COMPOSER_EVENT, focus)
})

it('keeps replay and discussion as the research actions without a parallel run launcher', () => {
  render(
    <ResearchWorkspaceHeader source={source} historical>
      <span>Original title</span>
    </ResearchWorkspaceHeader>
  )
  expect(screen.queryByRole('button', { name: /run/i })).toBeNull()
  expect(screen.getByRole('button', { name: 'View replay' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Ask about this research' })).toBeTruthy()
})
