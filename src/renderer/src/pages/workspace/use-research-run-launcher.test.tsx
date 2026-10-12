// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  ResearchRunInspection,
  ResearchRunPlan
} from '../../../../shared/research-run-launcher'
import { createI18nTestStub, translateForTest } from '../../../../../test/i18n-test-stub'
import { useNavigationStore } from '@/stores/navigation-store'
import type { ChatSession } from '@/stores/session-store'
import type { WorkspaceConversationController } from './workspace-conversation-controller'
import type { ResearchRunLauncherProps } from './ResearchRunLauncher'
import type { useResearchRunObserver } from './use-research-run-observer'
import { useResearchRunLauncher } from './use-research-run-launcher'

const observed = vi.hoisted(() => ({
  launcher: undefined as ResearchRunLauncherProps | undefined,
  request: undefined as ReturnType<typeof useResearchRunObserver>['request'],
  begin: vi.fn(),
  bind: vi.fn(),
  settle: vi.fn(),
  reject: vi.fn(),
  open: vi.fn(),
  retry: vi.fn()
}))
vi.mock('react-i18next', () => createI18nTestStub())
vi.mock('@/i18n', () => ({ i18next: { t: translateForTest } }))
vi.mock('./ResearchRunLauncher', () => ({
  ResearchRunLauncher: (props: ResearchRunLauncherProps) => {
    observed.launcher = props
    return null
  },
  ResearchRunStatus: () => null
}))
vi.mock('./use-research-run-observer', () => ({ useResearchRunObserver: () => observed }))
const source = {
  sourceProjectId: 'project',
  sourceSessionId: 'source',
  sourceImportId: 'import',
  sourceTitle: 'Research'
}
const plan: ResearchRunPlan = {
  key: 'offline',
  title: 'Offline engineering',
  scope: 'engineering-check',
  claim: 'Bounded checks',
  limitations: ['No private data'],
  materialKeys: ['source'],
  materials: [{ key: 'source', status: 'available', versionIds: ['exact-source-version'] }],
  materialReady: true,
  compatibleRuntimeIds: ['node-22'],
  entrypoints: [{ materialKey: 'source', path: 'run.mjs' }],
  requirements: { node: '22', platforms: ['darwin'] },
  requiresSecrets: false
}
const ready: ResearchRunInspection = {
  source: {
    projectId: 'project',
    sessionId: 'source',
    importId: 'import',
    identity: 'exact-source-identity'
  },
  status: 'ready',
  descriptorCandidates: [],
  descriptor: {
    versionId: 'description',
    filename: 'research.json',
    sha256: 'a'.repeat(64),
    sizeBytes: 3
  },
  plans: [plan],
  runtimes: [
    { runtimeId: 'node-22', kind: 'node', version: '22.12.0', platform: 'darwin', arch: 'arm64' }
  ],
  diagnostics: { nativeServiceSupported: true, issues: [] }
}
type Options = Parameters<typeof useResearchRunLauncher>[0]
type Intent = Parameters<WorkspaceConversationController['actions']['submit']['researchRun']>[0]
const inspect = vi.fn()
const submit = vi.fn<(intent: Intent) => Promise<void>>()
const originalApi = window.api
const conversation = (): WorkspaceConversationController =>
  ({
    availability: { researchRun: true },
    actions: { submit: { researchRun: submit } }
  }) as unknown as WorkspaceConversationController
const options = (overrides: Partial<Options> = {}): Options => ({
  source,
  currentDraftKey: 'source-draft',
  conversation: conversation(),
  ...overrides
})
const session = (id: string): ChatSession => ({
  id,
  projectId: 'project',
  title: 'Current discussion',
  cwd: '/project',
  messages: [],
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  researchMembership: source
})
const Harness = (props: Options): React.ReactNode => useResearchRunLauncher(props)
const launch = (): Promise<void> => observed.launcher!.onStart({ inspection: ready, plan })
const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.clearAllMocks()
  observed.launcher = undefined
  observed.request = undefined
  inspect.mockResolvedValue(structuredClone(ready))
  submit.mockResolvedValue(undefined)
  window.api = { ...originalApi, researchRuns: { inspect } } as never
  useNavigationStore.setState({ explicitNavigationRevision: 0 })
})
afterEach(() => {
  cleanup()
  window.api = originalApi
})

it('exposes the reviewed destination without eagerly inspecting or submitting', () => {
  const view = render(<Harness {...options()} />)
  expect(observed.launcher?.destination).toEqual({ kind: 'new-discussion' })
  expect(inspect).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  view.rerender(<Harness {...options({ activeSession: session('discussion') })} />)
  expect(observed.launcher?.destination).toEqual({
    kind: 'current-discussion',
    title: 'Current discussion'
  })
  expect(submit).not.toHaveBeenCalled()
})

it('rechecks the pinned description then sends the exact reviewed plan and binds admission callbacks', async () => {
  render(
    <Harness
      {...options({ activeSession: session('discussion'), currentDraftKey: 'discussion' })}
    />
  )
  await act(async () => launch())
  expect(inspect).toHaveBeenCalledExactlyOnceWith({
    projectId: 'project',
    sourceSessionId: 'source',
    sourceImportId: 'import',
    descriptorVersionId: 'description',
    expectedSourceIdentity: 'exact-source-identity'
  })
  expect(submit).toHaveBeenCalledOnce()
  const intent = submit.mock.calls[0][0]
  expect(intent.source).toEqual(source)
  expect(intent.text).toContain('Run the selected research plan: Offline engineering.')
  const payload = JSON.parse(intent.text.split('```json\n')[1].split('\n```')[0])
  expect(payload).toEqual({
    requestId: intent.requestId,
    sourceSessionId: 'source',
    sourceImportId: 'import',
    sourceIdentity: 'exact-source-identity',
    descriptorVersionId: 'description',
    descriptorSha256: 'a'.repeat(64),
    planKey: 'offline',
    scope: 'engineering-check',
    materialKeys: ['source'],
    materialVersions: { source: 'exact-source-version' },
    compatibleRuntimeIds: ['node-22']
  })
  expect(observed.begin).toHaveBeenCalledExactlyOnceWith(intent.requestId, source)
  intent.onMessageAppended({ sessionId: 'pending-discussion', messageId: 'prompt' })
  intent.onSettled({ sessionId: 'durable-discussion', messageId: 'prompt' })
  expect(observed.bind).toHaveBeenCalledExactlyOnceWith(intent.requestId, {
    sessionId: 'pending-discussion',
    messageId: 'prompt'
  })
  expect(observed.settle).toHaveBeenCalledExactlyOnceWith(intent.requestId, {
    sessionId: 'durable-discussion',
    messageId: 'prompt'
  })
  intent.onRejected()
  expect(observed.reject).toHaveBeenCalledExactlyOnceWith(intent.requestId)
})

it.each(['source', 'destination', 'draft', 'navigation'] as const)(
  'never dispatches if %s changes while checking',
  async (change) => {
    const pending = deferred<ResearchRunInspection>()
    inspect.mockReturnValue(pending.promise)
    const original = options({
      activeSession: session('discussion'),
      currentDraftKey: 'discussion'
    })
    const view = render(<Harness {...original} />)
    let result!: Promise<unknown>
    act(() => {
      result = launch().catch((error: unknown) => error)
    })
    if (change === 'navigation') useNavigationStore.setState({ explicitNavigationRevision: 1 })
    else
      view.rerender(
        <Harness
          {...original}
          {...(change === 'source'
            ? { source: { ...source, sourceImportId: 'replacement-import' } }
            : change === 'destination'
              ? { activeSession: session('other-discussion') }
              : { currentDraftKey: 'other-draft' })}
        />
      )
    await act(async () => pending.resolve(ready))
    expect(await result).toEqual(new Error('The research or destination changed. Open Run again.'))
    expect(submit).not.toHaveBeenCalled()
    expect(observed.begin).not.toHaveBeenCalled()
  }
)

it.each([
  { materialReady: false, materials: [{ key: 'source', status: 'missing' as const }] },
  {
    materials: [{ key: 'source', status: 'available' as const, versionIds: ['different-version'] }]
  },
  { compatibleRuntimeIds: [] }
])('rejects a plan whose material identity or eligibility changed: %j', async (patch) => {
  inspect.mockResolvedValue({ ...ready, plans: [{ ...plan, ...patch }] })
  render(<Harness {...options()} />)
  await expect(launch()).rejects.toThrow('The selected plan is no longer ready. Open Run again.')
  expect(submit).not.toHaveBeenCalled()
  expect(observed.begin).not.toHaveBeenCalled()
})

it('allows compatible runtime discovery to refresh without changing the selected materials', async () => {
  inspect.mockResolvedValue({
    ...ready,
    plans: [{ ...plan, compatibleRuntimeIds: ['refreshed-node'] }],
    runtimes: [{ ...ready.runtimes[0], runtimeId: 'refreshed-node' }]
  })
  render(<Harness {...options()} />)
  await act(async () => launch())
  expect(submit.mock.calls[0][0].text).toContain('refreshed-node')
})

it('deduplicates a pending request and does not begin on inspection failure', async () => {
  const pending = deferred<ResearchRunInspection>()
  inspect.mockReturnValue(pending.promise)
  render(<Harness {...options()} />)
  const first = launch()
  await expect(launch()).rejects.toThrow('This discussion cannot start a run yet.')
  expect(inspect).toHaveBeenCalledOnce()
  await act(async () => pending.resolve(ready))
  await first
  expect(submit).toHaveBeenCalledOnce()
  inspect.mockRejectedValueOnce(new Error('Source unavailable'))
  await expect(launch()).rejects.toThrow('Could not inspect this research. Please retry.')
  expect(submit).toHaveBeenCalledOnce()
  expect(observed.begin).toHaveBeenCalledOnce()
})

it('rejects the observer request if normal conversation admission fails', async () => {
  submit.mockRejectedValue(new Error('Admission failed'))
  render(<Harness {...options()} />)
  await expect(launch()).rejects.toThrow('Admission failed')
  expect(observed.reject).toHaveBeenCalledExactlyOnceWith(submit.mock.calls[0][0].requestId)
})

it('passes busy and unavailable Agent reasons to the inspectable launcher', () => {
  const unavailable = conversation()
  unavailable.availability.researchRun = false
  render(<Harness {...options({ conversation: unavailable })} />)
  expect(observed.launcher?.blockedReason).toBe(
    'This discussion cannot start a run yet. Finish the current task or check the Agent configuration.'
  )
  expect(inspect).not.toHaveBeenCalled()
})
