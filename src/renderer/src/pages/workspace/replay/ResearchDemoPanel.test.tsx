// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createI18nTestStub } from '../../../../../../test/i18n-test-stub'
import type {
  ResearchDemoInspection,
  ResearchDemoReceipt
} from '../../../../../shared/research-demo'
import { useSessionStore } from '@/stores/session-store'
import { useResearchDemoStore } from '@/stores/research-demo-store'
import { useRunObservationQuestionStore } from '@/stores/run-observation-question-store'
import type { RunObservationSelection } from '../../../../../shared/run-observation'
import { ResearchDemoPanel } from './ResearchDemoPanel'

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  start: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  stop: vi.fn(),
  carriers: vi.fn(),
  question: vi.fn(),
  viewer: vi.fn(),
  load: vi.fn()
}))
vi.mock('react-i18next', () => {
  const stub = createI18nTestStub()
  return { ...stub, useTranslation: () => ({ ...stub.useTranslation(), i18n: { language: 'en' } }) }
})
vi.mock('@/lib/session-persistence/session-persistence', () => ({
  loadPersistedSession: mocks.load
}))
vi.mock('./use-observation-question-recovery', () => ({
  useObservationQuestionRecovery: () => undefined
}))
vi.mock('../RunObservationPreview', () => ({
  RunObservationPreview: (props: unknown) => {
    mocks.viewer(props)
    return <div data-testid="demo-viewer" />
  }
}))
const source = { projectId: 'project', sourceSessionId: 'source', sourceImportId: 'import' }
const inspection: ResearchDemoInspection = {
  source: { ...source, identity: 'verified-identity' },
  candidates: [
    {
      demoVersionId: 'demo-version',
      title: 'Offline project',
      description: 'A bounded offline fixture',
      planKey: 'engineering',
      descriptorVersionId: 'description-version',
      status: 'ready',
      blockers: [],
      substitutions: ['Saved model responses']
    }
  ]
}
const receipt = (patch: Partial<ResearchDemoReceipt> = {}): ResearchDemoReceipt => ({
  source,
  requestId: 'request',
  demoVersionId: 'demo-version',
  title: 'Offline project',
  substitutions: ['Saved model responses'],
  purpose: 'offline-demo',
  state: 'running',
  sessionId: 'carrier',
  operationRequestId: 'operation-request',
  createdAt: 1,
  updatedAt: 2,
  runTarget: { projectId: 'project', sessionId: 'carrier', runId: 'exact-run' },
  ...patch
})
beforeEach(() => {
  vi.clearAllMocks()
  useSessionStore.setState({ sessions: [], selectedSessionId: 'discussion' })
  useResearchDemoStore.setState({ carriersByProject: {} })
  useRunObservationQuestionStore.setState({
    destination: undefined,
    pending: undefined,
    lastAdded: undefined
  })
  mocks.inspect.mockResolvedValue(inspection)
  mocks.list.mockResolvedValue({ receipts: [] })
  mocks.start.mockImplementation(async (request) => receipt({ requestId: request.requestId }))
  mocks.get.mockImplementation(async (request) => receipt({ requestId: request.requestId }))
  mocks.stop.mockResolvedValue(receipt({ state: 'cancelled' }))
  mocks.carriers.mockResolvedValue([{ source, sessionId: 'carrier' }])
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      researchDemos: {
        inspect: mocks.inspect,
        start: mocks.start,
        list: mocks.list,
        get: mocks.get,
        stop: mocks.stop,
        carriers: mocks.carriers,
        question: mocks.question
      }
    }
  })
})
afterEach(cleanup)

it('shows the inspected viewing policy before starting without launching a run', async () => {
  mocks.inspect.mockResolvedValue({
    ...inspection,
    candidates: inspection.candidates.map((candidate) => ({
      ...candidate,
      demoViewing: { mode: 'until-stop-or-timeout', timeoutMs: 600_000 }
    }))
  })
  render(<ResearchDemoPanel source={source} isActive />)
  expect(
    await screen.findByText('Maximum execution time: 10 min. The program may finish earlier.')
  ).toBeTruthy()
  expect(
    screen.getByText(
      'This run keeps the project page open after its actions finish. Stop the run when you are done viewing.'
    )
  ).toBeTruthy()
  expect(mocks.start).not.toHaveBeenCalled()
})

const selectedEvidence = (): RunObservationSelection => ({
  selectionId: 'selected-step',
  identity: { projectId: 'project', sessionId: 'carrier', runId: 'exact-run' },
  cursor: { epoch: 'epoch', sequence: 1 },
  stepId: 'step',
  selectedAt: 1,
  snapshot: {
    identity: { projectId: 'project', sessionId: 'carrier', runId: 'exact-run' },
    cursor: { epoch: 'epoch', sequence: 1 },
    stepId: 'step',
    observedAt: 1,
    phase: 'running',
    artifacts: [],
    artifactsTruncated: false,
    run: null
  }
})

it('asks about a live demo only after Main validates the selection and the current discussion', async () => {
  const destination = { projectId: 'project', sessionId: 'discussion', draftKey: 'discussion' }
  useRunObservationQuestionStore.setState({ destination })
  mocks.list.mockResolvedValue({ receipts: [receipt()] })
  mocks.question.mockResolvedValue({
    source,
    requestId: 'request',
    selection: selectedEvidence(),
    destination,
    purpose: 'offline-demo'
  })
  render(<ResearchDemoPanel source={source} isActive />)
  fireEvent.click(await screen.findByRole('button', { name: 'View demo' }))
  await act(async () =>
    mocks.viewer.mock.lastCall?.[0].onAskSelection(selectedEvidence(), 'viewer')
  )
  expect(mocks.question).toHaveBeenCalledWith({
    ...source,
    requestId: 'request',
    viewerId: 'viewer',
    selectionId: 'selected-step',
    destinationSessionId: 'discussion'
  })
  expect(useRunObservationQuestionStore.getState().pending).toMatchObject({
    destination,
    selection: { identity: { sessionId: 'carrier', runId: 'exact-run' } },
    demo: { purpose: 'offline-demo', source, requestId: 'request' }
  })
  expect(useSessionStore.getState().selectedSessionId).toBe('discussion')
})

it('does not deliver a validated live demo selection after its destination changes', async () => {
  const destination = { projectId: 'project', sessionId: 'discussion', draftKey: 'discussion' }
  useRunObservationQuestionStore.setState({ destination })
  mocks.list.mockResolvedValue({ receipts: [receipt()] })
  let resolve!: (value: unknown) => void
  mocks.question.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  render(<ResearchDemoPanel source={source} isActive />)
  fireEvent.click(await screen.findByRole('button', { name: 'View demo' }))
  const delivery = mocks.viewer.mock.lastCall?.[0].onAskSelection(selectedEvidence(), 'viewer')
  useRunObservationQuestionStore.setState({
    destination: { ...destination, sessionId: 'other', draftKey: 'other' }
  })
  resolve({
    source,
    requestId: 'request',
    selection: selectedEvidence(),
    destination,
    purpose: 'offline-demo'
  })
  await expect(delivery).rejects.toThrow('Could not reference this recorded step.')
  expect(useRunObservationQuestionStore.getState().pending).toBeUndefined()
})

it('inspects without running and shows the declared substitutions before explicit launch', async () => {
  render(<ResearchDemoPanel source={source} isActive />)
  expect(await screen.findByText('Saved model responses')).toBeTruthy()
  expect(mocks.inspect).toHaveBeenCalledWith(source)
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.viewer).not.toHaveBeenCalled()
  expect(useSessionStore.getState().selectedSessionId).toBe('discussion')
})

it('starts Main with a pinned artifact and opens its exact run without a model or conversation send', async () => {
  render(<ResearchDemoPanel source={source} isActive />)
  fireEvent.click(await screen.findByRole('button', { name: 'Start offline demo' }))
  await screen.findByTestId('demo-viewer')
  expect(mocks.start).toHaveBeenCalledOnce()
  expect(mocks.start.mock.calls[0][0]).toEqual({
    ...source,
    demoVersionId: 'demo-version',
    expectedSourceIdentity: 'verified-identity',
    requestId: expect.any(String)
  })
  expect(mocks.viewer.mock.lastCall?.[0]).toMatchObject({ target: receipt().runTarget })
  expect(useSessionStore.getState().selectedSessionId).toBe('discussion')
  expect(mocks.load).not.toHaveBeenCalled()
})

it('keeps old packages readable without guessing an entrypoint or creating a run', async () => {
  mocks.inspect.mockResolvedValue({ ...inspection, candidates: [] })
  render(<ResearchDemoPanel source={source} isActive />)
  expect(
    await screen.findByText(
      'No offline demo is included in this research. Existing recordings are still available.'
    )
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Start offline demo' })).toBeNull()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('blocks declarations that need secrets and never offers silent fallback', async () => {
  mocks.inspect.mockResolvedValue({
    ...inspection,
    candidates: [{ ...inspection.candidates[0], status: 'blocked', blockers: ['secrets-required'] }]
  })
  render(<ResearchDemoPanel source={source} isActive />)
  expect(
    await screen.findByText('An offline demo cannot require private credentials.')
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start offline demo' }).hasAttribute('disabled')).toBe(
    true
  )
  expect(mocks.start).not.toHaveBeenCalled()
})

it('restores history without auto-opening a previous project page', async () => {
  mocks.list.mockResolvedValue({ receipts: [receipt({ state: 'completed' })] })
  render(<ResearchDemoPanel source={source} isActive />)
  expect(await screen.findByRole('button', { name: 'View demo' })).toBeTruthy()
  expect(mocks.viewer).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('retries an uncertain start with the same request identity', async () => {
  mocks.start.mockRejectedValueOnce(new Error('Uncertain response'))
  render(<ResearchDemoPanel source={source} isActive />)
  fireEvent.click(await screen.findByRole('button', { name: 'Start offline demo' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  await screen.findByTestId('demo-viewer')
  expect(mocks.start).toHaveBeenCalledTimes(2)
  expect(mocks.start.mock.calls[0][0]).toEqual(mocks.start.mock.calls[1][0])
})

it('stops the selected exact operation and closing the panel never stops it', async () => {
  mocks.list.mockResolvedValue({ receipts: [receipt()] })
  const mounted = render(<ResearchDemoPanel source={source} isActive />)
  fireEvent.click(await screen.findByRole('button', { name: 'Stop demo' }))
  await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith({ ...source, requestId: 'request' }))
  mounted.unmount()
  expect(mocks.stop).toHaveBeenCalledOnce()
})

it('uses the recorded target after completion instead of reopening a live service', async () => {
  const recordingTarget = {
    projectId: 'project',
    sessionId: 'carrier',
    artifactId: 'recording',
    versionId: 'saved-version'
  }
  mocks.list.mockResolvedValue({ receipts: [receipt({ state: 'completed', recordingTarget })] })
  render(<ResearchDemoPanel source={source} isActive />)
  fireEvent.click(await screen.findByRole('button', { name: 'View demo' }))
  expect(mocks.viewer.mock.lastCall?.[0]).toMatchObject({
    mode: 'recorded',
    target: recordingTarget
  })
  expect(mocks.start).not.toHaveBeenCalled()
})

it('ignores a late start response after navigating away', async () => {
  let finish!: (value: ResearchDemoReceipt) => void
  mocks.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const mounted = render(<ResearchDemoPanel source={source} isActive />)
  fireEvent.click(await screen.findByRole('button', { name: 'Start offline demo' }))
  const requestId = mocks.start.mock.calls[0][0].requestId
  mounted.unmount()
  await act(async () => finish(receipt({ requestId })))
  expect(mocks.viewer).not.toHaveBeenCalled()
  expect(useSessionStore.getState().selectedSessionId).toBe('discussion')
})
