/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V3
 * component: Connector catalog · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: semantic foreground / surface tokens · slop: pass (component/static)
 * responsive: wrapping toolbar and rows · visual gates: pending user review
 */
import {
  AlertTriangle,
  ChevronDown,
  Download,
  FileUp,
  Globe,
  Pencil,
  Plus,
  Terminal,
  Trash2,
  X
} from 'lucide-react'
import { AlertDialog } from 'radix-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  ConnectorTemplateDefinition,
  ConnectorView,
  CustomServerView
} from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useTagStore } from '@/stores/tag-store'
import { ConnectorGlyph } from './connector-icons'
import { SettingsLoadNotice, SettingsSection, SettingsToggle } from './SettingsLayout'
import { SettingsSearchInput } from './SettingsSearchInput'
import { specialistsUsingConnector, type SpecialistUsage } from './specialist-resource-scope'
import { ResourceTagBadges, ResourceTagMenu, TagFilter } from './ResourceTagControls'
import { SkillUsageAgents } from './SkillUsageAgents'
import { ConnectorOAuthSignInDialog } from './ConnectorOAuthSignInDialog'
import { localizeCredentialError } from './credential-error-message'

// The connectors panel sub-view, driven by the settings navigation history. The detail and add pages
// are separate components owned by SettingsPage; this panel only renders the list + contact-email section.
export type ConnectorsView =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | {
      kind: 'add'
      transport: 'local' | 'remote'
      template?: ConnectorTemplateDefinition
      credentialView?: 'create'
    }
  | { kind: 'edit'; id: string; credentialView?: 'create' }
  | { kind: 'import' }
  | { kind: 'export'; id: string }

type GroupFilter = 'all' | 'featured' | 'directory' | 'custom'
const MAIN_AGENT_FILTER = '__main-agent__'

type ConnectorResourceRow<T extends { id: string; name: string; enabled: boolean }> = {
  resource: T
  usages: SpecialistUsage[]
}

// Keys rather than finished strings: the trigger and the option list both read from this map, so the
// label has one source and follows a language switch on the next render.
const FILTER_LABEL_KEYS = {
  all: 'All',
  featured: 'Featured',
  directory: 'Directory',
  custom: 'Custom'
} as const satisfies Record<GroupFilter, string>

const FILTER_ORDER: GroupFilter[] = ['all', 'featured', 'directory', 'custom']

const includesAgent = (
  specialistFilter: string,
  enabled: boolean,
  usages: readonly SpecialistUsage[]
): boolean => {
  if (specialistFilter === MAIN_AGENT_FILTER) return enabled
  return specialistFilter === 'all' || usages.some((usage) => usage.id === specialistFilter)
}

const requiresSignInBeforeEnable = (server: CustomServerView): boolean =>
  Boolean(
    server.oauth &&
    (!server.oauth.hasTokens || server.availability === 'unauthenticated') &&
    !server.enabled
  )

const cannotEnableCustomServer = (server: CustomServerView): boolean =>
  requiresSignInBeforeEnable(server) ||
  (!server.enabled && server.availability === 'credential_unavailable')

type ConnectorsPanelProps = {
  onNavigate: (view: ConnectorsView) => void
  onOpenTag?: (tagId: string) => void
  onOpenSpecialist?: (usage: SpecialistUsage) => void
  onOpenCredentials?: () => void
}

export function ConnectorsPanel({
  onNavigate,
  onOpenTag,
  onOpenSpecialist,
  onOpenCredentials
}: ConnectorsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const { t: tCommon } = useTranslation()
  const connectors = useSettingsStore((state) => state.connectors)
  const connectorsLoaded = useSettingsStore((state) => state.connectorsLoaded)
  const customServers = useSettingsStore((state) => state.customServers)
  const skillProjectionStatus = useSettingsStore((state) => state.skillProjectionStatus)
  const ncbi = useSettingsStore((state) => state.ncbi)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  const setConnectorEnabled = useSettingsStore((state) => state.setConnectorEnabled)
  const setCustomServerEnabled = useSettingsStore((state) => state.setCustomServerEnabled)
  const retryCustomServer = useSettingsStore((state) => state.retryCustomServer)
  const disconnectCustomServer = useSettingsStore((state) => state.disconnectCustomServer)
  const retryConnectorProjection = useSettingsStore((state) => state.retryConnectorProjection)
  const removeCustomServer = useSettingsStore((state) => state.removeCustomServer)
  const specialistItems = useSpecialistStore((state) => state.items)
  const loadSpecialists = useSpecialistStore((state) => state.load)

  const [filter, setFilter] = useState<GroupFilter>('all')
  const [specialistFilter, setSpecialistFilter] = useState('all')
  const [tagFilter, setTagFilter] = useState('all')
  const tagAssignments = useTagStore((state) => state.assignments)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<
    Partial<Record<'featured' | 'directory' | 'custom', boolean>>
  >({})
  const [retryingIds, setRetryingIds] = useState<Set<string>>(() => new Set())
  const [retryingProjection, setRetryingProjection] = useState(false)
  const [oauthSignInServer, setOAuthSignInServer] = useState<CustomServerView>()
  const [oauthConnectionServer, setOAuthConnectionServer] = useState<CustomServerView>()
  const [oauthConnectionBusy, setOAuthConnectionBusy] = useState(false)
  const [oauthConnectionError, setOAuthConnectionError] = useState<string | null>(null)
  const [removal, setRemoval] = useState<{
    server: CustomServerView
    specialistNames?: string[]
  } | null>(null)
  const [removing, setRemoving] = useState(false)
  const [checkingRemoval, setCheckingRemoval] = useState(false)
  const [removalError, setRemovalError] = useState<string | null>(null)
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'error'>(
    connectorsLoaded ? 'ready' : 'loading'
  )
  const [operationError, setOperationError] = useState<string | null>(null)
  const loadRequestRef = useRef(0)
  const removalCheckSequence = useRef(0)
  const removalCheckInFlight = useRef<number | undefined>(undefined)

  const loadCatalog = async (): Promise<void> => {
    const requestId = ++loadRequestRef.current
    setCatalogState('loading')
    try {
      await loadConnectors()
      if (loadRequestRef.current === requestId) setCatalogState('ready')
    } catch {
      if (loadRequestRef.current === requestId) setCatalogState('error')
    }
  }

  const retryCatalog = (): void => {
    void loadCatalog()
  }

  const disconnectOAuth = async (reauthenticate: boolean): Promise<void> => {
    if (!oauthConnectionServer || oauthConnectionBusy) return
    const server = oauthConnectionServer
    setOAuthConnectionBusy(true)
    setOAuthConnectionError(null)
    try {
      await disconnectCustomServer({ id: server.id })
      setOAuthConnectionServer(undefined)
      if (reauthenticate) {
        setOAuthSignInServer({
          ...server,
          enabled: false,
          oauth: server.oauth ? { ...server.oauth, hasTokens: false } : undefined
        })
      }
    } catch (error) {
      setOAuthConnectionError(localizeCredentialError(error, t, 'Failed to disconnect Connector.'))
    } finally {
      setOAuthConnectionBusy(false)
    }
  }

  useEffect(() => {
    const requestId = ++loadRequestRef.current
    void loadConnectors().then(
      () => {
        if (loadRequestRef.current === requestId) setCatalogState('ready')
      },
      () => {
        if (loadRequestRef.current === requestId) setCatalogState('error')
      }
    )
    return () => {
      loadRequestRef.current += 1
    }
  }, [loadConnectors])

  useEffect(() => {
    void loadSpecialists()
  }, [loadSpecialists])

  const specialistOptions = useMemo(
    () =>
      specialistItems
        .flatMap((item) =>
          item.kind === 'reviewer'
            ? []
            : [{ id: item.id, name: item.displayName?.trim() || item.name }]
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    [specialistItems]
  )

  const visibleConnectors = useMemo<ConnectorResourceRow<ConnectorView>[]>(() => {
    const term = query.trim().toLowerCase()
    return connectors.flatMap((connector) => {
      const usages = specialistsUsingConnector(specialistItems, connector)
      if (!includesAgent(specialistFilter, connector.enabled, usages)) return []
      if (
        tagFilter !== 'all' &&
        !tagAssignments.some(
          (assignment) =>
            assignment.tagId === tagFilter &&
            assignment.resourceType === 'catalog.connector' &&
            assignment.resourceId === connector.id
        )
      )
        return []
      if (
        term &&
        !connector.displayName.toLowerCase().includes(term) &&
        !connector.description.toLowerCase().includes(term)
      ) {
        return []
      }
      return [{ resource: connector, usages }]
    })
  }, [connectors, query, specialistFilter, specialistItems, tagAssignments, tagFilter])

  const visibleCustomServers = useMemo<ConnectorResourceRow<CustomServerView>[]>(() => {
    const term = query.trim().toLowerCase()
    return customServers.flatMap((server) => {
      const usages = specialistsUsingConnector(specialistItems, server)
      if (!includesAgent(specialistFilter, server.enabled, usages)) return []
      if (
        tagFilter !== 'all' &&
        !tagAssignments.some(
          (assignment) =>
            assignment.tagId === tagFilter &&
            assignment.resourceType === 'catalog.connector' &&
            assignment.resourceId === server.id
        )
      )
        return []
      if (
        term &&
        !server.displayName.toLowerCase().includes(term) &&
        !server.name.toLowerCase().includes(term) &&
        !(server.description?.toLowerCase().includes(term) ?? false)
      ) {
        return []
      }
      return [{ resource: server, usages }]
    })
  }, [customServers, query, specialistFilter, specialistItems, tagAssignments, tagFilter])

  const retry = async (id: string): Promise<void> => {
    setRetryingIds((current) => new Set(current).add(id))
    setOperationError(null)
    try {
      await retryCustomServer(id)
    } catch {
      setOperationError('Could not reconnect this Connector.')
    } finally {
      setRetryingIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  const retrySkillProjection = async (): Promise<void> => {
    if (retryingProjection) return
    setRetryingProjection(true)
    setOperationError(null)
    try {
      await retryConnectorProjection()
    } catch {
      setOperationError('Could not refresh the Agent Skill documents for Connectors.')
    } finally {
      setRetryingProjection(false)
    }
  }

  const saveToggle = async (command: () => Promise<void>): Promise<void> => {
    setOperationError(null)
    try {
      await command()
    } catch {
      setOperationError(t('Could not save this setting. The previous value was restored.'))
    }
  }

  const requestRemoval = async (server: CustomServerView): Promise<void> => {
    if (removalCheckInFlight.current !== undefined) return
    const requestId = ++removalCheckSequence.current
    removalCheckInFlight.current = requestId
    setCheckingRemoval(true)
    setRemovalError(null)
    try {
      await useSpecialistStore.getState().load()
      if (removalCheckSequence.current !== requestId) return
      setRemoval({
        server,
        specialistNames: specialistsUsingConnector(useSpecialistStore.getState().items, server).map(
          (usage) => usage.name
        )
      })
    } catch {
      if (removalCheckSequence.current !== requestId) return
      setRemoval({ server })
    } finally {
      if (removalCheckInFlight.current === requestId) {
        removalCheckInFlight.current = undefined
        setCheckingRemoval(false)
      }
    }
  }

  const cancelRemoval = (): void => {
    removalCheckSequence.current += 1
    removalCheckInFlight.current = undefined
    setCheckingRemoval(false)
    setRemoval(null)
    setRemovalError(null)
  }

  const confirmRemoval = async (): Promise<void> => {
    if (!removal || removal.specialistNames === undefined || removing || checkingRemoval) return
    setRemoving(true)
    setRemovalError(null)
    try {
      await removeCustomServer(removal.server.id)
      setRemoval(null)
    } catch {
      setRemovalError('Could not remove this Connector.')
    } finally {
      setRemoving(false)
    }
  }

  const showFeatured = filter === 'all' || filter === 'featured'
  const showDirectory = filter === 'all' || filter === 'directory'
  const showCustom = filter === 'all' || filter === 'custom'
  const featuredConnectors = visibleConnectors.filter(
    ({ resource }) => (resource.group ?? 'featured') === 'featured'
  )
  const directoryConnectors = visibleConnectors.filter(
    ({ resource }) => resource.group === 'directory'
  )
  const customExpanded = !collapsed.custom
  const hasCachedCatalog = connectors.length > 0 || customServers.length > 0

  // Renders one collapsible bundled-connector section (Featured / Directory) with its rows.
  const connectorGroup = (
    groupKey: 'featured' | 'directory',
    label: string,
    subtitle: string,
    rows: ConnectorResourceRow<ConnectorView>[]
  ): React.JSX.Element => {
    const expanded = !collapsed[groupKey]

    return (
      <div>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setCollapsed((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }))}
          className="flex w-full flex-col items-start gap-0.5 text-left"
        >
          <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
            {label}
            <ChevronDown
              className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${
                expanded ? '' : '-rotate-90'
              }`}
              aria-hidden="true"
            />
          </span>
          <span className="text-xs text-muted-foreground">{subtitle}</span>
        </button>

        {expanded ? (
          rows.length > 0 ? (
            <ul className="mt-2 flex flex-col">
              {rows.map(({ resource: connector, usages }) => {
                return (
                  <li
                    key={connector.id}
                    data-slot="settings-list-row"
                    className="flex min-h-14 flex-wrap items-center gap-2 py-2.5"
                  >
                    <ConnectorGlyph size={24} />
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => onNavigate({ kind: 'detail', id: connector.id })}
                        className="block w-full min-w-0 text-left"
                      >
                        <span className="block truncate text-sm text-foreground">
                          {connector.displayName}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {connector.description}
                        </span>
                      </button>
                      <div
                        className="mt-0.5 flex min-w-0 items-center gap-2"
                        data-connector-metadata={connector.id}
                      >
                        {connector.enabled || usages.length > 0 ? (
                          <span className="inline-flex shrink-0 items-center gap-1">
                            <span
                              data-slot="skill-usage-agents-label"
                              className="text-xs text-muted-foreground"
                            >
                              {t('Used by')}
                            </span>
                            <SkillUsageAgents
                              resourceKind="Connector"
                              mainEnabled={connector.enabled}
                              usages={usages}
                              onOpenSpecialist={onOpenSpecialist}
                            />
                          </span>
                        ) : null}
                        <ResourceTagBadges
                          reference={{
                            resourceType: 'catalog.connector',
                            resourceId: connector.id
                          }}
                          onOpenTag={onOpenTag}
                        />
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <ResourceTagMenu
                        reference={{ resourceType: 'catalog.connector', resourceId: connector.id }}
                      />
                      <SettingsToggle
                        enabled={connector.enabled}
                        aria-label={t('Toggle {{name}}', { name: connector.displayName })}
                        title={
                          connector.enabled
                            ? t('Available to Main Agent')
                            : t('Unavailable to Main Agent')
                        }
                        onToggle={() =>
                          void saveToggle(async () => {
                            await setConnectorEnabled(connector.id, !connector.enabled)
                          })
                        }
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="mt-2 py-2 text-xs text-muted-foreground">
              {t('No connectors match your search.')}
            </p>
          )
        ) : null}
      </div>
    )
  }

  if (!hasCachedCatalog && catalogState !== 'ready') {
    return (
      <div className="p-5">
        <SettingsLoadNotice
          state={catalogState === 'error' ? 'error' : 'loading'}
          loadingLabel={t('Loading Connectors…')}
          errorMessage={t('Open Science could not load Connectors.')}
          onRetry={retryCatalog}
        />
      </div>
    )
  }

  return (
    <div className="p-5">
      {catalogState === 'error' ? (
        <SettingsLoadNotice
          state="error"
          loadingLabel={t('Loading Connectors…')}
          errorMessage={t('Open Science could not load Connectors.')}
          onRetry={retryCatalog}
          className="mb-4"
        />
      ) : null}
      <SettingsSection
        title={t('Contact email')}
        description={t(
          'When allowed, shared with research data services that ask for a contact email (such as those run by NCBI, EBI, and OurResearch) on requests made on your behalf.'
        )}
        className="mb-4"
      >
        <div className="mt-3 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            {ncbi.contactEmail ?? t('Not set')}
          </span>
          <Button type="button" variant="outline" onClick={onOpenCredentials}>
            {t('Manage credentials')}
          </Button>
        </div>
      </SettingsSection>

      <div
        data-slot="connectors-filter-bar"
        className="mb-4 flex flex-wrap items-center gap-2"
        data-testid="connectors-toolbar"
      >
        <Select value={filter} onValueChange={(value) => setFilter(value as GroupFilter)}>
          <SelectTrigger aria-label={t('Filter connectors by group')} className="w-36">
            <span>{t(FILTER_LABEL_KEYS[filter])}</span>
          </SelectTrigger>
          <SelectContent>
            {FILTER_ORDER.map((value) => (
              <SelectItem key={value} value={value}>
                {t(FILTER_LABEL_KEYS[value])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={specialistFilter} onValueChange={setSpecialistFilter}>
          <SelectTrigger aria-label={t('Filter Connectors by agent')} className="w-48">
            <span>
              {specialistFilter === 'all'
                ? t('All Agents/Specialists')
                : specialistFilter === MAIN_AGENT_FILTER
                  ? t('Main', { defaultValue: 'Main Agent' })
                  : specialistOptions.find((item) => item.id === specialistFilter)?.name}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('All Agents/Specialists')}</SelectItem>
            <SelectItem value={MAIN_AGENT_FILTER}>
              {t('Main', { defaultValue: 'Main Agent' })}
            </SelectItem>
            {specialistOptions.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TagFilter resourceType="catalog.connector" value={tagFilter} onChange={setTagFilter} />
        <SettingsSearchInput
          aria-label={t('Search connectors')}
          containerClassName="min-w-48 flex-1"
          placeholder={t('Search connectors…')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="ml-auto shrink-0">
              <Plus data-icon="inline-start" aria-hidden="true" />
              {t('Add connector')}
              <ChevronDown data-icon="inline-end" className="opacity-70" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="gap-2.5"
              onSelect={() => onNavigate({ kind: 'add', transport: 'local' })}
            >
              <Terminal className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>{t('Local command')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('Run an MCP server via a command')}
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="gap-2.5"
              onSelect={() => onNavigate({ kind: 'add', transport: 'remote' })}
            >
              <Globe className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>{t('Remote server')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('Connect to an MCP server URL')}
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'import' })}>
              <FileUp className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>{tCommon('Import configuration')}</span>
                <span className="text-xs text-muted-foreground">
                  {tCommon('Import a Connector or MCP client configuration')}
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-col gap-4">
        {skillProjectionStatus === 'degraded' ? (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border border-status-warning-foreground/30 bg-status-warning-surface/40 px-3 py-2 text-xs text-status-warning-foreground dark:border-status-warning-dark-foreground/30 dark:bg-status-warning-dark-surface/20 dark:text-status-warning-dark-foreground"
            role="alert"
          >
            <span className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                {t(
                  'Connector settings are saved, but their Agent Skill documents are out of date.'
                )}
              </span>
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={retryingProjection}
              onClick={() => void retrySkillProjection()}
            >
              {retryingProjection ? t('Checking…') : t('Retry')}
            </Button>
          </div>
        ) : null}
        {operationError ? (
          <div
            className="flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {operationError === 'Could not reconnect this Connector.'
                ? t('Could not reconnect this Connector.')
                : operationError === 'Could not refresh the Agent Skill documents for Connectors.'
                  ? t('Could not refresh the Agent Skill documents for Connectors.')
                  : t(operationError)}
            </span>
          </div>
        ) : null}
        {showFeatured
          ? connectorGroup(
              'featured',
              t('Featured'),
              t('Research connectors from Anthropic'),
              featuredConnectors
            )
          : null}

        {showDirectory
          ? connectorGroup(
              'directory',
              t('Directory'),
              t('Syncs with the Claude Connectors Directory'),
              directoryConnectors
            )
          : null}

        {showCustom ? (
          <div>
            <button
              type="button"
              aria-expanded={customExpanded}
              onClick={() => setCollapsed((prev) => ({ ...prev, custom: !prev.custom }))}
              className="flex w-full flex-col items-start gap-0.5 text-left"
            >
              <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
                {t('Custom')}
                <ChevronDown
                  className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${
                    customExpanded ? '' : '-rotate-90'
                  }`}
                  aria-hidden="true"
                />
              </span>
              <span className="text-xs text-muted-foreground">{t('Connectors you added')}</span>
            </button>

            {customExpanded ? (
              visibleCustomServers.length > 0 ? (
                <ul className="mt-2 flex flex-col">
                  {visibleCustomServers.map(({ resource: server, usages }) => {
                    return (
                      <li
                        key={server.id}
                        data-slot="settings-list-row"
                        className="flex min-h-14 flex-wrap items-center gap-2 py-2.5"
                      >
                        <ConnectorGlyph size={24} />
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            onClick={() => onNavigate({ kind: 'edit', id: server.id })}
                            className="block w-full min-w-0 text-left"
                          >
                            <span className="block truncate text-sm text-foreground">
                              {server.displayName}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {server.name}
                              {server.description ? ` · ${server.description}` : ''}
                            </span>
                          </button>
                          <div
                            className="mt-0.5 flex min-w-0 items-center gap-2"
                            data-connector-metadata={server.id}
                          >
                            <span
                              className={`shrink-0 text-xs ${
                                server.availability &&
                                !server.checking &&
                                !retryingIds.has(server.id)
                                  ? 'text-destructive'
                                  : 'text-muted-foreground'
                              }`}
                            >
                              {retryingIds.has(server.id)
                                ? t('Checking…')
                                : server.checking
                                  ? t('Checking…')
                                  : server.availability === 'unavailable'
                                    ? t('Unavailable')
                                    : server.availability === 'credential_unavailable'
                                      ? t('Credentials unavailable')
                                      : server.availability === 'unauthenticated'
                                        ? t('Sign-in required')
                                        : server.enabled
                                          ? t('Connected')
                                          : t('Disabled')}
                            </span>
                            {server.enabled || usages.length > 0 ? (
                              <span className="inline-flex shrink-0 items-center gap-1">
                                <span
                                  data-slot="skill-usage-agents-label"
                                  className="text-xs text-muted-foreground"
                                >
                                  {t('Used by')}
                                </span>
                                <SkillUsageAgents
                                  resourceKind="Connector"
                                  mainEnabled={server.enabled}
                                  usages={usages}
                                  onOpenSpecialist={onOpenSpecialist}
                                />
                              </span>
                            ) : null}
                            <ResourceTagBadges
                              reference={{
                                resourceType: 'catalog.connector',
                                resourceId: server.id
                              }}
                              onOpenTag={onOpenTag}
                            />
                          </div>
                        </div>
                        {server.availability === 'unavailable' && server.enabled ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={retryingIds.has(server.id)}
                            onClick={() => void retry(server.id)}
                          >
                            {retryingIds.has(server.id) ? t('Checking…') : t('Retry')}
                          </Button>
                        ) : null}
                        {(server.availability === 'unauthenticated' && !server.oauth) ||
                        server.availability === 'credential_unavailable' ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => onNavigate({ kind: 'edit', id: server.id })}
                          >
                            {t('Configure')}
                          </Button>
                        ) : null}
                        {server.oauth && server.availability !== 'credential_unavailable' ? (
                          <Button
                            type="button"
                            size="sm"
                            variant={
                              server.oauth.hasTokens && server.availability !== 'unauthenticated'
                                ? 'outline'
                                : 'default'
                            }
                            onClick={() =>
                              server.oauth?.hasTokens && server.availability !== 'unauthenticated'
                                ? setOAuthConnectionServer(server)
                                : setOAuthSignInServer(server)
                            }
                          >
                            {server.oauth.hasTokens && server.availability !== 'unauthenticated'
                              ? t('Connected')
                              : server.availability === 'unauthenticated'
                                ? t('Retry')
                                : t('Sign in')}
                          </Button>
                        ) : null}
                        <ResourceTagMenu
                          reference={{ resourceType: 'catalog.connector', resourceId: server.id }}
                        />
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={t('Actions for {{name}}', { name: server.displayName })}
                            >
                              <ChevronDown aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              className="gap-2 text-xs"
                              onSelect={() => onNavigate({ kind: 'export', id: server.id })}
                            >
                              <Download className="size-3.5" aria-hidden="true" />
                              {t('Export')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2 text-xs"
                              onSelect={() => onNavigate({ kind: 'edit', id: server.id })}
                            >
                              <Pencil className="size-3.5" aria-hidden="true" />
                              {t('Edit')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="gap-2 text-xs text-destructive"
                              onSelect={() => void requestRemoval(server)}
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" />
                              {t('Remove')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <div className="flex shrink-0 items-center gap-2">
                          <SettingsToggle
                            enabled={server.enabled}
                            aria-label={t('Toggle {{name}}', { name: server.displayName })}
                            aria-disabled={cannotEnableCustomServer(server) || undefined}
                            className={
                              cannotEnableCustomServer(server)
                                ? 'cursor-not-allowed opacity-50'
                                : undefined
                            }
                            title={
                              requiresSignInBeforeEnable(server)
                                ? t('Sign in before enabling this Connector')
                                : server.enabled
                                  ? t('Available to Main Agent')
                                  : t('Unavailable to Main Agent')
                            }
                            onToggle={() => {
                              if (cannotEnableCustomServer(server)) return
                              void saveToggle(async () => {
                                await setCustomServerEnabled(server.id, !server.enabled)
                              })
                            }}
                          />
                        </div>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="mt-2 py-2 text-xs text-muted-foreground">
                  {t('Add a custom connector to connect your own server.')}
                </p>
              )
            ) : null}
          </div>
        ) : null}
      </div>

      <AlertDialog.Root
        open={removal !== null}
        onOpenChange={(open) => {
          if (!open && !removing) cancelRemoval()
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <AlertDialog.Title className={dialogTitleClassName}>
                  {t('Remove “{{name}}”?', { name: removal?.server.displayName ?? '' })}
                </AlertDialog.Title>
              </div>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Close')}
                  className={dialogCloseButtonClassName}
                  disabled={removing}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </AlertDialog.Cancel>
            </div>

            <div className={dialogBodyClassName}>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                {tCommon(
                  'This removes the Connector configuration and credentials from this app. Existing conversation history is kept.'
                )}
              </AlertDialog.Description>
              {removal?.specialistNames?.length ? (
                <div className="mt-4 rounded-lg border border-warning-100/50 bg-warning-100/10 px-3 py-2.5 text-sm text-foreground">
                  <p>
                    {removal.specialistNames.length === 1
                      ? t(
                          'This Connector is used by {{count}} Specialist. Its saved references will become unavailable.',
                          { count: removal.specialistNames.length }
                        )
                      : t(
                          'This Connector is used by {{count}} Specialists. Their saved references will become unavailable.',
                          { count: removal.specialistNames.length }
                        )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {removal.specialistNames.join(', ')}
                  </p>
                </div>
              ) : removal && removal.specialistNames === undefined ? (
                <div className="mt-4 rounded-lg border border-warning-100/50 bg-warning-100/10 px-3 py-2.5 text-sm text-foreground">
                  <p>
                    {tCommon(
                      'Specialist references could not be checked. Retry before removing this Connector.'
                    )}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    disabled={removing || checkingRemoval}
                    onClick={() => void requestRemoval(removal.server)}
                  >
                    {checkingRemoval ? tCommon('Checking…') : tCommon('Retry')}
                  </Button>
                </div>
              ) : null}
              {removalError ? (
                <div
                  role="alert"
                  className="mt-4 flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>{t('Could not remove this Connector.')}</span>
                </div>
              ) : null}
            </div>

            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className={dialogCancelButtonClassName}
                  disabled={removing}
                >
                  {tCommon('Cancel')}
                </Button>
              </AlertDialog.Cancel>
              <Button
                type="button"
                variant="destructive"
                disabled={removing || checkingRemoval || removal?.specialistNames === undefined}
                onClick={() => void confirmRemoval()}
              >
                {removing ? t('Removing…') : t('Remove Connector')}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      <AlertDialog.Root
        open={oauthConnectionServer !== undefined}
        onOpenChange={(open) => {
          if (!open && !oauthConnectionBusy) {
            setOAuthConnectionServer(undefined)
            setOAuthConnectionError(null)
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <AlertDialog.Title className={dialogTitleClassName}>
                {t('Manage “{{name}}” connection', {
                  name: oauthConnectionServer?.displayName ?? ''
                })}
              </AlertDialog.Title>
            </div>
            <div className={dialogBodyClassName}>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                {oauthConnectionServer?.oauth?.sharedCredential
                  ? t(
                      'Disconnect removes the shared OAuth tokens from this app and disables every Connector using this credential. It does not revoke access on the service.'
                    )
                  : t(
                      'Disconnect removes OAuth tokens from this app and disables the Connector. It does not revoke access on the service.'
                    )}
              </AlertDialog.Description>
              {oauthConnectionError ? (
                <p className="mt-3 text-sm text-status-failure">{oauthConnectionError}</p>
              ) : null}
            </div>
            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="ghost" disabled={oauthConnectionBusy}>
                  {tCommon('Cancel')}
                </Button>
              </AlertDialog.Cancel>
              <Button
                type="button"
                variant="outline"
                disabled={oauthConnectionBusy}
                onClick={() => void disconnectOAuth(false)}
              >
                {t('Disconnect')}
              </Button>
              <Button
                type="button"
                disabled={oauthConnectionBusy}
                onClick={() => void disconnectOAuth(true)}
              >
                {t('Reauthenticate')}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      {oauthSignInServer ? (
        <ConnectorOAuthSignInDialog
          server={oauthSignInServer}
          onAuthenticated={() => setOAuthSignInServer(undefined)}
          onFinish={() => setOAuthSignInServer(undefined)}
        />
      ) : null}
    </div>
  )
}
