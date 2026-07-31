import { ArrowUpRight, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'

import type {
  ConnectorDetailView as ConnectorDetail,
  ToolPermission
} from '../../../../shared/settings'
import { useSettingsStore } from '@/stores/settings-store'
import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import { Button } from '@/components/ui/button'
import { ConnectorGlyph } from './connector-icons'
import { SettingsToggle } from './SettingsLayout'
import { ToolPermissionControl } from './ToolPermissionControl'

type ConnectorDetailViewProps = {
  id: string
  onManagePermissions?: () => void
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
  onManagePermissions
}: ConnectorDetailViewProps): React.JSX.Element => {
  const setConnectorEnabled = useSettingsStore((state) => state.setConnectorEnabled)
  const setConnectorAutoAllow = useSettingsStore((state) => state.setConnectorAutoAllow)
  const setToolPermission = useSettingsStore((state) => state.setToolPermission)
  // The connector-level enabled/auto-allow state lives in the store's connectors list, which the
  // toggle actions reconcile authoritatively; the detail fetch only seeds tools + metadata. Reading
  // enabled/autoAllow from the store (falling back to the initial detail) keeps the two header
  // switches live after a toggle, mirroring how SkillDetailView derives enabled from the store.
  const storeConnector = useSettingsStore((state) => state.connectors.find((c) => c.id === id))
  const permissionGrants = usePermissionGrantsStore((state) => state.grants)
  const loadPermissionGrants = usePermissionGrantsStore((state) => state.load)
  const [detail, setDetail] = useState<ConnectorDetail | null>(null)
  // Ids of tools whose description is expanded.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleExpanded = (toolId: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(toolId)) next.delete(toolId)
      else next.add(toolId)
      return next
    })

  useEffect(() => {
    let active = true
    void window.api.settings.getConnectorDetail(id).then((result) => {
      if (active) setDetail(result)
    })
    return () => {
      active = false
    }
  }, [id])

  useEffect(() => {
    void loadPermissionGrants()
  }, [loadPermissionGrants])

  // Persist one tool's permission, folding the refreshed detail back into local state.
  const handleToolChange = async (toolId: string, permission: ToolPermission): Promise<void> => {
    await setToolPermission(toolId, permission).then(setDetail)
  }

  if (!detail) return <div className="p-5" />

  const enabled = storeConnector?.enabled ?? detail.enabled
  const autoAllow = storeConnector?.autoAllow ?? detail.autoAllow

  return (
    <div className="p-5">
      {/* Header: icon + name + Featured badge + enable toggle, then description below. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ConnectorGlyph size={28} />
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-base font-semibold text-foreground">
              {detail.displayName}
            </h1>
            <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              Featured
            </span>
          </div>
        </div>
        <SettingsToggle
          enabled={enabled}
          aria-label={`Toggle ${detail.displayName}`}
          onToggle={() => void setConnectorEnabled(id, !enabled)}
        />
      </div>

      {detail.description ? (
        <p className="mt-2 text-sm text-muted-foreground [text-wrap:pretty]">
          {detail.description}
        </p>
      ) : null}

      {/* Skip approvals: allow every tool without a per-call approval card. */}
      <div className="mt-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-foreground">Skip approvals</p>
          <p className="text-xs text-muted-foreground [text-wrap:pretty]">
            Allow the agent to use every tool from this connector without showing an approval card
            each time.
          </p>
        </div>
        <SettingsToggle
          enabled={autoAllow}
          aria-label={`Skip approvals for ${id}`}
          onToggle={() => void setConnectorAutoAllow(id, !autoAllow)}
        />
      </div>

      {/* Tools: per-tool permission controls. */}
      <section className="mt-6 border-t border-border pt-4">
        <h2 className="text-sm font-semibold text-foreground">Tools</h2>
        <p className="text-xs text-muted-foreground">What the agent can do with this connector</p>
        {detail.tools.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">This connector has no tools.</p>
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
                      label={`Permission for ${tool.method}`}
                      onChange={(permission) => void handleToolChange(tool.id, permission)}
                    />
                  </div>
                  {isExpanded ? (
                    <div className="space-y-2 pb-3 pl-6 pr-2 text-xs text-muted-foreground">
                      <p className="whitespace-pre-wrap [text-wrap:pretty]">
                        {tool.description || 'No description provided for this tool.'}
                      </p>
                      {tool.permission === 'ask' ? (
                        <p>Ask when no Session, Project, or Global permission applies.</p>
                      ) : null}
                      {remembered.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span>
                            Remembered approvals: {remembered.length}
                            {tool.permission === 'block'
                              ? ' · currently blocked'
                              : tool.permission === 'allow' || autoAllow
                                ? ' · currently unnecessary'
                                : ''}
                          </span>
                          {remembered.map((grant) => (
                            <span
                              key={grant.id}
                              className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground"
                            >
                              {grant.scopeKind === 'global'
                                ? 'Global'
                                : grant.scopeKind === 'project'
                                  ? 'Project'
                                  : 'Session'}
                            </span>
                          ))}
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="h-auto px-1 py-0 text-xs"
                            onClick={onManagePermissions}
                          >
                            Manage permissions
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
          <h2 className="mb-1 text-sm font-semibold text-foreground">Details</h2>
          <DetailRow label="Third-party software, content, terms, and information">
            <span className="text-foreground">{detail.sources.join(', ')}</span>
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
                  <span className="underline">Terms</span>
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
