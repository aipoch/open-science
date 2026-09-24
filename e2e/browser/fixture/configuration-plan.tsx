import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { PermissionApprovalControls } from '@/pages/workspace/PermissionApprovalControls'
import type { AcpPermissionRequest } from '../../../src/shared/acp'

window.api = { platform: 'darwin' } as typeof window.api
const lang = new URLSearchParams(location.search).get('lang') === 'zh-Hans' ? 'zh-Hans' : 'en'
const packagePlan = new URLSearchParams(location.search).has('packages')
const responses: unknown[] = []
Object.assign(window, { planResponses: responses })
const request: AcpPermissionRequest = (
  window as unknown as { projectedPlan?: AcpPermissionRequest }
).projectedPlan ?? {
  requestId: 'plan',
  sessionId: 'session',
  toolCallId: 'app-approval:plan',
  appOwned: true,
  providerToolName: 'Open-Science',
  title: packagePlan ? 'Review installation plan' : 'Review configuration changes',
  rawInput: {
    configurationPlan: packagePlan
      ? {
          kind: 'package-installation',
          target: { runtimeId: 'python-analysis', label: 'Python analysis' },
          installer: 'pip',
          packages: [
            { name: 'numpy', version: '2.0.0', requested: true, sha256: 'a'.repeat(64) },
            { name: 'dependency', version: '1.0', requested: false }
          ]
        }
      : {
          kind: 'agent-configuration',
          operation: 'update',
          target: 'analysis-specialist',
          before: { revision: 2, systemPrompt: 'Review data.' },
          changes: { revision: 2, systemPrompt: 'Review data and document uncertainty.' }
        }
  },
  options: [
    { optionId: 'approve', name: 'Approve', kind: 'allow_once', scope: 'once' },
    { optionId: 'decline', name: 'Decline', kind: 'reject_once' }
  ]
}
void Promise.resolve(prepareI18nLocale(lang)).then(() => {
  initI18n(lang)
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
