import { AlertTriangle, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type {
  PermissionGrantFamily,
  PermissionGrantSnapshot,
  PermissionGrantScope,
  PermissionGrantView
} from '../../../../shared/permission-grants'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import { SettingsIconAction, SettingsSection } from './SettingsLayout'

type ScopeFilter = 'all' | PermissionGrantScope['kind']

const FAMILY_DETAILS: ReadonlyArray<{
  id: PermissionGrantFamily
  title: string
  description: string
}> = [
  {
    id: 'registry_writes',
    title: 'Registry writes',
    description: 'Agent and skill registry changes that persist across sessions'
  },
  {
    id: 'local_compute',
    title: 'Local compute',
    description: 'Sandbox tools that run without preview'
  },
  {
    id: 'connectors',
    title: 'Connectors',
    description: 'Approved MCP connector tools and calls'
  },
  {
    id: 'file_operations',
    title: 'File operations',
    description: 'Approved reads, writes, moves, and deletions'
  },
  {
    id: 'skills',
    title: 'Skills',
    description: 'Skill invocation and package operations'
  },
  {
    id: 'built_in_tools',
    title: 'Built-in tools',
    description: 'Application-owned tools that do not belong to another family'
  }
]

const FILTER_LABELS: Record<ScopeFilter, string> = {
  all: 'All',
  global: 'Global',
  project: 'Project',
  session: 'Session'
}

const INCOMPLETE_STORE_LABELS: Record<PermissionGrantSnapshot['incompleteStores'][number], string> =
  {
    projects: 'Project names',
    sessions: 'Session names',
    connector_policy: 'Connector policy'
  }

const PermissionRow = ({
  grant,
  onRevoke,
  onOpenConnector,
  onOpenSession
}: {
  grant: PermissionGrantView
  onRevoke: (grant: PermissionGrantView) => void
  onOpenConnector?: (serverId: string) => void
  onOpenSession?: (sessionId: string) => void
}): React.JSX.Element => {
  const sessionId = grant.scopeKind === 'session' ? grant.sessionId : undefined
  const scopeClassName =
    'col-start-1 row-start-2 max-w-full justify-self-start truncate rounded-md bg-muted px-2 py-1 text-sm text-muted-foreground sm:col-start-2 sm:row-start-1 sm:max-w-80'

  return (
    <div
      data-slot="permission-row"
      className="group grid min-h-11 min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/45 focus-within:bg-muted/45 sm:grid-cols-[minmax(0,1fr)_auto_2rem]"
    >
      <div className="min-w-0">
        <div>
          <span className="text-sm text-foreground">{grant.capabilityLabel}</span>
          {grant.qualifierLabel ? (
            <span className="ml-2 text-sm text-muted-foreground">{grant.qualifierLabel}</span>
          ) : null}
        </div>
        {grant.coveredBy ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Also allowed {grant.coveredBy === 'global' ? 'globally' : 'for this project'}
          </p>
        ) : null}
        {grant.policyHint ? (
          <button
            type="button"
            className="mt-0.5 block rounded-sm text-left text-xs text-muted-foreground underline-offset-2 outline-none transition-colors duration-150 motion-reduce:transition-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() =>
              grant.connectorServerId ? onOpenConnector?.(grant.connectorServerId) : undefined
            }
          >
            {grant.policyHint}
          </button>
        ) : null}
      </div>
      {sessionId && onOpenSession ? (
        <button
          type="button"
          title={grant.scopeLabel}
          aria-label={`Open ${grant.scopeLabel}`}
          className={`${scopeClassName} cursor-pointer transition-colors duration-150 motion-reduce:transition-none outline-none hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50`}
          onClick={() => onOpenSession(sessionId)}
        >
          {grant.scopeLabel}
        </button>
      ) : (
        <span title={grant.scopeLabel} className={scopeClassName}>
          {grant.scopeLabel}
        </span>
      )}
      <SettingsIconAction
        label={`Revoke ${grant.capabilityLabel}`}
        icon={X}
        danger
        className="relative col-start-2 row-span-2 row-start-1 size-8 shrink-0 opacity-100 transition-opacity duration-150 motion-reduce:transition-none before:absolute before:-inset-1.5 before:content-[''] sm:col-start-3 sm:row-span-1 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
        onClick={() => onRevoke(grant)}
      />
    </div>
  )
}

const PermissionsPanel = ({
  onOpenConnector,
  onOpenSession
}: {
  onOpenConnector?: (serverId: string) => void
  onOpenSession?: (sessionId: string) => void
}): React.JSX.Element => {
  const grants = usePermissionGrantsStore((state) => state.grants)
  const counts = usePermissionGrantsStore((state) => state.counts)
  const incompleteStores = usePermissionGrantsStore((state) => state.incompleteStores)
  const status = usePermissionGrantsStore((state) => state.status)
  const error = usePermissionGrantsStore((state) => state.error)
  const load = usePermissionGrantsStore((state) => state.load)
  const revoke = usePermissionGrantsStore((state) => state.revoke)
  const [filter, setFilter] = useState<ScopeFilter>('all')

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(
    () => grants.filter((grant) => filter === 'all' || grant.scopeKind === filter),
    [filter, grants]
  )

  return (
    <div className="px-5 pb-5">
      <div className="sticky top-0 z-10 -mx-5 mb-2 bg-card px-5 py-5">
        <Select value={filter} onValueChange={(value) => setFilter(value as ScopeFilter)}>
          <SelectTrigger
            aria-label="Filter permissions by scope"
            className="w-full max-w-72 whitespace-nowrap [font-variant-numeric:tabular-nums]"
          >
            {FILTER_LABELS[filter]} ({counts[filter]})
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(FILTER_LABELS) as ScopeFilter[]).map((scope) => (
              <SelectItem key={scope} value={scope}>
                {FILTER_LABELS[scope]} ({counts[scope]})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {incompleteStores.length > 0 ? (
        <div role="status" className="mb-4 rounded-lg border border-border bg-muted/35 px-3 py-2">
          <p className="text-sm text-foreground">Some permission details are unavailable</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {incompleteStores.map((store) => INCOMPLETE_STORE_LABELS[store]).join(', ')} could not
            be loaded. Individual grants remain revocable; Revoke all is disabled until the complete
            set is known.
          </p>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <p>{error}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void load()}
          >
            Try again
          </Button>
        </div>
      ) : null}

      <div className="scroll-pb-24">
        {status === 'loading' && grants.length === 0 ? (
          <div className="space-y-3" aria-label="Loading permissions">
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="h-11 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
              />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <p className="sr-only" role="status">
            No remembered permissions for this scope.
          </p>
        ) : (
          <div className="space-y-5">
            {FAMILY_DETAILS.map(({ id, title, description }) => {
              const familyGrants = visible.filter((grant) => grant.family === id)
              if (familyGrants.length === 0) return null

              return (
                <SettingsSection
                  key={id}
                  title={title}
                  titleId={`permission-family-${id}`}
                  description={description}
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Revoke all ${filter === 'all' ? '' : `${FILTER_LABELS[filter]} `}${title} permissions`}
                      disabled={incompleteStores.length > 0}
                      className="whitespace-nowrap"
                      onClick={() => void revoke(familyGrants)}
                    >
                      Revoke all
                    </Button>
                  }
                  aria-labelledby={`permission-family-${id}`}
                  className="border-b border-border pb-4 last:border-b-0 last:pb-0"
                  headerClassName="flex-col gap-3 sm:flex-row sm:items-start"
                  actionClassName="self-start"
                  contentClassName="mt-1"
                >
                  <div>
                    {familyGrants.map((grant) => (
                      <PermissionRow
                        key={grant.id}
                        grant={grant}
                        onRevoke={(item) => void revoke([item])}
                        onOpenConnector={onOpenConnector}
                        onOpenSession={onOpenSession}
                      />
                    ))}
                  </div>
                </SettingsSection>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export { PermissionsPanel }
