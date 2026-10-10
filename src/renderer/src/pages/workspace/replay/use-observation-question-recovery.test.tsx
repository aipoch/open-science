// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import { useRunObservationQuestionStore } from '@/stores/run-observation-question-store'
import type { RecordedRunObservationSelection } from '../../../../../shared/run-observation-recorded'
import { researchDraftKey } from '../research-draft-identity'
import * as navigation from '../workspace-discussion-navigation'
import { useObservationQuestionRecovery } from './use-observation-question-recovery'
const source: ChatSession = {
  id: 'source',
  projectId: 'project',
  title: 'Research',
  cwd: '',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  packageOrigin: {
    importId: 'import',
    sourceProjectId: 'author',
    sourceSessionId: 'author-session',
    importedAt: 1,
    manifestChecksum: 'a'.repeat(64)
  }
}
const selection = (): RecordedRunObservationSelection => ({
  kind: 'recorded-run-observation',
  selectionId: 'selected-step',
  receiving: { projectId: 'project', sessionId: 'source', artifactId: 'archive', versionId: 'v1' },
  recordingId: 'recording',
  stepKey: 'step',
  mediaKeys: [],
  record: {
    stepKey: 'step',
    observedAt: 500,
    phase: 'completed',
    sourceEvidence: {
      identity: { projectId: 'author', sessionId: 'author-session', runId: 'run' },
      cursor: { epoch: 'epoch', sequence: 1 },
      stepId: 'step'
    },
    run: null,
    artifactEvidence: [],
    artifactsTruncated: false
  }
})
afterEach(() => {
  cleanup()
  useSessionStore.setState({ sessions: [] })
  useRunObservationQuestionStore.setState({
    destination: undefined,
    pending: undefined,
    lastAdded: undefined
  })
  useResearchWorkspaceStore.setState({ draftResearchByProject: {} })
  vi.restoreAllMocks()
})
it('uses the existing Discuss navigation only on an explicit recovery action', async () => {
  useSessionStore.setState({ sessions: [source] })
  const discuss = vi.spyOn(navigation, 'openResearchWorkspace').mockResolvedValue(true)
  const { result } = renderHook(() =>
    useObservationQuestionRecovery({ projectId: 'project', sessionId: 'source' })
  )
  expect(result.current?.label).toBe('Discuss')
  expect(discuss).not.toHaveBeenCalled()
  await result.current!.onClick(selection())
  expect(discuss).toHaveBeenCalledExactlyOnceWith(
    {
      sourceProjectId: 'project',
      sourceSessionId: 'source',
      sourceImportId: 'import',
      sourceTitle: 'Research'
    },
    { preservePreview: true, signal: undefined, afterNavigate: expect.any(Function) }
  )
  expect(useRunObservationQuestionStore.getState().pending).toBeUndefined()
})
it('keeps ordinary Sessions on existing navigation and does not expose a foreign source', () => {
  useSessionStore.setState({ sessions: [{ ...source, packageOrigin: undefined }] })
  const navigate = vi.spyOn(useNavigationStore.getState(), 'openSession').mockReturnValue(true)
  const { result, rerender } = renderHook(
    ({ projectId }) => useObservationQuestionRecovery({ projectId, sessionId: 'source' }),
    { initialProps: { projectId: 'project' } }
  )
  expect(result.current?.label).toBe('Open source Session')
  result.current!.onClick(selection())
  expect(navigate).toHaveBeenCalledExactlyOnceWith(
    'project',
    'source',
    'user',
    expect.any(Function)
  )
  rerender({ projectId: 'other' })
  expect(result.current).toBeUndefined()
})

it('stages the selected archive into the inline draft while the original record remains selected', async () => {
  useSessionStore.setState({ sessions: [source], selectedSessionId: 'source' })
  const discuss = vi.spyOn(navigation, 'openResearchWorkspace').mockResolvedValue(true)
  const { result } = renderHook(() =>
    useObservationQuestionRecovery({ projectId: 'project', sessionId: 'source' })
  )
  const abort = new AbortController()
  await result.current!.onClick(selection(), abort.signal)
  expect(useRunObservationQuestionStore.getState().pending).toBeUndefined()
  const [membership, options] = discuss.mock.calls[0]
  act(() => {
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project' })
    useSessionStore.getState().selectSession('source')
    useResearchWorkspaceStore.getState().openDraft(membership)
    options!.afterNavigate!({ projectId: 'project', draftKey: researchDraftKey(membership) })
  })
  const pending = useRunObservationQuestionStore.getState().pending
  expect(pending?.selection).toEqual(selection())
  expect(pending?.destination.sessionId).toBeUndefined()
  expect(pending?.isCurrent?.()).toBe(true)
  abort.abort()
  expect(pending?.isCurrent?.()).toBe(false)
})

it('invalidates admitted evidence when another navigation supersedes it', async () => {
  useSessionStore.setState({ sessions: [{ ...source, packageOrigin: undefined }] })
  vi.spyOn(useNavigationStore.getState(), 'openSession').mockImplementation(
    (projectId, sessionId, _origin, afterNavigate) => {
      useNavigationStore.setState({ view: 'workspace', activeProjectId: projectId })
      useSessionStore.getState().selectSession(sessionId)
      afterNavigate?.()
      return true
    }
  )
  const { result } = renderHook(() =>
    useObservationQuestionRecovery({ projectId: 'project', sessionId: 'source' })
  )
  await act(async () => result.current!.onClick(selection()))
  const pending = useRunObservationQuestionStore.getState().pending
  expect(pending?.isCurrent?.()).toBe(true)
  act(() => useNavigationStore.getState().recordUserNavigation())
  expect(pending?.isCurrent?.()).toBe(false)
})
