import { useResourceSelection, useStickyResourceFilters } from './use-resource-selection'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { InlineNotice } from '@/components/ui/inline-notice'
import { connectorDescription } from './connector-copy'
import { ErrorNotice } from '@/components/error-notice'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V3
 * component: Connector catalog · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: semantic foreground / surface tokens · slop: pass (component/static)
 * responsive: wrapping toolbar and rows · visual gates: pending user review
 */
import {
  ChevronDown,
  Download,
  FileUp,
  Globe,
  ChevronRight,
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
import { Badge } from '@/components/ui/badge'
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
import { SettingsLoadNotice } from './SettingsLayout'
import { SettingsSearchInput } from './SettingsSearchInput'
import { specialistsUsingConnector, type SpecialistUsage } from './specialist-resource-scope'
import { ResourceTagBadges, ResourceTagMenu, TagFilter } from './ResourceTagControls'
import { SkillUsageAgents } from './SkillUsageAgents'
import { ResourceAssignmentControls } from './ResourceAssignmentControls'
import {
  ResourceCategorySelection,
  ResourceSelectionBar,
  ResourceSelectionCheckbox
} from './ResourceCatalogSelection'
import { ConnectorOAuthSignInDialog } from './ConnectorOAuthSignInDialog'
import { cannotEnableCustomServer } from './connector-enablement'
import { localizeCredentialError } from './credential-error-message'

// The connectors panel sub-view, driven by the settings navigation history. The detail and add pages
// are separate components owned by SettingsPage; this panel only renders the catalog list.
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

type ConnectorsPanelProps = {
  onNavigate: (view: ConnectorsView) => void
  onOpenTag?: (tagId: string) => void
  onOpenSpecialist?: (usage: SpecialistUsage) => void
}

export function ConnectorsPanel({
  onNavigate,
  onOpenTag,
  onOpenSpecialist
}: ConnectorsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const { t: tCommon } = useTranslation()
  const connectors = useSettingsStore((state) => state.connectors)
  const connectorsLoaded = useSettingsStore((state) => state.connectorsLoaded)
  const customServers = useSettingsStore((state) => state.customServers)
  const skillProjectionStatus = useSettingsStore((state) => state.skillProjectionStatus)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  const setConnectorEnabled = useSettingsStore((state) => state.setConnectorEnabled)
  const setCustomServerEnabled = useSettingsStore((state) => state.setCustomServerEnabled)
  const retryCustomServer = useSettingsStore((state) => state.retryCustomServer)
  const disconnectCustomServer = useSettingsStore((state) => state.disconnectCustomServer)
  const retryConnectorProjection = useSettingsStore((state) => state.retryConnectorProjection)
  const removeCustomServer = useSettingsStore((state) => state.removeCustomServer)
  const specialistItems = useSpecialistStore((state) => state.items)
  const loadSpecialists = useSpecialistStore((state) => state.load)

  const { panelRef, filterRef } = useStickyResourceFilters()
  const selection = useResourceSelection({
    resources: [
      ...connectors.map((connector) => ({
        id: connector.id,
        name: connector.name,
        displayName: connector.displayName,
        kind: 'connector' as const,
        group: connector.group ?? 'featured',
        mainEnabled: connector.enabled
      })),
      ...customServers.map((server) => ({
        id: server.id,
        name: server.name,
        displayName: server.displayName,
        kind: 'connector' as const,
        group: 'custom',
        mainEnabled: server.enabled,
        deletable: true
      }))
    ],
    onSetMain: async (id, enabled) => {
      if (useSettingsStore.getState().customServers.some((server) => server.id === id))
        await setCustomServerEnabled(id, enabled)
      else await setConnectorEnabled(id, enabled)
    },
    onDelete: async (id) => {
      if (!useSettingsStore.getState().customServers.some((server) => server.id === id))
        throw new Error('Connector unavailable')
      await removeCustomServer(id)
    }
  })

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
  const dialogOAuthServer = useRetainedDialogValue(oauthConnectionServer)
  const [oauthConnectionBusy, setOAuthConnectionBusy] = useState(false)
  const [oauthConnectionError, setOAuthConnectionError] = useState<string | null>(null)
  const [removal, setRemoval] = useState<{
    server: CustomServerView
    specialistNames?: string[]
  } | null>(null)
  const dialogRemoval = useRetainedDialogValue(removal)
  const [removing, setRemoving] = useState(false)
  const [checkingRemoval, setCheckingRemoval] = useState(false)
  const [removalError, setRemovalError] = useState<string | null>(null)
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'error'>(
    connectorsLoaded ? 'ready' : 'loading'
  )
  const [operationError, setOperationError] = useState<string | null>(null)
  const [accessError, setAccessError] = useState(false)
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
        !connectorDescription(connector, t).toLowerCase().includes(term)
      ) {
        return []
      }
      return [{ resource: connector, usages }]
    })
  }, [connectors, query, specialistFilter, specialistItems, tagAssignments, tagFilter, t])

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
      <div data-slot="connectors-source-group" data-source={groupKey}>
        <div className="sticky top-[var(--resource-filter-height,0px)] z-10 -mx-5 flex items-center justify-between gap-3 bg-card px-5 py-2">
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
          <ResourceCategorySelection
            selection={selection}
            group={groupKey}
            label={label}
            ids={rows.map(({ resource }) => resource.id)}
          />
        </div>

        {expanded ? (
          rows.length > 0 ? (
            <ul className="mt-2 flex flex-col">
              {rows.map(({ resource: connector, usages }) => {
                return (
                  <li
                    key={connector.id}
                    data-slot="settings-list-row"
                    onClick={(event) => {
                      // Keep nested controls and portal events out of row navigation.
                      // Row styles preserve pointer hits on disabled buttons instead of passing through.
                      const target = event.target
                      if (
                        event.defaultPrevented ||
                        !(target instanceof Element) ||
                        !event.currentTarget.contains(target) ||
                        target.closest('button, a, input, select, textarea, [role="button"]')
                      )
                        return
                      onNavigate({ kind: 'detail', id: connector.id })
                    }}
                    className="group/row [&_button:disabled]:pointer-events-auto cursor-pointer -mx-2 flex min-h-14 flex-wrap items-center gap-2 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/50 focus-within:bg-muted/50"
                  >
                    <ResourceSelectionCheckbox
                      selection={selection}
                      resource={{
                        id: connector.id,
                        name: connector.displayName,
                        kind: 'connector',
                        group: groupKey,
                        mainEnabled: connector.enabled
                      }}
                    />
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
                          {connectorDescription(connector, t)}
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
                      <ResourceAssignmentControls
                        onOpenSpecialist={onOpenSpecialist}
                        resource={{
                          id: connector.id,
                          name: connector.name,
                          displayName: connector.displayName,
                          kind: 'connector',
                          group: groupKey,
                          mainEnabled: connector.enabled
                        }}
                        disabled={selection.locked}
                        onErrorChange={setAccessError}
                        onSetMain={(enabled) => setConnectorEnabled(connector.id, enabled)}
                      />
                      <button
                        type="button"
                        aria-label={t('View details for {{name}}', { name: connector.displayName })}
                        onClick={() => onNavigate({ kind: 'detail', id: connector.id })}
                        className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:outline-2 focus-visible:outline-ring [@media(pointer:coarse)]:opacity-100"
                      >
                        <ChevronRight className="size-4" aria-hidden="true" />
                      </button>
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
          errorMessage={t('Open-Science could not load Connectors.')}
          onRetry={retryCatalog}
        />
      </div>
    )
  }

  return (
    <div ref={panelRef} className="p-5">
      {catalogState === 'error' ? (
        <SettingsLoadNotice
          state="error"
          loadingLabel={t('Loading Connectors…')}
          errorMessage={t('Open-Science could not load Connectors.')}
          onRetry={retryCatalog}
          className="mb-4"
        />
      ) : null}
      <div
        className="mb-4 flex flex-wrap items-center justify-between gap-3"
        data-slot="connectors-header"
      >
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {t('Installed')}
          <Badge variant="outline" className="tabular-nums">
            {connectors.length + customServers.length}
          </Badge>
        </h3>
        <div data-slot="connectors-action-bar" className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="shrink-0" data-settings-anchor="connectors.add">
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
      </div>
      <div
        ref={filterRef}
        data-slot="connectors-filter-bar"
        className="sticky top-0 z-20 -mx-5 mb-2 flex flex-wrap items-center gap-2 border-b border-border/60 bg-card px-5 py-3"
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
      </div>

      <div className="flex flex-col gap-4">
        {skillProjectionStatus === 'degraded' ? (
          <ErrorNotice
            role="alert"
            description={t(
              'Connector settings are saved, but their Agent Skill documents are out of date.'
            )}
            primaryButton={{
              label: retryingProjection ? t('Checking…') : t('Retry'),
              loading: retryingProjection,
              onClick: () => void retrySkillProjection()
            }}
          />
        ) : null}
        {accessError ? (
          <ErrorNotice
            inline
            role="alert"
            tone="amber"
            className="mb-3"
            description={t('Could not update resource access. Refresh and try again.')}
          />
        ) : null}
        {operationError ? (
          <ErrorNotice
            inline
            role="alert"
            description={
              operationError === 'Could not reconnect this Connector.'
                ? t('Could not reconnect this Connector.')
                : operationError === 'Could not refresh the Agent Skill documents for Connectors.'
                  ? t('Could not refresh the Agent Skill documents for Connectors.')
                  : t(operationError)
            }
          />
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
          <div data-slot="connectors-source-group" data-source="custom">
            <div className="sticky top-[var(--resource-filter-height,0px)] z-10 -mx-5 flex items-center justify-between gap-3 bg-card px-5 py-2">
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
              <ResourceCategorySelection
                selection={selection}
                group="custom"
                label={t('Custom')}
                ids={visibleCustomServers.map(({ resource }) => resource.id)}
              />
            </div>

            {customExpanded ? (
              visibleCustomServers.length > 0 ? (
                <ul className="mt-2 flex flex-col">
                  {visibleCustomServers.map(({ resource: server, usages }) => {
                    return (
                      <li
                        key={server.id}
                        data-slot="settings-list-row"
                        onClick={(event) => {
                          // Keep nested controls and portal events out of row navigation.
                          // Row styles preserve pointer hits on disabled buttons instead of passing through.
                          const target = event.target
                          if (
                            event.defaultPrevented ||
                            !(target instanceof Element) ||
                            !event.currentTarget.contains(target) ||
                            target.closest('button, a, input, select, textarea, [role="button"]')
                          )
                            return
                          onNavigate({ kind: 'edit', id: server.id })
                        }}
                        className="group/row [&_button:disabled]:pointer-events-auto cursor-pointer -mx-2 flex min-h-14 flex-wrap items-center gap-2 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/50 focus-within:bg-muted/50"
                      >
                        <ResourceSelectionCheckbox
                          selection={selection}
                          resource={{
                            id: server.id,
                            name: server.displayName,
                            kind: 'connector',
                            group: 'custom',
                            mainEnabled: server.enabled
                          }}
                        />
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
                          <ResourceAssignmentControls
                            onOpenSpecialist={onOpenSpecialist}
                            resource={{
                              id: server.id,
                              name: server.name,
                              displayName: server.displayName,
                              kind: 'connector',
                              group: 'custom',
                              mainEnabled: server.enabled
                            }}
                            disabled={selection.locked}
                            onErrorChange={setAccessError}
                            mainBlocked={cannotEnableCustomServer(server)}
                            onSetMain={(enabled) => setCustomServerEnabled(server.id, enabled)}
                          />
                          <button
                            type="button"
                            aria-label={t('View details for {{name}}', {
                              name: server.displayName
                            })}
                            onClick={() => onNavigate({ kind: 'edit', id: server.id })}
                            className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:outline-2 focus-visible:outline-ring [@media(pointer:coarse)]:opacity-100"
                          >
                            <ChevronRight className="size-4" aria-hidden="true" />
                          </button>
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

      <ResourceSelectionBar
        selection={selection}
        visibleIds={[
          ...(showFeatured ? featuredConnectors.map(({ resource }) => resource.id) : []),
          ...(showDirectory ? directoryConnectors.map(({ resource }) => resource.id) : []),
          ...(showCustom ? visibleCustomServers.map(({ resource }) => resource.id) : [])
        ]}
      />
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
                  {t('Remove “{{name}}”?', { name: dialogRemoval?.server.displayName ?? '' })}
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
              {dialogRemoval?.specialistNames?.length ? (
                <InlineNotice className="mt-4">
                  <p>
                    {dialogRemoval.specialistNames.length === 1
                      ? t(
                          'This Connector is used by {{count}} Specialist. Its saved references will become unavailable.',
                          { count: dialogRemoval.specialistNames.length }
                        )
                      : t(
                          'This Connector is used by {{count}} Specialists. Their saved references will become unavailable.',
                          { count: dialogRemoval.specialistNames.length }
                        )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {dialogRemoval.specialistNames.join(', ')}
                  </p>
                </InlineNotice>
              ) : dialogRemoval && dialogRemoval.specialistNames === undefined ? (
                <InlineNotice className="mt-4">
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
                    onClick={() => {
                      if (removal) void requestRemoval(removal.server)
                    }}
                  >
                    {checkingRemoval ? tCommon('Checking…') : tCommon('Retry')}
                  </Button>
                </InlineNotice>
              ) : null}
              {removalError ? (
                <ErrorNotice
                  inline
                  role="alert"
                  tone="amber"
                  className="mt-4"
                  description={t('Could not remove this Connector.')}
                />
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
                disabled={
                  removing || checkingRemoval || dialogRemoval?.specialistNames === undefined
                }
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
                  name: dialogOAuthServer?.displayName ?? ''
                })}
              </AlertDialog.Title>
            </div>
            <div className={dialogBodyClassName}>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                {dialogOAuthServer?.oauth?.sharedCredential
                  ? t(
                      'Disconnect removes the shared OAuth tokens from this app and disables every Connector using this credential. It does not revoke access on the service.'
                    )
                  : t(
                      'Disconnect removes OAuth tokens from this app and disables the Connector. It does not revoke access on the service.'
                    )}
              </AlertDialog.Description>
              {oauthConnectionError ? (
                <InlineNotice level="error" className="mt-3" role="alert">
                  {oauthConnectionError}
                </InlineNotice>
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
