import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { PermissionApprovalControls } from '@/pages/workspace/PermissionApprovalControls'
import type { AcpPermissionRequest } from '../../../src/shared/acp'

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
void Promise.resolve(prepareI18nLocale(language)).then(() => {
  initI18n(language)
  createRoot(document.getElementById('root')!).render(
    <main className="min-h-screen bg-background p-5 text-foreground">
      <div className="mx-auto max-w-3xl">
        <PermissionApprovalControls
          requests={[request]}
          onRespond={(requestId, optionId) => {
            responses.push({ requestId, optionId })
          }}
        />
      </div>
    </main>
  )
})
