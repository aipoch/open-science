import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { PermissionApprovalControls } from '@/pages/workspace/PermissionApprovalControls'
import { useAcpRuntime } from '@/lib/acp/useAcpRuntime'
import type {
  AcpPermissionRequest,
  AcpStateSnapshot,
  AcpStateUpdate
} from '../../../src/shared/acp'

const language = new URLSearchParams(location.search).get('lang') === 'zh-Hans' ? 'zh-Hans' : 'en'
document.documentElement.classList.add('dark')
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
void Promise.resolve(prepareI18nLocale(language)).then(() => {
  initI18n(language)
  createRoot(document.getElementById('root')!).render(
    <main className="min-h-screen bg-background p-5 text-foreground">
      <div className="mx-auto max-w-3xl">
        {network ? (
          <NetworkApproval />
        ) : (
          <PermissionApprovalControls
            requests={[request]}
            onRespond={(requestId, optionId) => {
              responses.push({ requestId, optionId })
            }}
          />
        )}
      </div>
    </main>
  )
})
