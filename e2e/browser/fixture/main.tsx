import '@/assets/main.css'
import { useState } from 'react'
import { SessionPersistenceAlert } from '@/components/SessionPersistenceAlert'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { initI18n } from '@/i18n'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { HomePage } from '@/pages/home/HomePage'
import { useSettingsStore } from '@/stores/settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useTagStore } from '@/stores/tag-store'
import { useMemoryStore } from '@/stores/memory-store'
import { useUpdateStore } from '@/stores/update-store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ActionToast, ActionToastStack } from '@/components/ActionToast'
import { useSettingsUndoPortal } from '@/components/use-settings-undo-portal'
import { PermissionUndoSnackbar } from '@/components/PermissionUndoSnackbar'
import type { PermissionGrantView } from '../../../src/shared/permission-grants'
import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import { SessionCatalogRecoveryAlert } from '@/components/SessionCatalogRecoveryAlert'

// Native boundaries only. Components, navigation, i18n, CSS and browser geometry are production code.
// Missing APIs fail normally: do not use a catch-all proxy that could hide accidental dependencies.
const unsubscribe = (): (() => void) => () => undefined
const nativeApi = {
  platform: navigator.platform.startsWith('Win')
    ? 'win32'
    : navigator.platform.startsWith('Mac')
      ? 'darwin'
      : 'linux',
  window: { onCloseConfirmRequest: unsubscribe },
  settings: {},
  notifications: { getDesktopAvailability: async () => 'supported' },
  cli: {
    getStatus: async () => ({ installed: false, target: '/test/open-science', onPath: true })
  },
  logs: {
    getStatus: async () => ({
      configured: false,
      path: null,
      existing: false,
      lastWriteSucceeded: null,
      lastFailureCategory: null
    })
  },
  projectFiles: { onChanged: unsubscribe },
  github: { getStars: async () => 1000 }
} satisfies { [Key in keyof typeof window.api]?: Partial<(typeof window.api)[Key]> }
window.api = nativeApi as unknown as typeof window.api
initI18n('en')
useSettingsStore.setState({
  isLoaded: true,
  onboardingCompletedAt: 1,
  load: async () => true,
  setReasoningEffort: async (reasoningEffort) => useSettingsStore.setState({ reasoningEffort })
})
useProjectStore.setState({ isLoaded: true })
useTagStore.setState({ load: async () => undefined, listen: unsubscribe })
useMemoryStore.setState({ listen: unsubscribe })
useUpdateStore.setState({
  appInfo: { name: 'Open-Science', version: '0.0.0', copyright: 'Test fixture' },
  status: { state: 'up-to-date', current: '0.0.0', latest: '0.0.0' }
})

const undoFixture = new URLSearchParams(location.search).has('undo')
if (undoFixture) {
  const grants: PermissionGrantView[] = ['Attach connector', 'Attach skill', 'Create agent'].map(
    (capabilityLabel, index) => ({
      id: `fixture-${index}`,
      revision: 1,
      family: 'registry_writes',
      capabilityKind: 'customize_mutation',
      capabilityLabel,
      scopeKind: 'global',
      scopeLabel: 'Global',
      createdAt: 1_787_000_000_000
    })
  )
  const receipt = {
    token: 'fixture-undo',
    expiresAt: Date.now() + 60_000,
    messageKey: 'Revoked {{family}} · {{capability}}',
    messageParams: { family: 'Registry writes', capability: 'Attach connector' }
  }
  usePermissionGrantsStore.setState({
    status: 'ready',
    grants,
    counts: { all: 3, global: 3, project: 0, session: 0 },
    load: async () => {},
    extendUndo: async () => Date.now() + 60_000,
    revoke: async (revoked) =>
      usePermissionGrantsStore.setState({
        grants: grants.filter((grant) => !revoked.some((item) => item.id === grant.id)),
        undo: { ...receipt, expiresAt: Date.now() + 60_000 }
      }),
    restore: async () => usePermissionGrantsStore.setState({ grants, undo: undefined }),
    undo: new URLSearchParams(location.search).has('revoke') ? undefined : receipt
  })
}

export function Fixture(): React.JSX.Element {
  useTranslation()
  const [quitNotice, setQuitNotice] = useState(true)
  const [retries, setRetries] = useState(0)
  const open = useSettingsStore((state) => state.isSettingsOpen)
  const undoPortal = useSettingsUndoPortal(
    undoFixture ? <PermissionUndoSnackbar allowsArchiveShortcut={() => !open} /> : null
  )
  return (
    <TooltipProvider>
      <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={() => undefined} />
      {new URLSearchParams(location.search).has('catalog') ? (
        <>
          {open && (
            <ActionToastStack>
              <ActionToast
                title="Background cleanup notice"
                dismissLabel="Dismiss cleanup"
                onDismiss={() => {}}
              />
            </ActionToastStack>
          )}
          <SessionCatalogRecoveryAlert
            recovery={{
              kind: 'damaged-authority',
              affectedFiles: [{ projectId: 'research', fileName: 'conversation.json' }]
            }}
          />
        </>
      ) : null}
      {new URLSearchParams(location.search).has('quit') && quitNotice ? (
        <SessionPersistenceAlert
          className="z-[70]!"
          title="Quit was canceled"
          message="Some changes have not been saved."
          onRetry={() => setRetries(retries + 1)}
          onDismiss={() => setQuitNotice(false)}
        />
      ) : null}
      <output data-testid="quit-retries">{retries}</output>
      {undoFixture && (
        <div inert={open} aria-hidden={open || undefined}>
          <ActionToastStack>{undoPortal.background}</ActionToastStack>
        </div>
      )}
      <SettingsPage
        undoHostRef={undoPortal.settingsHostRef}
        open={open}
        onClose={() => useSettingsStore.getState().closeSettings()}
        onOpenSession={() => undefined}
      />
    </TooltipProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
