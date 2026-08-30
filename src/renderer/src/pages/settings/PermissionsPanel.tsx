import { AlertTriangle, Shield, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { AlertDialog } from 'radix-ui'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import type {
  PermissionGrantFamily,
  PermissionGrantSnapshot,
  PermissionGrantScope,
  PermissionGrantView
} from '../../../../shared/permission-grants'
import { Button } from '@/components/ui/button'
import {
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import { useSettingsStore } from '@/stores/settings-store'
import { cn } from '@/lib/utils'
import { RestoreDefaultPermissionsButton } from './RestoreDefaultPermissionsButton'
import { SettingsIconAction, SettingsRow, SettingsSection } from './SettingsLayout'

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

// English source text for the permission modes. The strings stay here as literals so they read in
// the diff and the orphan guard can see them, but they travel to the Select as *data* rather than as
// JSX, so every read site below calls t() on them.
const PERMISSION_PROFILES: ReadonlyArray<{
  id: PermissionProfileId
  label: string
  description: string
  icon: typeof Shield
}> = [
  {
    id: 'ask',
    label: 'Ask for approval',
    description: 'Ask before file edits, commands, network, and MCP tools.',
    icon: Shield
  },
  {
    id: 'auto',
    label: 'Auto-approve edits',
    description:
      'Auto-approve edits to workspace files. Still ask before commands, network, and MCP tools.',
    icon: ShieldCheck
  },
  {
    id: 'full',
    label: 'Full access',
    description: 'Run everything without prompts, including commands and network.',
    icon: ShieldAlert
  }
]

const permissionProfileLabel = (profile: PermissionProfileId): string =>
  PERMISSION_PROFILES.find((candidate) => candidate.id === profile)?.label ?? 'Ask for approval'

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
  const { t } = useTranslation()
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
          <span className="text-sm text-foreground">{t(grant.capabilityLabel)}</span>
          {grant.qualifierLabel ? (
            <span className="ml-2 text-sm text-muted-foreground">{grant.qualifierLabel}</span>
          ) : null}
        </div>
        {grant.coveredBy ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('Also allowed {{scope}}', {
              scope: grant.coveredBy === 'global' ? t('globally') : t('for this project')
            })}
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
          aria-label={t('Open {{scope}}', { scope: grant.scopeLabel })}
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
        label={t('Revoke {{name}}', { name: t(grant.capabilityLabel) })}
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
  const { t } = useTranslation()

  const grants = usePermissionGrantsStore((state) => state.grants)
  const counts = usePermissionGrantsStore((state) => state.counts)
  const incompleteStores = usePermissionGrantsStore((state) => state.incompleteStores)
  const status = usePermissionGrantsStore((state) => state.status)
  const error = usePermissionGrantsStore((state) => state.error)
  const load = usePermissionGrantsStore((state) => state.load)
  const revoke = usePermissionGrantsStore((state) => state.revoke)
  const restoreDefaults = usePermissionGrantsStore((state) => state.restoreDefaults)
  const restoreDefaultsState = usePermissionGrantsStore((state) => state.restoreDefaultsState)
  const defaultPermissionProfile = useSettingsStore((state) => state.defaultPermissionProfile)
  const setDefaultPermissionProfile = useSettingsStore((state) => state.setDefaultPermissionProfile)
  const [filter, setFilter] = useState<ScopeFilter>('all')
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(
    () => grants.filter((grant) => filter === 'all' || grant.scopeKind === filter),
    [filter, grants]
  )

  const selectDefaultProfile = (profile: PermissionProfileId): void => {
    if (profile === defaultPermissionProfile) return
    if (profile === 'full') {
      setConfirmFullAccess(true)
      return
    }
    void setDefaultPermissionProfile(profile)
  }

  return (
    <div className="px-5 pb-5">
      <SettingsSection
        title={t('New conversations')}
        description={t(
          'Choose how much the agent can do without asking when a conversation starts.'
        )}
        aria-label={t('New conversation permissions')}
        className="pt-5"
      >
        <SettingsRow
          label={t('Default permission mode')}
          description={t(
            'Applied only to new conversations. You can change it in Agent controls before sending the first message.'
          )}
          className="pt-0"
        >
          <Select
            value={defaultPermissionProfile}
            onValueChange={(value) => selectDefaultProfile(value as PermissionProfileId)}
          >
            <SelectTrigger aria-label={t('Default permission mode')}>
              <span>{t(permissionProfileLabel(defaultPermissionProfile))}</span>
            </SelectTrigger>
            <SelectContent className="w-[min(24rem,calc(100vw-2rem))]">
              {PERMISSION_PROFILES.map((profile) => {
                const Icon = profile.icon
                const isFull = profile.id === 'full'

                return (
                  <SelectItem
                    key={profile.id}
                    value={profile.id}
                    icon={
                      <Icon
                        className={cn('size-4', isFull && 'text-amber-600 dark:text-amber-400')}
                        aria-hidden="true"
                      />
                    }
                    className="items-start py-2"
                  >
                    <span className="block min-w-0 pr-1">
                      <span
                        className={cn(
                          'block font-medium leading-5',
                          isFull && 'text-amber-600 dark:text-amber-400'
                        )}
                      >
                        {t(profile.label)}
                      </span>
                      <span
                        className={cn(
                          'block text-xs leading-4 text-muted-foreground whitespace-normal',
                          isFull && 'text-amber-600/75 dark:text-amber-400/75'
                        )}
                      >
                        {t(profile.description)}
                      </span>
                    </span>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        </SettingsRow>

        {defaultPermissionProfile === 'full' ? (
          <div
            role="status"
            className="mt-1 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t(
              'New conversations can run commands, change files, and access the network without asking first. Existing conversations keep their current permission mode.'
            )}
          </div>
        ) : null}
      </SettingsSection>

      <div className="sticky top-0 z-10 -mx-5 mt-5 mb-2 border-t border-border bg-card px-5 py-5">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">
              {t('Remembered permissions')}
            </h3>
            <p className="mt-0.5 max-w-2xl text-[13px] leading-5 text-muted-foreground">
              {t('Review or revoke approvals saved for tools, projects, and conversations.')}
            </p>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              {t(
                'Restore missing default Global permissions without changing other remembered permissions.'
              )}
            </p>
          </div>
          <RestoreDefaultPermissionsButton
            state={restoreDefaultsState}
            onRestore={() => void restoreDefaults()}
          />
        </div>
        <Select value={filter} onValueChange={(value) => setFilter(value as ScopeFilter)}>
          <SelectTrigger
            aria-label={t('Filter permissions by scope')}
            className="w-full max-w-72 whitespace-nowrap [font-variant-numeric:tabular-nums]"
          >
            {t(FILTER_LABELS[filter])} ({counts[filter]})
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(FILTER_LABELS) as ScopeFilter[]).map((scope) => (
              <SelectItem key={scope} value={scope}>
                {t(FILTER_LABELS[scope])} ({counts[scope]})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {incompleteStores.length > 0 ? (
        <div role="status" className="mb-4 rounded-lg border border-border bg-muted/35 px-3 py-2">
          <p className="text-sm text-foreground">{t('Some permission details are unavailable')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('The following permission details could not be loaded: {{stores}}', {
              stores: incompleteStores.map((store) => t(INCOMPLETE_STORE_LABELS[store])).join(', ')
            })}{' '}
            {t(
              'Individual grants remain revocable; Revoke all is disabled until the complete set is known.'
            )}
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
            <p>{t(error)}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void load({ force: true })}
          >
            {t('Try again')}
          </Button>
        </div>
      ) : null}

      <div className="scroll-pb-24">
        {status === 'loading' && grants.length === 0 ? (
          <div className="space-y-3" aria-label={t('Loading permissions')}>
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="h-11 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
              />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <p className="sr-only" role="status">
            {t('No remembered permissions for this scope.')}
          </p>
        ) : (
          <div className="space-y-5">
            {FAMILY_DETAILS.map(({ id, title, description }) => {
              const familyGrants = visible.filter((grant) => grant.family === id)
              if (familyGrants.length === 0) return null

              const familyLabel = t(title)
              const scopeLabel = filter === 'all' ? '' : `${t(FILTER_LABELS[filter])} `

              return (
                <SettingsSection
                  key={id}
                  title={familyLabel}
                  titleId={`permission-family-${id}`}
                  description={t(description)}
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t('Revoke all {{scope}}{{family}} permissions', {
                        scope: scopeLabel,
                        family: familyLabel
                      })}
                      disabled={incompleteStores.length > 0}
                      className="whitespace-nowrap"
                      onClick={() => void revoke(familyGrants)}
                    >
                      {t('Revoke all')}
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

      <AlertDialog.Root open={confirmFullAccess} onOpenChange={setConfirmFullAccess}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
          <AlertDialog.Content
            className={dialogPanelClassName(
              'z-[60] w-[min(440px,calc(100vw-2rem))] overscroll-contain p-0'
            )}
          >
            <div className={dialogHeaderClassName}>
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                  <AlertTriangle className="size-5" strokeWidth={2} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <AlertDialog.Title className={dialogTitleClassName}>
                    {t('Use Full access by default?')}
                  </AlertDialog.Title>
                  <AlertDialog.Description className={dialogDescriptionClassName}>
                    {t(
                      'New conversations can run commands, change files, execute notebook code, and access the network without asking first. Existing conversations are unchanged.'
                    )}
                  </AlertDialog.Description>
                </div>
              </div>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Close')}
                  className={dialogCloseButtonClassName}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </AlertDialog.Cancel>
            </div>
            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="ghost" className={dialogCancelButtonClassName}>
                  {t('Cancel')}
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  type="button"
                  className="bg-amber-600 text-white hover:bg-amber-700"
                  onClick={() => void setDefaultPermissionProfile('full')}
                >
                  {t('Use Full access')}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

export { PermissionsPanel }
