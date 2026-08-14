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
import { useEffect, useMemo, useState } from 'react'

import type { SpecialistListItem } from '../../../../shared/specialist'
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
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { ConnectorGlyph } from './connector-icons'
import { SettingsIconAction, SettingsSection, SettingsToggle } from './SettingsLayout'
import { SettingsSearchInput } from './SettingsSearchInput'

// The connectors panel sub-view, driven by the settings navigation history. The detail and add pages
// are separate components owned by SettingsPage; this panel only renders the list + contact-email section.
export type ConnectorsView =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | {
      kind: 'add'
      transport: 'local' | 'remote'
      template?: ConnectorTemplateDefinition
    }
  | { kind: 'edit'; id: string }
  | { kind: 'import' }
  | { kind: 'export'; id: string }

type GroupFilter = 'all' | 'featured' | 'directory' | 'custom'

const FILTER_LABELS: Record<GroupFilter, string> = {
  all: 'All',
  featured: 'Featured',
  directory: 'Directory',
  custom: 'Custom'
}

const specialistNamesUsingConnector = (
  items: SpecialistListItem[],
  server: Pick<CustomServerView, 'id' | 'name'>
): string[] => {
  return items
    .flatMap((item) => {
      if (item.kind === 'reviewer') return []
      const ids =
        item.capabilityMode === 'full'
          ? item.fullAccess.excludedConnectorIds
          : item.selectedCapabilities.connectorIds
      const matches = (id: string): boolean => id === server.id || id === server.name
      const usesConnector = item.capabilityMode === 'full' ? !ids.some(matches) : ids.some(matches)
      return usesConnector ? [item.displayName?.trim() || item.name] : []
    })
    .sort((a, b) => a.localeCompare(b))
}

const requiresSignInBeforeEnable = (server: CustomServerView): boolean =>
  Boolean(
    server.oauth &&
    (!server.oauth.hasTokens || server.availability === 'unauthenticated') &&
    !server.enabled
  )

type ConnectorsPanelProps = {
  onNavigate: (view: ConnectorsView) => void
}

export function ConnectorsPanel({ onNavigate }: ConnectorsPanelProps): React.JSX.Element {
  const connectors = useSettingsStore((state) => state.connectors)
  const customServers = useSettingsStore((state) => state.customServers)
  const ncbi = useSettingsStore((state) => state.ncbi)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  const setConnectorEnabled = useSettingsStore((state) => state.setConnectorEnabled)
  const setCustomServerEnabled = useSettingsStore((state) => state.setCustomServerEnabled)
  const retryCustomServer = useSettingsStore((state) => state.retryCustomServer)
  const removeCustomServer = useSettingsStore((state) => state.removeCustomServer)
  const authenticateCustomServer = useSettingsStore((state) => state.authenticateCustomServer)
  const setNcbiCredentials = useSettingsStore((state) => state.setNcbiCredentials)

  const [filter, setFilter] = useState<GroupFilter>('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<
    Partial<Record<'featured' | 'directory' | 'custom', boolean>>
  >({})
  const [editing, setEditing] = useState(false)
  const [emailField, setEmailField] = useState('')
  const [keyField, setKeyField] = useState('')
  const [authenticatingIds, setAuthenticatingIds] = useState<Set<string>>(() => new Set())
  const [retryingIds, setRetryingIds] = useState<Set<string>>(() => new Set())
  const [authError, setAuthError] = useState<string | null>(null)
  const [removal, setRemoval] = useState<{
    server: CustomServerView
    specialistNames?: string[]
  } | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removalError, setRemovalError] = useState<string | null>(null)

  useEffect(() => {
    void loadConnectors()
  }, [loadConnectors])

  const visibleConnectors = useMemo<ConnectorView[]>(() => {
    const term = query.trim().toLowerCase()
    if (!term) return connectors
    return connectors.filter(
      (connector) =>
        connector.displayName.toLowerCase().includes(term) ||
        connector.description.toLowerCase().includes(term)
    )
  }, [connectors, query])

  const visibleCustomServers = useMemo<CustomServerView[]>(() => {
    const term = query.trim().toLowerCase()
    if (!term) return customServers
    return customServers.filter(
      (server) =>
        server.displayName.toLowerCase().includes(term) ||
        server.name.toLowerCase().includes(term) ||
        (server.description?.toLowerCase().includes(term) ?? false)
    )
  }, [customServers, query])

  const startEditing = (): void => {
    setEmailField(ncbi.contactEmail ?? '')
    setKeyField('')
    setEditing(true)
  }

  const save = async (): Promise<void> => {
    await setNcbiCredentials({
      contactEmail: emailField,
      apiKey: keyField === '' ? undefined : keyField
    })
    setEditing(false)
  }

  const clearKey = async (): Promise<void> => {
    await setNcbiCredentials({ contactEmail: emailField, apiKey: '' })
    setKeyField('')
  }

  const signIn = async (id: string): Promise<void> => {
    setAuthenticatingIds((current) => new Set(current).add(id))
    setAuthError(null)
    try {
      await authenticateCustomServer({ id })
    } catch (error) {
      await loadConnectors().catch(() => undefined)
      setAuthError(error instanceof Error ? error.message : 'OAuth sign-in failed.')
    } finally {
      setAuthenticatingIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  const retry = async (id: string): Promise<void> => {
    setRetryingIds((current) => new Set(current).add(id))
    setAuthError(null)
    try {
      await retryCustomServer(id)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not reconnect this Connector.')
    } finally {
      setRetryingIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  const requestRemoval = async (server: CustomServerView): Promise<void> => {
    setRemovalError(null)
    try {
      await useSpecialistStore.getState().load()
      setRemoval({
        server,
        specialistNames: specialistNamesUsingConnector(useSpecialistStore.getState().items, server)
      })
    } catch {
      setRemoval({ server })
    }
  }

  const confirmRemoval = async (): Promise<void> => {
    if (!removal || removing) return
    setRemoving(true)
    setRemovalError(null)
    try {
      await removeCustomServer(removal.server.id)
      setRemoval(null)
    } catch (error) {
      setRemovalError(error instanceof Error ? error.message : 'Could not remove this Connector.')
    } finally {
      setRemoving(false)
    }
  }

  const showFeatured = filter === 'all' || filter === 'featured'
  const showDirectory = filter === 'all' || filter === 'directory'
  const showCustom = filter === 'all' || filter === 'custom'
  const featuredConnectors = visibleConnectors.filter((c) => (c.group ?? 'featured') === 'featured')
  const directoryConnectors = visibleConnectors.filter((c) => c.group === 'directory')
  const customExpanded = !collapsed.custom

  // Renders one collapsible bundled-connector section (Featured / Directory) with its rows.
  const connectorGroup = (
    groupKey: 'featured' | 'directory',
    label: string,
    subtitle: string,
    rows: ConnectorView[]
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
            <ul className="mt-2 flex flex-col divide-y divide-border">
              {rows.map((connector) => (
                <li
                  key={connector.id}
                  data-slot="settings-list-row"
                  className="flex min-h-14 items-center gap-3 py-2.5"
                >
                  <ConnectorGlyph size={24} />
                  <button
                    type="button"
                    onClick={() => onNavigate({ kind: 'detail', id: connector.id })}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-sm text-foreground">
                      {connector.displayName}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {connector.description}
                    </span>
                  </button>
                  <SettingsToggle
                    enabled={connector.enabled}
                    aria-label={connector.displayName}
                    onToggle={() => void setConnectorEnabled(connector.id, !connector.enabled)}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 py-2 text-xs text-muted-foreground">
              No connectors match your search.
            </p>
          )
        ) : null}
      </div>
    )
  }

  return (
    <div className="p-5">
      <SettingsSection
        title="Contact email"
        description={
          <>
            When allowed, shared with research data services that ask for a contact email (such as
            those run by NCBI, EBI, and OurResearch) on requests made on your behalf.
          </>
        }
        className="mb-5"
      >
        {editing ? (
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Input
                type="email"
                aria-label="Contact email"
                placeholder="you@example.com"
                value={emailField}
                onChange={(event) => setEmailField(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Input
                type="password"
                aria-label="NCBI API key"
                placeholder={ncbi.hasApiKey ? '••••••••' : 'Optional API key'}
                value={keyField}
                onChange={(event) => setKeyField(event.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                Higher NCBI rate limits (optional).
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" onClick={() => void save()}>
                Save
              </Button>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              {ncbi.hasApiKey ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void clearKey()}
                  className="ml-auto text-muted-foreground hover:text-destructive"
                >
                  Clear key
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {ncbi.contactEmail ?? 'Not set'}
            </span>
            <Button type="button" variant="outline" onClick={startEditing}>
              Edit
            </Button>
          </div>
        )}
      </SettingsSection>

      <div
        className="mb-4 grid grid-cols-[9rem_minmax(0,1fr)] gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center"
        data-testid="connectors-toolbar"
      >
        <Select value={filter} onValueChange={(value) => setFilter(value as GroupFilter)}>
          <SelectTrigger
            aria-label="Filter connectors by group"
            className="w-full sm:col-start-1 sm:row-start-1"
          >
            <span>{FILTER_LABELS[filter]}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="featured">Featured</SelectItem>
            <SelectItem value="directory">Directory</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
        <SettingsSearchInput
          aria-label="Search connectors"
          containerClassName="min-w-0 sm:col-start-2 sm:row-start-1"
          placeholder="Search connectors…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="col-span-2 row-start-2 w-full justify-center sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:w-auto sm:shrink-0"
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add connector
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
                <span>Local command</span>
                <span className="text-xs text-muted-foreground">
                  Run an MCP server via a command
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="gap-2.5"
              onSelect={() => onNavigate({ kind: 'add', transport: 'remote' })}
            >
              <Globe className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Remote server</span>
                <span className="text-xs text-muted-foreground">Connect to an MCP server URL</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'import' })}>
              <FileUp className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Import configuration</span>
                <span className="text-xs text-muted-foreground">
                  Validate a shared Connector file
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-col gap-4">
        {authError ? (
          <div
            className="flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{authError}</span>
          </div>
        ) : null}
        {showFeatured
          ? connectorGroup(
              'featured',
              'Featured',
              'Research connectors from Anthropic',
              featuredConnectors
            )
          : null}

        {showDirectory
          ? connectorGroup(
              'directory',
              'Directory',
              'Syncs with the Claude Connectors Directory',
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
                Custom
                <ChevronDown
                  className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${
                    customExpanded ? '' : '-rotate-90'
                  }`}
                  aria-hidden="true"
                />
              </span>
              <span className="text-xs text-muted-foreground">Connectors you added</span>
            </button>

            {customExpanded ? (
              visibleCustomServers.length > 0 ? (
                <ul className="mt-2 flex flex-col divide-y divide-border">
                  {visibleCustomServers.map((server) => (
                    <li
                      key={server.id}
                      data-slot="settings-list-row"
                      className="flex min-h-14 items-center gap-3 py-2.5"
                    >
                      <ConnectorGlyph size={24} />
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">
                          {server.displayName}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {server.name}
                          {server.description ? ` · ${server.description}` : ''}
                        </span>
                        <span
                          className={`block truncate text-xs ${
                            server.availability && !server.checking && !retryingIds.has(server.id)
                              ? 'text-destructive'
                              : 'text-muted-foreground'
                          }`}
                        >
                          {retryingIds.has(server.id)
                            ? 'Checking…'
                            : server.checking
                              ? 'Checking…'
                              : server.availability === 'unavailable'
                                ? 'Unavailable'
                                : server.availability === 'unauthenticated'
                                  ? 'Sign-in required'
                                  : server.enabled
                                    ? 'Connected'
                                    : 'Disabled'}
                        </span>
                      </div>
                      <SettingsIconAction
                        label={`Export ${server.displayName}`}
                        icon={Download}
                        onClick={() => onNavigate({ kind: 'export', id: server.id })}
                      />
                      <SettingsIconAction
                        label={`Edit ${server.displayName}`}
                        icon={Pencil}
                        onClick={() => onNavigate({ kind: 'edit', id: server.id })}
                      />
                      <SettingsIconAction
                        label={`Remove ${server.displayName}`}
                        icon={Trash2}
                        onClick={() => void requestRemoval(server)}
                        danger
                      />
                      {server.availability === 'unavailable' && server.enabled ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={retryingIds.has(server.id)}
                          onClick={() => void retry(server.id)}
                        >
                          {retryingIds.has(server.id) ? 'Checking…' : 'Retry'}
                        </Button>
                      ) : null}
                      {server.availability === 'unauthenticated' && !server.oauth ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => onNavigate({ kind: 'edit', id: server.id })}
                        >
                          Configure
                        </Button>
                      ) : null}
                      {server.oauth ? (
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            authenticatingIds.has(server.id) ||
                            (server.oauth.hasTokens && server.availability !== 'unauthenticated')
                              ? 'outline'
                              : 'default'
                          }
                          disabled={
                            authenticatingIds.has(server.id) ||
                            (server.oauth.hasTokens && server.availability !== 'unauthenticated')
                          }
                          onClick={() => void signIn(server.id)}
                        >
                          {authenticatingIds.has(server.id)
                            ? 'Connecting…'
                            : server.oauth.hasTokens && server.availability !== 'unauthenticated'
                              ? 'Connected'
                              : server.availability === 'unauthenticated'
                                ? 'Retry'
                                : 'Sign in'}
                        </Button>
                      ) : null}
                      <SettingsToggle
                        enabled={server.enabled}
                        aria-label={server.displayName}
                        aria-disabled={requiresSignInBeforeEnable(server) || undefined}
                        className={
                          requiresSignInBeforeEnable(server)
                            ? 'cursor-not-allowed opacity-50'
                            : undefined
                        }
                        title={
                          requiresSignInBeforeEnable(server)
                            ? 'Sign in before enabling this Connector'
                            : undefined
                        }
                        onToggle={() => {
                          if (requiresSignInBeforeEnable(server)) return
                          void setCustomServerEnabled(server.id, !server.enabled)
                        }}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 py-2 text-xs text-muted-foreground">
                  Add a custom connector to connect your own server.
                </p>
              )
            ) : null}
          </div>
        ) : null}
      </div>

      <AlertDialog.Root
        open={removal !== null}
        onOpenChange={(open) => {
          if (!open && !removing) {
            setRemoval(null)
            setRemovalError(null)
          }
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
                  Remove “{removal?.server.displayName}”?
                </AlertDialog.Title>
              </div>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  className={dialogCloseButtonClassName}
                  disabled={removing}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </AlertDialog.Cancel>
            </div>

            <div className={dialogBodyClassName}>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                This removes the Connector configuration and credentials from this app. Existing
                conversation history is kept.
              </AlertDialog.Description>
              {removal?.specialistNames?.length ? (
                <div className="mt-4 rounded-lg border border-warning-100/50 bg-warning-100/10 px-3 py-2.5 text-sm text-foreground">
                  <p>
                    This Connector is used by {removal.specialistNames.length}{' '}
                    {removal.specialistNames.length === 1 ? 'Specialist' : 'Specialists'}.{' '}
                    {removal.specialistNames.length === 1 ? 'Its' : 'Their'} saved references will
                    become unavailable.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {removal.specialistNames.join(', ')}
                  </p>
                </div>
              ) : removal?.specialistNames === undefined ? (
                <p className="mt-4 text-xs text-muted-foreground">
                  Specialist references could not be checked. You can still remove this Connector.
                </p>
              ) : null}
              {removalError ? (
                <div
                  role="alert"
                  className="mt-4 flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>{removalError}</span>
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
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <Button
                type="button"
                variant="destructive"
                disabled={removing}
                onClick={() => void confirmRemoval()}
              >
                {removing ? 'Removing…' : 'Remove Connector'}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}
