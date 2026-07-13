import { ChevronDown, Globe, Pencil, Plus, Search, Terminal, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { ConnectorView, CustomServerView } from '../../../../shared/settings'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import { ConnectorGlyph } from './connector-icons'
import { SkillToggle } from './SkillsPanel'

// The connectors panel sub-view, driven by the settings navigation history. The detail and add pages
// are separate components owned by SettingsPage; this panel only renders the list + contact-email section.
export type ConnectorsView =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | { kind: 'add'; transport: 'local' | 'remote' }
  | { kind: 'edit'; id: string }

type GroupFilter = 'all' | 'featured' | 'directory' | 'custom'

const FILTER_LABELS: Record<GroupFilter, string> = {
  all: 'All',
  featured: 'Featured',
  directory: 'Directory',
  custom: 'Custom'
}

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
  const removeCustomServer = useSettingsStore((state) => state.removeCustomServer)
  const setNcbiCredentials = useSettingsStore((state) => state.setNcbiCredentials)

  const [filter, setFilter] = useState<GroupFilter>('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<
    Partial<Record<'featured' | 'directory' | 'custom', boolean>>
  >({})
  const [editing, setEditing] = useState(false)
  const [emailField, setEmailField] = useState('')
  const [keyField, setKeyField] = useState('')

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
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${
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
                <li key={connector.id} className="flex items-center gap-3 py-2.5">
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
                  <SkillToggle
                    enabled={connector.enabled}
                    label={connector.displayName}
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
      <div className="mb-4 rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Contact email</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          When allowed, shared with research data services that ask for a contact email (such as
          those run by NCBI, EBI, and OurResearch) on requests made on your behalf.
        </p>

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
              <button
                type="button"
                onClick={() => void save()}
                className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="inline-flex h-8 items-center rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                Cancel
              </button>
              {ncbi.hasApiKey ? (
                <button
                  type="button"
                  onClick={() => void clearKey()}
                  className="ml-auto text-xs text-muted-foreground transition-colors hover:text-destructive"
                >
                  Clear key
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {ncbi.contactEmail ?? 'Not set'}
            </span>
            <button
              type="button"
              onClick={startEditing}
              className="inline-flex h-8 shrink-0 items-center rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Edit
            </button>
          </div>
        )}
      </div>

      <div className="mb-4 flex items-center gap-2">
        <Select value={filter} onValueChange={(value) => setFilter(value as GroupFilter)}>
          <SelectTrigger aria-label="Filter connectors by group" className="w-36">
            <span>{FILTER_LABELS[filter]}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="featured">Featured</SelectItem>
            <SelectItem value="directory">Directory</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search connectors"
            placeholder="Search connectors…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted">
            <Plus className="size-4" aria-hidden="true" />
            Add connector
            <ChevronDown className="size-4 opacity-70" aria-hidden="true" />
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
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-col gap-4">
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
                  className={`size-4 shrink-0 text-muted-foreground transition-transform ${
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
                    <li key={server.id} className="flex items-center gap-3 py-2.5">
                      <ConnectorGlyph size={24} />
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">
                          {server.name}
                        </span>
                        {server.description ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {server.description}
                          </span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        aria-label={`Edit ${server.name}`}
                        onClick={() => onNavigate({ kind: 'edit', id: server.id })}
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="size-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${server.name}`}
                        onClick={() => void removeCustomServer(server.id)}
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                      <SkillToggle
                        enabled={server.enabled}
                        label={server.name}
                        onToggle={() => void setCustomServerEnabled(server.id, !server.enabled)}
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
    </div>
  )
}
