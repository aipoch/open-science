import { ArrowUpRight, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  ConnectorDetailView as ConnectorDetail,
  ToolPermission
} from '../../../../shared/settings'
import { useSettingsStore } from '@/stores/settings-store'
import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { Button } from '@/components/ui/button'
import { ConnectorGlyph } from './connector-icons'
import { SettingsLoadNotice, SettingsToggle } from './SettingsLayout'
import { ToolPermissionControl } from './ToolPermissionControl'
import { ResourceAvailability } from './ResourceAvailability'
import { specialistsUsingConnector } from './specialist-resource-scope'

type ConnectorDetailViewProps = {
  id: string
  onManagePermissions?: () => void
  onManageCredentials?: () => void
}

// One label/value row in the Details section.
const DetailRow = ({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element => (
  <div className="flex flex-col gap-0.5 py-1.5">
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
    <span className="text-sm text-foreground">{children}</span>
  </div>
)

// Detail view for one bundled connector: header (name + Featured badge + enable toggle + description),
// a "Skip approvals" row, the per-tool permission list, and connector metadata under "Details". The
// breadcrumb and back control live in the settings header, not here.
const ConnectorDetailView = ({
  id,
  onManagePermissions,
  onManageCredentials
}: ConnectorDetailViewProps): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const setConnectorEnabled = useSettingsStore((state) => state.setConnectorEnabled)
  const setConnectorAutoAllow = useSettingsStore((state) => state.setConnectorAutoAllow)
  const setToolPermission = useSettingsStore((state) => state.setToolPermission)
  // The connector-level enabled/auto-allow state lives in the store's connectors list, which the
  // toggle actions reconcile authoritatively; the detail fetch only seeds tools + metadata. Reading
  // enabled/autoAllow from the store (falling back to the initial detail) keeps the two header
  // switches live after a toggle, mirroring how SkillDetailView derives enabled from the store.
  const storeConnector = useSettingsStore((state) => state.connectors.find((c) => c.id === id))
  const specialistItems = useSpecialistStore((state) => state.items)
  const loadSpecialists = useSpecialistStore((state) => state.load)
  const permissionGrants = usePermissionGrantsStore((state) => state.grants)
  const loadPermissionGrants = usePermissionGrantsStore((state) => state.load)
  const [detail, setDetail] = useState<ConnectorDetail | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [operationError, setOperationError] = useState<string | undefined>()
  const loadRequestRef = useRef(0)
  // Ids of tools whose description is expanded.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleExpanded = (toolId: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(toolId)) next.delete(toolId)
      else next.add(toolId)
      return next
    })

  const loadDetail = async (): Promise<void> => {
    const requestId = ++loadRequestRef.current
    setDetail(null)
    setLoadState('loading')
    try {
      const result = await window.api.settings.getConnectorDetail(id)
      if (loadRequestRef.current !== requestId) return
      setDetail(result)
      setLoadState('ready')
    } catch {
      if (loadRequestRef.current === requestId) setLoadState('error')
    }
  }

  const retryLoad = (): void => {
    void loadDetail()
  }

  useEffect(() => {
    const requestId = ++loadRequestRef.current
    void window.api.settings.getConnectorDetail(id).then(
      (result) => {
        if (loadRequestRef.current !== requestId) return
        setDetail(result)
        setLoadState('ready')
      },
      () => {
        if (loadRequestRef.current === requestId) setLoadState('error')
      }
    )
    return () => {
      loadRequestRef.current += 1
    }
  }, [id])

  useEffect(() => {
    void loadPermissionGrants()
  }, [loadPermissionGrants])

  useEffect(() => {
    void loadSpecialists()
  }, [loadSpecialists])

  const savePolicy = async (command: () => Promise<void>): Promise<void> => {
    setOperationError(undefined)
    try {
      await command()
    } catch {
      setOperationError(t('Could not save this setting. The previous value was restored.'))
    }
  }

  // Persist one tool's permission, folding the refreshed detail back into local state.
  const handleToolChange = (toolId: string, permission: ToolPermission): Promise<void> =>
    savePolicy(async () => {
      setDetail(await setToolPermission(toolId, permission))
    })

  if (!detail) {
    return (
      <div className="p-5">
        <SettingsLoadNotice
          state={loadState === 'error' ? 'error' : 'loading'}
          loadingLabel={t('Loading Connector…')}
          errorMessage={t('Open Science could not load this Connector.')}
          onRetry={retryLoad}
        />
      </div>
    )
  }

  const enabled = storeConnector?.enabled ?? detail.enabled
  const autoAllow = storeConnector?.autoAllow ?? detail.autoAllow
  const usages = specialistsUsingConnector(specialistItems, storeConnector ?? detail)

  return (
    <div className="p-5">
      {/* Header: icon + name + Featured badge, then description below. */}
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ConnectorGlyph size={28} />
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-base font-semibold text-foreground">
              {detail.displayName}
            </h1>
            <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {t('Featured')}
            </span>
          </div>
        </div>
      </div>

      {detail.description ? (
        <p className="mt-2 text-sm text-muted-foreground [text-wrap:pretty]">
          {detail.description}
        </p>
      ) : null}

      {id === 'literature' && onManageCredentials ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={onManageCredentials}
        >
          {t('Manage credentials')}
        </Button>
      ) : null}

      {operationError ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
        >
          {operationError}
        </p>
      ) : null}

      <ResourceAvailability
        mainEnabled={enabled}
        mainToggleLabel={t('Toggle {{name}}', { name: detail.displayName })}
        usages={usages}
        onToggleMain={() =>
          void savePolicy(async () => {
            await setConnectorEnabled(id, !enabled)
          })
        }
      />

      {/* Skip approvals: allow every tool without a per-call approval card. */}
      <div className="mt-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-foreground">{t('Skip approvals')}</p>
          <p className="text-xs text-muted-foreground [text-wrap:pretty]">
            {t(
              'Allow the agent to use every tool from this connector without showing an approval card each time.'
            )}
          </p>
        </div>
        <SettingsToggle
          enabled={autoAllow}
          aria-label={t('Skip approvals for {{name}}', { name: id })}
          onToggle={() =>
            void savePolicy(async () => {
              await setConnectorAutoAllow(id, !autoAllow)
            })
          }
        />
      </div>

      {/* Tools: per-tool permission controls. */}
      <section className="mt-6 border-t border-border pt-4">
        <h2 className="text-sm font-semibold text-foreground">{t('Tools')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('What the agent can do with this connector')}
        </p>
        {detail.tools.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t('This connector has no tools.')}</p>
        ) : (
          <div className="mt-2 flex flex-col">
            {detail.tools.map((tool) => {
              const isExpanded = expanded.has(tool.id)
              const remembered = permissionGrants.filter(
                (grant) => grant.connectorServerId === id && grant.connectorToolName === tool.method
              )

              return (
                <div key={tool.id}>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={() => toggleExpanded(tool.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 py-2.5 text-left"
                    >
                      <ChevronRight
                        className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${
                          isExpanded ? 'rotate-90' : ''
                        }`}
                        aria-hidden="true"
                      />
                      <span className="truncate text-sm text-foreground">{tool.method}</span>
                    </button>
                    <ToolPermissionControl
                      value={tool.permission}
                      label={t('Permission for {{name}}', {
                        name: tool.method
                      })}
                      onChange={(permission) => void handleToolChange(tool.id, permission)}
                    />
                  </div>
                  {isExpanded ? (
                    <div className="space-y-2 pb-3 pl-6 pr-2 text-xs text-muted-foreground">
                      <p className="whitespace-pre-wrap [text-wrap:pretty]">
                        {tool.description || t('No description provided for this tool.')}
                      </p>
                      {tool.permission === 'ask' ? (
                        <p>{t('Ask when no Session, Project, or Global permission applies.')}</p>
                      ) : null}
                      {remembered.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {/* The status clause is a separate key so translators aren't handed a
                              sentence fragment glued on with a middot. */}
                          <span>
                            {t('Remembered approvals: {{count}}', {
                              defaultValue_one: 'Remembered approvals: {{count}}',
                              count: remembered.length
                            })}
                            {tool.permission === 'block'
                              ? ` · ${t('currently blocked')}`
                              : tool.permission === 'allow' || autoAllow
                                ? ` · ${t('currently unnecessary')}`
                                : ''}
                          </span>
                          {remembered.map((grant) => (
                            <span
                              key={grant.id}
                              className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground"
                            >
                              {grant.scopeKind === 'global'
                                ? t('Global')
                                : grant.scopeKind === 'project'
                                  ? t('Project')
                                  : t('Session')}
                            </span>
                          ))}
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="h-auto px-1 py-0 text-xs"
                            onClick={onManagePermissions}
                          >
                            {t('Manage permissions')}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Details: third-party source(s) and terms. */}
      {detail.sources.length > 0 ? (
        <section className="mt-6 border-t border-border pt-4">
          <h2 className="mb-1 text-sm font-semibold text-foreground">{t('Details')}</h2>
          <DetailRow label={t('Third-party software, content, terms, and information')}>
            {/* Intl supplies the locale's own list separator; a literal ", " would leak a Western
                comma into zh, which separates list items with 、 instead. */}
            <span className="text-foreground">
              {new Intl.ListFormat(i18n.language, {
                style: 'narrow',
                type: 'conjunction'
              }).format(detail.sources)}
            </span>
            {detail.termsUrl ? (
              <>
                {' '}
                <span aria-hidden="true" className="text-muted-foreground">
                  —
                </span>{' '}
                <a
                  href={detail.termsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 align-baseline text-primary"
                >
                  <span className="underline">{t('Terms')}</span>
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </a>
              </>
            ) : null}
          </DetailRow>
        </section>
      ) : null}
    </div>
  )
}

export { ConnectorDetailView }
