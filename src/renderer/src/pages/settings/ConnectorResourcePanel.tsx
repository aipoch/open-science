import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsLoadNotice } from './SettingsLayout'
import { useSettingsStore } from '@/stores/settings-store'
import type { ConnectorsView } from '@/lib/settings-navigation'
import { ConnectorsPanel } from './ConnectorsPanel'
import { ConnectorDetailView } from './ConnectorDetailView'
import { ConnectorAddForm } from './ConnectorAddForm'
import { ConnectorImportView } from './ConnectorImportView'
import { ConnectorExportView } from './ConnectorExportView'
import { ResourceTagSummary } from './ResourceTagControls'
import type { SettingsEditorLeaveState } from './SettingsLayout'
import type { SpecialistUsage } from './specialist-resource-scope'

// Routing facade only: the existing connector owners retain credentials, trust, and mutations.
export function ConnectorResourcePanel({
  view,
  active = true,
  onNavigate,
  onCancel,
  onLeaveStateChange,
  onOpenSpecialist
}: {
  view: ConnectorsView
  active?: boolean
  onNavigate: (view: ConnectorsView) => void
  onCancel: () => void
  onLeaveStateChange?: (state: SettingsEditorLeaveState | null) => void
  onOpenSpecialist?: (usage: SpecialistUsage) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const customServers = useSettingsStore((state) => state.customServers)
  const loaded = useSettingsStore((state) => state.connectorsLoaded)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (loaded || !active || view.kind === 'list') return
    let cancelled = false
    void loadConnectors().catch(() => {
      if (!cancelled) setFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [loaded, active, view.kind, loadConnectors, retry])
  const referencedCustom =
    view.kind === 'detail'
      ? customServers.find((server) => server.id === view.id || server.name === view.id)
      : undefined
  const redirectedCustom = useRef<string | null>(null)
  useEffect(() => {
    if (!loaded || !referencedCustom) {
      redirectedCustom.current = null
      return
    }
    // The detail can remain mounted during its drawer's exit animation.
    if (redirectedCustom.current === referencedCustom.id) return
    redirectedCustom.current = referencedCustom.id
    onNavigate({ kind: 'edit', id: referencedCustom.id })
  }, [loaded, referencedCustom, onNavigate])
  const openSettings = useSettingsStore((state) => state.openSettingsToPanel)
  const done = (): void => onNavigate({ kind: 'list' })
  if (!loaded && view.kind !== 'list')
    return (
      <div className="p-5">
        <SettingsLoadNotice
          state={failed ? 'error' : 'loading'}
          loadingLabel={t('Loading Connectors…')}
          errorMessage={t('Open-Science could not load Connectors.')}
          onRetry={() => {
            setFailed(false)
            setRetry((value) => value + 1)
          }}
        />
      </div>
    )
  // Resolve a cold-catalog reference before mounting the built-in detail owner.
  if (referencedCustom) return null
  if (view.kind === 'detail')
    return (
      <>
        <ResourceTagSummary
          reference={{ resourceType: 'catalog.connector', resourceId: view.id }}
          className="px-5 pt-5"
          onOpenTag={() => openSettings('tags')}
        />
        <ConnectorDetailView
          id={view.id}
          onOpenSpecialist={onOpenSpecialist}
          onManagePermissions={() => openSettings('permissions')}
          onManageCredentials={() => useSettingsStore.getState().openSettingsToOpenAlex()}
        />
      </>
    )
  if (view.kind === 'add' || view.kind === 'edit')
    return (
      <div>
        {view.kind === 'edit' && view.credentialView !== 'create' ? (
          <ResourceTagSummary
            reference={{ resourceType: 'catalog.connector', resourceId: view.id }}
            className="px-5 pt-5"
            onOpenTag={() => openSettings('tags')}
          />
        ) : null}
        <ConnectorAddForm
          key={view.kind === 'edit' ? view.id : 'add'}
          active={active}
          onLeaveStateChange={onLeaveStateChange}
          initialTransport={view.kind === 'add' ? view.transport : undefined}
          initialTemplate={view.kind === 'add' ? view.template : undefined}
          editServer={
            view.kind === 'edit' ? customServers.find((server) => server.id === view.id) : undefined
          }
          editServerId={view.kind === 'edit' ? view.id : undefined}
          credentialViewOpen={view.credentialView === 'create'}
          onCredentialViewChange={(open) =>
            onNavigate({ ...view, credentialView: open ? 'create' : undefined })
          }
          onDone={done}
          onCancel={onCancel}
        />
      </div>
    )
  if (view.kind === 'import')
    return (
      <ConnectorImportView
        onUse={(template) =>
          onNavigate({
            kind: 'add',
            transport: template.transport === 'stdio' ? 'local' : 'remote',
            template
          })
        }
        onCancel={onCancel}
      />
    )
  if (view.kind === 'export') return <ConnectorExportView id={view.id} onDone={done} />
  return (
    <ConnectorsPanel
      recoveryConnectorId={view.recoveryConnectorId}
      onNavigate={onNavigate}
      onOpenTag={() => openSettings('tags')}
      onOpenSpecialist={onOpenSpecialist}
    />
  )
}
