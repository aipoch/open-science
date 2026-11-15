import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ScheduleRunStatus } from '@/pages/workspace/schedules/ScheduleRunStatus'
import { ScheduleRunPanel } from '@/pages/workspace/schedules/ScheduleRunPanel'
import { ResizablePanelGroup } from '@/components/ui/resizable'
import { WorkspaceSidebar } from '@/pages/workspace/WorkspaceSidebar'
import {
  ScheduleCardsProvider,
  SessionScheduleBanner,
  ScheduleMessageCards
} from '@/pages/workspace/schedules/ScheduleMessageCard'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import type {
  ScheduleCreateRequest,
  ScheduleEditRequest,
  ScheduleDeleteRequest,
  ScheduleView,
  ScheduleRun
} from '../../../src/shared/session-schedules'
import { nextScheduleTime } from '../../../src/shared/schedule-time'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSearchMessageFocusStore } from '@/stores/search-message-focus-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage
} from '../../../src/shared/conversation-graph'
const zh = new URLSearchParams(location.search).has('zh')
const timelinePreview = new URLSearchParams(location.search).has('timeline')
const bannerPreview = new URLSearchParams(location.search).has('banner')
const noSession = new URLSearchParams(location.search).has('no-session')
const independent = new URLSearchParams(location.search).has('independent')
const runResults = new URLSearchParams(location.search).has('run-results')
const resultAt = Date.UTC(2026, 10, 15, 3, 26)
const target = {
  projectId: 'research',
  sessionId: 'training',
  agentFrameId: 'root-frame-training',
  messageBranchId: 'message-branch-training'
}
const failedAt = Date.UTC(2026, 10, 14, 2)
const failedMessage = new URLSearchParams(location.search).has('failed-message')
const committedFailure = new URLSearchParams(location.search).has('committed-failure')
const failedScript = new URLSearchParams(location.search).has('failed')
const scriptResult = new URLSearchParams(location.search).has('script')
const graph = createLinearConversationGraph({
  sessionId: target.sessionId,
  messages: [
    {
      id: 'message',
      role: 'user',
      content: 'Check progress',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    ...(committedFailure
      ? [
          {
            id: 'failed-wake',
            role: 'user' as const,
            content: 'Wake for scheduled check',
            status: 'complete' as const,
            eventIds: [],
            createdAt: 2,
            updatedAt: 2,
            attribution: {
              kind: 'application' as const,
              feature: 'schedule' as const,
              purpose: 'scheduled-wake' as const,
              scheduleId: 'check',
              occurrenceId: 'failed-occurrence',
              scheduledAt: failedAt
            }
          }
        ]
      : [])
  ],
  createdAt: 1,
  updatedAt: 1
})
const session = {
  id: target.sessionId,
  projectId: target.projectId,
  title: zh ? '模型训练' : 'Model training',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  cwd: '/workspace',
  conversationGraph:
    scriptResult || committedFailure
      ? forkEditedConversationMessage(graph, 'message', 'revised', 2)
      : graph
} as ChatSession

const waiting = new URLSearchParams(location.search).has('waiting')
if (waiting) {
  session.status = 'waiting-permission'
  session.activeRun = { promptMessageId: 'message', startedAt: 1 }
  graph.messages[0].attribution = {
    kind: 'application',
    feature: 'schedule',
    purpose: 'scheduled-wake',
    scheduleId: 'check',
    occurrenceId: 'run',
    scheduledAt: 123
  }
  window.addEventListener('schedule-test-status', (event) => {
    const detail = (event as CustomEvent).detail as {
      status: ChatSession['status']
      promptId: string
    }
    useSessionStore.setState({
      sessions: [
        {
          ...session,
          status: detail.status,
          activeRun: { promptMessageId: detail.promptId, startedAt: 1 }
        }
      ]
    })
  })
}
if (runResults) {
  graph.messages[0].attribution = {
    kind: 'application',
    feature: 'schedule',
    purpose: 'scheduled-wake',
    scheduleId: 'check',
    occurrenceId: 'result',
    scheduledAt: resultAt
  }
  graph.messages.push({
    id: 'reply',
    agentFrameId: target.agentFrameId,
    introducedOnBranchId: target.messageBranchId,
    parentMessageId: 'message',
    role: 'agent',
    responseToMessageId: 'message',
    content: '## Training complete\n\n**Accuracy improved** to 94%.',
    status: 'complete',
    eventIds: [],
    createdAt: 2,
    updatedAt: 2
  })
}
useProjectStore.setState({
  projects: [
    {
      id: target.projectId,
      name: 'Training research',
      description: '',
      isExample: false,
      createdAt: 1,
      updatedAt: 1
    }
  ]
})
const extraSessions: ChatSession[] = new URLSearchParams(location.search).has('many-sessions')
  ? Array.from({ length: 35 }, (_, index) => ({
      ...session,
      id: `experiment-${index + 1}`,
      title: `Experiment ${index + 1}`,
      number: index + 1,
      updatedAt: 100 - index,
      contentLoaded: false,
      conversationGraph: undefined
    }))
  : []
useSessionStore.setState({
  sessions: noSession ? [] : [session, ...extraSessions],
  selectedSessionId: noSession ? undefined : session.id
})
const tasks: ScheduleView[] = [
  {
    id: 'check',
    target,
    originPromptId: 'message',
    draft: {
      name: zh ? '检查训练进度' : 'Check training progress',
      rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Ho_Chi_Minh' },
      action: {
        kind: 'send_session_message',
        message: zh
          ? '检查训练作业的进度。完成后汇总结果并关闭此任务。'
          : 'Check the training job. Report the results and close this schedule when it finishes.'
      }
    },
    revision: 1,
    nextDueAt: Date.UTC(2026, 10, 10, 2),
    finishedAt: null,
    pausedAt: null,
    pauseReason: null
  }
]
if (independent)
  tasks[0].target = {
    projectId: target.projectId,
    sessionId: null,
    agentFrameId: null,
    messageBranchId: null
  }
if (scriptResult)
  tasks.push({
    ...tasks[0],
    id: 'script',
    latestProblem: { status: 'skipped', reason: 'expired', scheduledAt: 3, scriptRunId: null },
    originPromptId: null,
    draft: {
      ...tasks[0].draft,
      name: 'Training script',
      action: { kind: 'run_script', language: 'shell', code: 'echo 42' }
    }
  })
if (failedScript) {
  const task = tasks[0]
  task.draft.action = { kind: 'run_script', language: 'python', code: 'import missing_dependency' }
  task.pausedAt = 123
  task.pauseReason = 'failed'
  task.latestProblem = { status: 'failed', reason: 'failed', scriptRunId: 'failed-run' }
}
if (failedMessage || committedFailure) {
  tasks[0].pausedAt = 123
  tasks[0].pauseReason = committedFailure ? 'failed' : 'dispatch_failed'
  tasks[0].latestProblem = { status: 'failed', reason: tasks[0].pauseReason, scheduledAt: failedAt }
}
if (new URLSearchParams(location.search).has('pending')) {
  tasks[0].nextDueAt = null
  tasks[0].draft.rule = { kind: 'once', at: Date.UTC(2026, 10, 10, 2), timeZone: 'UTC' }
  tasks[0].currentRun = {
    status: 'dispatching',
    scheduledAt: 123,
    reason: null,
    runSessionId: null,
    scriptRunId: null
  }
}
if (new URLSearchParams(location.search).has('completed-schedule')) {
  tasks[0].finishedAt = Date.now()
  tasks[0].finishReason = 'completed'
  tasks[0].nextDueAt = null
}
if (new URLSearchParams(location.search).has('closed-schedule')) {
  tasks[0].finishedAt = Date.now()
  tasks[0].nextDueAt = null
}
if (new URLSearchParams(location.search).has('final-dated-run')) {
  tasks[0].nextDueAt = null
  tasks[0].draft.endAt = Date.UTC(2026, 10, 14, 2, 30)
  tasks[0].currentRun = {
    status: 'dispatching',
    scheduledAt: Date.UTC(2026, 10, 14, 2),
    reason: null,
    runSessionId: null,
    scriptRunId: null
  }
}
if (new URLSearchParams(location.search).has('final-run')) {
  tasks[0].draft.maxRuns = 1
  tasks[0].currentRun = {
    status: 'admitted',
    scheduledAt: 123,
    reason: null,
    runSessionId: null,
    scriptRunId: null
  }
}
window.addEventListener('schedule-test-edit', () => {
  tasks[0].revision++
  tasks[0].draft = {
    ...tasks[0].draft,
    rule: { kind: 'daily', time: '10:30', timeZone: 'Asia/Ho_Chi_Minh' }
  }
  changed.forEach((fn) => fn(target))
})
const changed = new Set<(e: typeof target) => void>()
Object.defineProperty(window, 'api', {
  value: {
    platform: 'darwin',
    sessions: {
      loadOne: async ({ sessionId }: { sessionId: string }) => {
        const summary = extraSessions.find((item) => item.id === sessionId)
        if (!summary) return session
        return {
          ...summary,
          contentLoaded: true,
          conversationGraph: createLinearConversationGraph({
            sessionId,
            messages: [],
            createdAt: 1,
            updatedAt: 1
          })
        }
      }
    },
    notebook: {
      getReference: async () => ({
        ...target,
        workspaceCwd: session.cwd,
        notebookSessionRoot: '/notebook',
        runJsonPath: '/notebook/run.json',
        dataRoot: '/notebook/data',
        runtimeRoot: '/notebook/runtime'
      })
    },
    schedules: {
      history: async ({ scheduleId }: { scheduleId: string }) =>
        runResults
          ? (
              ['succeeded', 'admitted', 'dispatching', 'failed', 'interrupted', 'skipped'] as const
            ).map((status, index): ScheduleRun => ({
              scheduledAt: resultAt - index * 86400000,
              status,
              reason: null,
              scriptRunId: null,
              runSessionId: session.id
            }))
          : failedMessage || committedFailure
            ? [
                {
                  scheduledAt: failedAt,
                  status: 'failed',
                  reason: tasks[0].pauseReason,
                  scriptRunId: null,
                  runSessionId: null,
                  promptMessageId: committedFailure ? 'failed-wake' : null
                }
              ]
            : failedScript
              ? [{ scheduledAt: 1, status: 'failed', reason: 'failed', scriptRunId: 'failed-run' }]
              : scheduleId === 'script'
                ? [
                    {
                      scheduledAt: 3,
                      status: 'skipped',
                      reason: 'Session was busy',
                      scriptRunId: null
                    },
                    {
                      scheduledAt: 2,
                      status: 'succeeded',
                      reason: null,
                      scriptRunId: 'previous-run'
                    }
                  ]
                : [],
      list: async () =>
        structuredClone(
          tasks.map((task) => ({
            ...task,
            draft: {
              ...task.draft,
              action:
                task.draft.action.kind === 'run_script'
                  ? { kind: 'run_script', language: task.draft.action.language }
                  : { kind: 'send_session_message' }
            }
          }))
        ),
      get: async ({ scheduleId }: { scheduleId: string }) =>
        structuredClone(tasks.find((task) => task.id === scheduleId) ?? null),
      onChanged: (fn: (e: typeof target) => void) => {
        changed.add(fn)
        return () => changed.delete(fn)
      },
      create: async (req: ScheduleCreateRequest) => {
        const item = {
          ...tasks[0],
          id: crypto.randomUUID(),
          target: req.target,
          draft: req.draft,
          originPromptId: null,
          pausedAt: null,
          finishedAt: null,
          finishReason: null,
          pauseReason: null,
          nextDueAt: nextScheduleTime(req.draft.rule, Date.now())
        }
        tasks.push(item)
        changed.forEach((fn) => fn(target))
        return item
      },
      delete: async (req: ScheduleDeleteRequest) => {
        const index = tasks.findIndex((task) => task.id === req.scheduleId)
        if (index !== -1) tasks.splice(index, 1)
        changed.forEach((fn) => fn(target))
      },
      edit: async (req: ScheduleEditRequest) => {
        if (new URLSearchParams(location.search).has('request-error'))
          throw new Error('SQLITE_BUSY: /private/research/database.sqlite')
        const row = tasks.find((x) => x.id === req.scheduleId)!
        if (req.expectedRevision !== row.revision)
          throw new Error('The schedule changed. Reopen it before editing.')
        if (req.change.kind === 'edit') row.draft = req.change.draft
        else if (req.change.kind === 'pause') row.pausedAt = Date.now()
        else if (req.change.kind === 'resume') row.pausedAt = null
        else {
          row.finishedAt = Date.now()
          row.finishReason = 'cancelled'
        }
        row.revision++
        changed.forEach((fn) => fn(target))
        return row
      }
    }
  }
})
useNavigationStore.setState({ view: 'workspace', activeProjectId: target.projectId })
const initialTask = structuredClone(tasks[0])
const noop = (): void => {}
export function Fixture(): React.JSX.Element {
  const [laterReply, setLaterReply] = useState(false)
  const scope = useNavigationStore((state) => state.scheduleScope)
  const show = scope?.projectId === target.projectId
  const setShow = (open: boolean): void => {
    const nav = useNavigationStore.getState()
    if (open) nav.openSchedule(target.projectId)
    else nav.closeSchedule()
  }
  const focus = useSearchMessageFocusStore((s) => s.pending?.messageId)
  const branch = useSessionStore((s) => s.sessions[0]?.conversationGraph?.frames[0].activeBranchId)
  const preview = usePreviewWorkbenchStore((s) =>
    s.items.find((item) => item.id === s.activeItemId)
  )
  if (independent)
    return (
      <TooltipProvider>
        <ResizablePanelGroup className="h-screen bg-bg-000">
          <ScheduleRunPanel task={tasks[0]} onOpenSession={noop} />
        </ResizablePanelGroup>
      </TooltipProvider>
    )
  return (
    <TooltipProvider>
      <div className="flex h-screen bg-bg-000">
        <aside className="w-60 shrink-0 bg-bg-100">
          <WorkspaceSidebar
            projectName={zh ? '训练研究' : 'Training research'}
            sessions={[session]}
            activeSessionId={session.id}
            canCreateConversation
            canMutateConversations
            canDeleteConversations
            importProjectId={target.projectId}
            onOpenSchedule={() => setShow(!show)}
            isScheduleOpen={show}
            scheduleSessionId={scope?.sessionId}
            onOpenSession={() => setShow(false)}
            onNewConversation={noop}
            onGoHome={noop}
            isFilesOpen={false}
            onOpenFiles={noop}
            canDownloadArtifacts={false}
            onDownloadArtifacts={noop}
            onRenameSession={noop}
            onTogglePin={noop}
            onViewNotebook={noop}
            onDeleteSession={noop}
            onOpenSettings={noop}
            onOpenProjectSettings={noop}
            onNewProject={noop}
          />
        </aside>
        <main
          data-message-focus={focus}
          data-branch={branch}
          data-notebook-run={preview?.type === 'tool' ? preview.notebookRunId : undefined}
          className="min-w-0 flex-1"
        >
          <div className="mx-auto mt-12 max-w-2xl">
            {waiting && (
              <ScheduleRunStatus
                projectId={target.projectId}
                scheduleId="check"
                run={{
                  scheduledAt: 123,
                  status: 'admitted',
                  reason: null,
                  scriptRunId: null,
                  runSessionId: session.id
                }}
              />
            )}
            <div className="mb-6 flex items-center justify-between px-6">
              <h1 className="text-lg font-medium">{session.title}</h1>
            </div>
            <p className="mb-4 px-6">
              {zh ? '已设置每日训练进度检查。' : 'The daily training check is scheduled.'}
            </p>
            <ScheduleCardsProvider
              projectId={target.projectId}
              sessionId={session.id}
              activities={[
                {
                  id: 'created-task',
                  kind: 'tool',
                  title: 'Schedule a task',
                  providerToolName: 'mcp__open_science_schedule__create_schedule',
                  promptMessageId: 'message',
                  status: 'completed',
                  rawOutput: initialTask,
                  createdAt: 1,
                  updatedAt: 1,
                  eventIds: [],
                  sortIndex: 0
                }
              ]}
              messages={
                bannerPreview
                  ? [
                      {
                        id: 'later-prompt',
                        status: 'complete',
                        eventIds: [],
                        updatedAt: 1,
                        role: 'user',
                        content: 'Scheduled check',
                        createdAt: 1,
                        attribution: {
                          kind: 'application',
                          purpose: 'scheduled-wake',
                          occurrenceId: 'fixture-wake',
                          feature: 'schedule',
                          scheduleId: initialTask.id,
                          scheduledAt: 1
                        }
                      }
                    ]
                  : session.messages
              }
            >
              {!bannerPreview && <ScheduleMessageCards promptId="message" />}
              <section aria-label="Scheduled reply">
                <SessionScheduleBanner
                  promptId={bannerPreview ? 'later-prompt' : 'message'}
                  latest={!laterReply}
                />
              </section>
              {timelinePreview && (
                <>
                  <button className="mt-4 text-sm" onClick={() => setLaterReply(true)}>
                    Continue conversation
                  </button>
                  {laterReply && (
                    <section className="mt-8" aria-label="Later reply">
                      <p className="mb-3 text-sm">A new reply unrelated to the scheduled task.</p>
                      <SessionScheduleBanner promptId="new-prompt" latest />
                    </section>
                  )}
                </>
              )}
            </ScheduleCardsProvider>
          </div>
        </main>
      </div>
    </TooltipProvider>
  )
}
const locale = zh ? 'zh-Hans' : 'en'
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
