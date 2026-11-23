import { scheduleToolDraft } from '../../../src/shared/session-schedules'
import { useTranslation } from 'react-i18next'
import { getRenderableActivityEntries } from '../../../src/renderer/src/pages/workspace/workspace-tool-activity-groups'
import '@/assets/main.css'
import { useState } from 'react'
import { WorkspaceToolDetailsRow } from '@/pages/workspace/WorkspaceToolDetailsRow'
import { buildToolActivityDetails } from '@/pages/workspace/workspace-tool-activity-details'
import { getToolExecutionPhase } from '@/pages/workspace/tool-execution-phase'
import type { ToolActivity } from '@/stores/session-store'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { PermissionApprovalControls } from '@/pages/workspace/PermissionApprovalControls'
import { ResizableBottomPanel } from '@/pages/workspace/ResizableBottomPanel'
import { useAcpRuntime } from '@/lib/acp/useAcpRuntime'
import type {
  AcpPermissionRequest,
  AcpStateSnapshot,
  AcpStateUpdate
} from '../../../src/shared/acp'

const language = new URLSearchParams(location.search).get('lang') === 'zh-Hans' ? 'zh-Hans' : 'en'
document.documentElement.classList.toggle(
  'dark',
  !new URLSearchParams(location.search).has('light')
)
window.api = { platform: 'win32' } as typeof window.api

const search = new URLSearchParams(location.search).has('search')
const request: AcpPermissionRequest = {
  requestId: search ? 'web-search' : 'web-read',
  sessionId: 'parent',
  toolCallId: 'child',
  title: search
    ? 'p63 squamous cell carcinoma tumor suppressor oncogene role'
    : 'https://www.resurchify.com/impact/details/20982',
  providerToolName: search ? 'WebSearch' : 'WebFetch',
  ...(search
    ? { rawInput: { query: 'p63 squamous cell carcinoma tumor suppressor oncogene role' } }
    : {}),
  toolKind: 'fetch',
  isMcp: false,
  delegated: {
    frameId: 'child',
    attemptId: 'attempt',
    childTitle: 'rct5-10-round2',
    riskScope: 'This session or this call'
  },
  options: [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
    { optionId: 'session', name: 'This session', kind: 'allow_always', scope: 'session' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ]
}
const powershell = new URLSearchParams(location.search).has('powershell')
const builtInSearch = new URLSearchParams(location.search).has('built-in-search')
const builtInSearchRequest: AcpPermissionRequest = {
  ...request,
  requestId: 'built-in-search',
  title: 'mcp__open_science_web__web_search',
  providerToolName: 'mcp__open_science_web__web_search',
  toolKind: 'search',
  isMcp: true,
  mcpIdentity: 'open-science-web/web_search',
  delegated: undefined,
  rawInput: {
    query: 'new foundation model release 2026',
    freshness: 'month',
    max_results: 10,
    ...(new URLSearchParams(location.search).has('sites')
      ? { allowed_domains: ['nature.com', 'science.org'] }
      : {})
  }
}
const risk = new URLSearchParams(location.search).has('risk')
const large = new URLSearchParams(location.search).has('large')
const riskPrefix = large
  ? '# context\n'.repeat(1500)
  : new URLSearchParams(location.search).has('long')
    ? '# context\n'.repeat(48)
    : ''
const riskRequest: AcpPermissionRequest = {
  requestId: 'code-risk',
  sessionId: 'parent',
  toolCallId: 'app-approval:code-risk',
  title: 'Review potentially destructive code',
  appOwned: true,
  rawInput: {
    code:
      riskPrefix +
      'import os\n\ntmp_dir = "/workspace/notebook/data"\na_path = os.path.join(tmp_dir, "a.txt")\n\n# Verify the file exists before deletion\nassert os.path.isfile(a_path)\n\nos.unlink(a_path)\nprint(os.listdir(tmp_dir))\n',
    notebookCodeRisk: {
      runId: 'internal-run-id',
      language: 'python',
      environment: 'default-python',
      cwd: '/workspace/open-science/.worktree/ledge-permission-analysis/.dev-isolate/storage/notebooks/example-session/data',
      risks: [
        {
          operation: 'os.unlink',
          source: 'os.unlink(a_path)',
          line: large ? 1509 : riskPrefix ? 57 : 9
        }
      ]
    }
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ]
}
if (powershell) {
  riskRequest.rawInput = {
    code: '$path = "./temporary.txt"\nGet-Item $path\nRemove-Item -LiteralPath $path',
    notebookCodeRisk: {
      language: 'bash',
      shellRuntime: { kind: 'powershell' },
      risks: [{ operation: 'Remove-Item', source: 'Remove-Item -LiteralPath $path', line: 3 }]
    }
  }
}
const runtimeSelection = new URLSearchParams(location.search).has('runtime')
const runtimeRequest: AcpPermissionRequest = {
  ...riskRequest,
  requestId: 'runtime-selection',
  title: 'Select Notebook environment',
  rawInput: {
    notebookRuntimeSelection: {
      language: 'python',
      runtimeId: 'research',
      label: 'Python research',
      previousRuntimeId: 'base',
      previousLabel: 'Python base'
    }
  }
}
const responses: Array<{ requestId: string; optionId?: string }> = []
Object.assign(window, { webPermissionResponses: responses })
const network = new URLSearchParams(location.search).has('network')
const networkRequest: AcpPermissionRequest = {
  requestId: 'network-approval',
  sessionId: 'parent',
  toolCallId: 'app-approval:network-approval',
  appOwned: true,
  providerToolName: 'Open Science',
  title: 'Connect to tcga-xena-hub.s3.us-east-1.amazonaws.com?',
  rawInput: {
    notebookNetworkApproval: {
      hostname: 'tcga-xena-hub.s3.us-east-1.amazonaws.com',
      runtime: 'python',
      reason: 'Download TCGA-LIHC expression and clinical data.'
    }
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
    { optionId: 'always-allow', name: 'Global', kind: 'allow_always', scope: 'global' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ]
}
if (network) {
  let snapshot: AcpStateSnapshot = {
    revision: 1,
    status: 'connected',
    cwd: '',
    sessionIds: ['parent'],
    events: [],
    pendingPermissions: [networkRequest],
    permissionProfiles: {},
    permissionGrants: {},
    contextUsageBySession: {},
    promptInFlight: true,
    promptInFlightSessionIds: ['parent']
  }
  let listener: ((state: AcpStateUpdate) => void) | undefined
  const settle = (): void => {
    snapshot = { ...snapshot, revision: snapshot.revision! + 1, pendingPermissions: [] }
    const state: AcpStateUpdate = { ...snapshot }
    delete state.events
    listener?.(state)
  }
  window.api = {
    platform: 'win32',
    acp: {
      getState: async () => snapshot,
      onState: (next: (state: AcpStateUpdate) => void) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      onEvent: () => () => undefined,
      respondToPermission: async (response: { requestId: string; optionId?: string }) => {
        responses.push(response)
        settle()
        return snapshot
      }
    }
  } as unknown as typeof window.api
  Object.assign(window, { cancelNetworkApproval: settle })
}
export const NetworkApproval = (): React.JSX.Element => {
  const runtime = useAcpRuntime()
  return (
    <section data-testid="network-approval-fixture">
      <h1 className="mb-6 text-xl font-semibold">TCGA-XENA</h1>
      <PermissionApprovalControls
        requests={runtime.state.pendingPermissions}
        onRespond={(requestId, optionId) => {
          void runtime.respondToPermission(requestId, optionId)
        }}
      />
    </section>
  )
}
const receiptState = new URLSearchParams(location.search).get('receipt')
const RiskReceipt = (): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false)
  const [runExpanded, setRunExpanded] = useState(true)
  const activity: ToolActivity = {
    id: 'app-approval:receipt',
    appOwned: true,
    kind: 'tool',
    title: riskRequest.title,
    providerToolName: 'Open-Science',
    rawInput: riskRequest.rawInput,
    status: receiptState === 'closed' ? 'in_progress' : 'completed',
    ...(receiptState === 'declined'
      ? { toolDisposition: 'declined' as const }
      : receiptState === 'closed'
        ? { toolDisposition: 'permission-closed' as const }
        : {}),
    eventIds: [],
    sortIndex: 1,
    createdAt: 1,
    updatedAt: 1
  }
  return (
    <section className="rounded-lg bg-bg-100 p-3" data-testid="risk-receipt-fixture">
      <WorkspaceToolDetailsRow
        activity={{
          ...activity,
          id: 'notebook-run',
          providerToolName: powershell
            ? 'mcp__open-science-notebook__bash_execute'
            : 'mcp__open-science-notebook__notebook_execute',
          rawInput: {
            language: powershell ? 'bash' : 'python',
            code: (riskRequest.rawInput as { code: string }).code
          },
          rawOutput: powershell
            ? { kernelKind: 'bash', shellRuntime: { kind: 'powershell' } }
            : undefined
        }}
        details={buildToolActivityDetails({
          ...activity,
          id: 'notebook-run',
          providerToolName: powershell
            ? 'mcp__open-science-notebook__bash_execute'
            : 'mcp__open-science-notebook__notebook_execute',
          rawInput: {
            language: powershell ? 'bash' : 'python',
            code: (riskRequest.rawInput as { code: string }).code
          },
          rawOutput: powershell
            ? { kernelKind: 'bash', shellRuntime: { kind: 'powershell' } }
            : undefined
        })!}
        phase="interrupted"
        isExpanded={runExpanded}
        onToggle={(_id, open) => setRunExpanded(open)}
      />
      {getRenderableActivityEntries([activity]).map(({ activity }) => (
        <WorkspaceToolDetailsRow
          key={activity.id}
          activity={activity}
          details={buildToolActivityDetails(activity)!}
          phase={getToolExecutionPhase(activity, undefined)}
          isExpanded={expanded}
          onToggle={(_id, open) => setExpanded(open)}
        />
      ))}
    </section>
  )
}
const schedulePreview = new URLSearchParams(location.search).has('schedule')
const SchedulePreview = (): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false)
  const message = new URLSearchParams(location.search).has('message')
  const invalid = new URLSearchParams(location.search).has('invalid-schedule')
  const title = 'mcp__open_science_schedule__create_schedule'
  const rawInput = {
    name: 'PubMed literature tracking',
    rule: invalid
      ? { kind: 'once', at: Date.UTC(2026, 10, 15, 12), timeZone: 'UTC' }
      : { kind: 'interval', minutes: 5, anchor: 0, timeZone: 'UTC' },
    ...(invalid ? { permissionProfile: 'auto', maxRuns: 1 } : {}),
    ...(message
      ? {
          message:
            'Search PubMed for recently published papers. Summarize up to 10 new papers and report them here, excluding papers from the previous run.'
        }
      : { script: { language: 'python', code: 'from datetime import date\nprint(date.today())' } })
  }

  const activity: ToolActivity = {
    id: 'create-task',
    rawOutput: invalid
      ? {
          isError: true,
          content: [
            { type: 'text', text: 'MCP error -32602: Input validation error: Invalid arguments' }
          ]
        }
      : { id: 'created-task', draft: scheduleToolDraft(rawInput), revision: 1 },
    kind: 'tool',
    title,
    providerToolName: title,
    rawInput,
    status: invalid ? 'failed' : 'completed',
    eventIds: [],
    sortIndex: 1,
    createdAt: 1,
    updatedAt: 1
  }
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <PermissionApprovalControls
        requests={[
          {
            requestId: 'create-task',
            sessionId: 'parent',
            toolCallId: 'create-task',
            toolKind: 'other',
            title,
            isMcp: true,
            mcpIdentity: 'open-science-schedule/create_schedule',
            rawInput,
            options: request.options.filter((option) => option.kind !== 'allow_always')
          }
        ]}
        onRespond={() => {}}
      />
      <WorkspaceToolDetailsRow
        activity={activity}
        details={buildToolActivityDetails(activity, t)!}
        isExpanded={expanded}
        onToggle={(_id, open) => setExpanded(open)}
      />
    </div>
  )
}
void Promise.resolve(prepareI18nLocale(language)).then(() => {
  initI18n(language)
  const embedded = new URLSearchParams(location.search).has('embedded')
  const approval = (
    <PermissionApprovalControls
      embedded={embedded}
      requests={[
        runtimeSelection
          ? runtimeRequest
          : risk
            ? riskRequest
            : builtInSearch
              ? builtInSearchRequest
              : request
      ]}
      onRespond={(requestId, optionId) => {
        responses.push({ requestId, optionId })
      }}
    />
  )
  createRoot(document.getElementById('root')!).render(
    <main className="min-h-screen bg-background p-5 text-foreground">
      <div className="mx-auto max-w-3xl">
        {schedulePreview ? (
          <SchedulePreview />
        ) : receiptState ? (
          <RiskReceipt />
        ) : network ? (
          <NetworkApproval />
        ) : embedded ? (
          <ResizableBottomPanel
            ariaLabel="Resize permission panel"
            testId="permission-composer"
            scrollTestId="permission-composer-scroll"
            constrainGrowthToOverflow
          >
            {approval}
          </ResizableBottomPanel>
        ) : (
          approval
        )}
      </div>
    </main>
  )
})
