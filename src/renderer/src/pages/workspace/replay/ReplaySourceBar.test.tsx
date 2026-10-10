// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatSession } from '@/stores/session-store'
import { useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import { useProjectStore } from '@/stores/project-store'
import { createSessionReplayItem } from '../workspace-session-actions'
import { ReplaySourceBar } from './ReplaySourceBar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      key.replace(/{{(\w+)}}/g, (_, name: string) => values?.[name] ?? name)
  })
}))
const membership = {
  sourceProjectId: 'p',
  sourceSessionId: 'source',
  sourceImportId: 'import',
  sourceTitle: 'Study'
}
const source = {
  id: 'source',
  projectId: 'p',
  title: 'Study',
  importedResearch: { importId: 'import' }
} as ChatSession
const discussion = {
  id: 'discussion',
  projectId: 'p',
  title: 'Question',
  researchMembership: membership
} as ChatSession
const ordinary = { id: 'ordinary', projectId: 'p', title: 'Local execution' } as ChatSession
const item = createSessionReplayItem('p', 'source', 'Study')

beforeEach(() => {
  useProjectStore.setState({
    projects: [
      { id: 'p', name: 'Project', createdAt: 1, updatedAt: 1 } as ReturnType<
        typeof useProjectStore.getState
      >['projects'][number]
    ]
  })
  useSessionStore.setState({
    sessions: [source, discussion, ordinary],
    selectedSessionId: 'discussion'
  })
  useNavigationStore.setState({ activeProjectId: 'p' })
  useResearchWorkspaceStore.setState({ draftResearchByProject: {} })
})
afterEach(cleanup)

it('identifies the source independently of the selected conversation', () => {
  render(<ReplaySourceBar item={item} />)
  expect(screen.getByText('Source: Study')).toBeTruthy()
  expect(screen.getByText('Research referenced by this discussion')).toBeTruthy()
})

it('retains relationship and exact navigation in the consolidated research details', () => {
  const open = vi.spyOn(useNavigationStore.getState(), 'openSession').mockReturnValue(true)
  render(<ReplaySourceBar item={item} variant="details" />)
  expect(screen.queryByText('Research materials')).toBeNull()
  expect(screen.getByText('Research referenced by this discussion')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open source record' }))
  expect(open).toHaveBeenCalledWith('p', 'source', 'user')
  open.mockRestore()
})

it('does not infer membership merely because a normal Session reads a study', () => {
  useSessionStore.setState({ selectedSessionId: 'ordinary' })
  render(<ReplaySourceBar item={item} />)
  expect(screen.getByText('Reference from another conversation')).toBeTruthy()
})

it('identifies a new research draft before any Session exists', () => {
  useSessionStore.setState({ selectedSessionId: undefined })
  useResearchWorkspaceStore.setState({ draftResearchByProject: { p: membership } })
  render(<ReplaySourceBar item={item} />)
  expect(screen.getByText('Research referenced by this discussion')).toBeTruthy()
})

it('opens the exact receiving source, never the currently selected discussion', () => {
  const open = vi.spyOn(useNavigationStore.getState(), 'openSession').mockReturnValue(true)
  render(
    <ReplaySourceBar
      item={{
        ...item,
        replayRecordingTarget: {
          projectId: 'p',
          sessionId: 'source',
          artifactId: 'a',
          versionId: 'v'
        }
      }}
    />
  )
  expect(screen.getByText('Saved run recording')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open source record' }))
  expect(open).toHaveBeenCalledWith('p', 'source', 'user')
  open.mockRestore()
})

it('retains the original label when the source disappears instead of substituting another Session', () => {
  useSessionStore.setState({ sessions: [ordinary], selectedSessionId: 'ordinary' })
  render(<ReplaySourceBar item={item} />)
  expect(screen.getByText('Source: Study')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Open source record' })).toHaveProperty(
    'disabled',
    true
  )
})

it('does not offer a source navigation that its archived project cannot accept', () => {
  useProjectStore.setState({
    projects: useProjectStore.getState().projects.map((project) => ({ ...project, archivedAt: 1 }))
  })
  render(<ReplaySourceBar item={item} />)
  expect(screen.getByRole('button', { name: 'Open source record' })).toHaveProperty(
    'disabled',
    true
  )
})
