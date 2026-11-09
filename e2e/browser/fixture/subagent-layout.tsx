import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { WorkspaceAgentRuntimeProvider } from '@/lib/acp/useWorkspaceAgentRuntime'
import { SubagentPreview, SubagentsBar } from '@/pages/workspace/SubagentReleaseSurfaces'
import { useSessionStore } from '@/stores/session-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import type { ChatSession } from '@/stores/session-store-contract'

const params = new URLSearchParams(location.search)
const locale = params.has('de') ? 'de' : 'en'
document.documentElement.classList.toggle('dark', params.has('dark'))
const unsubscribe = (): (() => void) => () => undefined
// Stub native transport only; projections, selectors, transcript and CSS are production code.
window.api = {
  platform: 'darwin',
  acp: {
    getState: async () => ({
      status: 'idle',
      cwd: '',
      sessionIds: [],
      events: [],
      pendingPermissions: [],
      pendingElicitations: [],
      permissionProfiles: {},
      permissionGrants: {},
      contextUsageBySession: {},
      promptInFlight: false,
      agentPromptInFlightSessionIds: [],
      promptInFlightSessionIds: []
    }),
    onState: unsubscribe,
    onEvent: unsubscribe,
    onAgentRuntimeUpdate: unsubscribe
  },
  reviewer: { getForSession: async () => [] },
  compute: { listJobs: async () => [] },
  localFs: { listGrantedRoots: async () => [] }
} as unknown as typeof window.api

const statuses = ['running', 'completed', 'awaiting_user', 'cancelled', 'error'] as const
const names = [
  'PySin',
  'PyCos',
  'Review the full statistical analysis and all sensitivity checks',
  'RSin',
  'RCos'
]
const session: ChatSession = {
  id: 'layout',
  projectId: 'project',
  title: 'Delegated analysis',
  cwd: '/fixture',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 2,
  conversationGraph: {
    schemaVersion: 1,
    rootFrameId: 'root',
    activeFrameId: 'root',
    frames: [
      {
        id: 'root',
        kind: 'root',
        originBindingState: 'root',
        status: 'completed',
        activeBranchId: 'root-branch',
        createdAt: 1
      },
      ...statuses.map((status, index) => ({
        id: `child-${index}`,
        kind: 'delegate' as const,
        parentFrameId: 'root',
        originMessageId: 'prompt',
        originBindingState: 'validated' as const,
        delegateName: names[index],
        agentName: 'Main Agent',
        status: status === 'awaiting_user' ? 'running' : status,
        activeBranchId: `branch-${index}`,
        createdAt: index + 2
      }))
    ],
    branches: [
      {
        id: 'root-branch',
        agentFrameId: 'root',
        headMessageId: 'prompt',
        createdAt: 1,
        updatedAt: 1
      },
      ...statuses.map((_, index) => ({
        id: `branch-${index}`,
        agentFrameId: `child-${index}`,
        headMessageId: `result-${index}`,
        createdAt: 1,
        updatedAt: 2
      }))
    ],
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Compare the analyses.',
        status: 'complete',
        eventIds: [],
        agentFrameId: 'root',
        introducedOnBranchId: 'root-branch',
        createdAt: 1,
        updatedAt: 1
      },
      ...statuses.map((_, index) => ({
        id: `result-${index}`,
        role: 'agent' as const,
        content: 'Analysis results are available for review.',
        status: 'complete' as const,
        eventIds: [],
        agentFrameId: `child-${index}`,
        introducedOnBranchId: `branch-${index}`,
        createdAt: 1,
        updatedAt: 2
      }))
    ],
    activities: [],
    activityGroups: [],
    runtimeSegments: []
  },
  runtimeContext: {
    version: 1,
    revision: 1,
    delegatedWork: {
      questionRequests: [
        {
          requestId: 'question',
          canonicalDigest: 'fixture',
          sourceFrameId: 'child-2',
          sourceAttemptId: 'attempt-2',
          sourceRuntimeSegmentId: 'runtime-2',
          sourceMessageBranchId: 'branch-2',
          rootOriginMessageId: 'prompt',
          rootBranchId: 'root-branch',
          sourceName: names[2],
          questions: [],
          draftAnswers: [],
          draftQuestionIndex: 0,
          askedAt: 2,
          status: 'pending'
        }
      ],
      records: statuses.map((status, index) => ({
        agentFrameId: `child-${index}`,
        attempts: [
          {
            id: `attempt-${index}`,
            status: status === 'awaiting_user' ? 'running' : status,
            resolvedAgent: { kind: 'main' as const },
            runtimeSegmentIds: [],
            startedAt: 1,
            ...(status === 'completed' ? { endedAt: 2, terminalMessageId: `result-${index}` } : {})
          }
        ]
      }))
    }
  }
}
useSessionStore.setState({ sessions: [session] })
// Start with no preview: selecting a row in SubagentsBar creates and activates the item through
// openSubagentPreview. Fixture subscribes below so this exercises the real opening path.
usePreviewWorkbenchStore.getState().activateProject('project')

export function Fixture(): React.JSX.Element {
  const item = usePreviewWorkbenchStore((state) => state.items.find((item) => item.type === 'tool'))
  return (
    <WorkspaceAgentRuntimeProvider>
      <main className="mx-auto flex h-svh max-w-5xl flex-col gap-4 bg-bg-10 p-4 text-text-000">
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border-200">
          {item?.type === 'tool' ? <SubagentPreview item={item} /> : null}
        </div>
        <div
          data-testid="composer-strip"
          className="relative flex min-w-0 items-center rounded-xl bg-bg-200 px-2 py-2"
        >
          <SubagentsBar session={session} permissions={[]} />
          <span className="px-2 text-xs">Notebook</span>
        </div>
      </main>
    </WorkspaceAgentRuntimeProvider>
  )
}

void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
