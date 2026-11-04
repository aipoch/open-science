import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { SessionDiagnosticsDialog } from '@/pages/workspace/SessionDiagnosticsDialog'
import type { SessionDiagnosticExportResult } from '../../../src/shared/session-diagnostics'

const params = new URLSearchParams(location.search)
if (params.has('dark')) document.documentElement.classList.add('dark')
if (params.has('windows'))
  document.documentElement.dataset.windowsTitlebar = params.has('fullscreen')
    ? 'fullscreen'
    : 'restored'
initI18n('en')
const outcome = params.get('outcome') ?? 'exported'
const path = params.has('windows')
  ? 'C:\\Users\\researcher\\' + 'Long research folder\\'.repeat(25) + 'diagnostics.tar.gz'
  : '/Users/researcher/' + 'Long research folder/'.repeat(25) + 'diagnostics.tar.gz'
window.api = {
  sessions: {
    inspectDiagnostics: async () => {
      if (params.has('preparing')) return new Promise(() => {})
      return {
        items: [
          ...Array.from({ length: 18 }, (_, index) => ({
            id: `session-${index}`,
            name: `session-${index}.json`,
            kind: 'session',
            available: true,
            sizeBytes: 4096
          })),
          ...[
            'desktop-log:main.log',
            'desktop-log:main.1.log',
            'desktop-legacy-log:main.log',
            'backend-log:desktop-backend-12345-1700000000000.log'
          ].map((id) => ({
            id,
            name: id.slice(id.indexOf(':') + 1),
            kind: 'log',
            available: true,
            sizeBytes: 262144
          }))
        ]
      }
    },
    exportDiagnostics: async (): Promise<SessionDiagnosticExportResult> => ({
      status: outcome === 'partial' ? 'partial' : outcome === 'failed' ? 'failed' : 'exported',
      ...(outcome === 'failed' ? { error: 'Diagnostic operation timed out.' } : { path }),
      report: 'Fixture diagnostic report'
    }),
    cancelDiagnostics: async () => {}
  },
  compute: { revealInFolder: async () => {} }
} as unknown as typeof window.api

createRoot(document.getElementById('root')!).render(
  <SessionDiagnosticsDialog
    identity={{ projectId: 'fixture', sessionId: 'fixture' }}
    onClose={() => {}}
  />
)
