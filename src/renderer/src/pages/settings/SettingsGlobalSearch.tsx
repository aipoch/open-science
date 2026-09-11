import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import type { SettingsPanelId } from './settings-navigation'
import { SettingsSearchInput } from './SettingsSearchInput'

type SettingsSearchEntry = {
  id: string
  panel: SettingsPanelId
  // A catalog key, not finished copy: this table is module-level, so callers resolve it via t().
  labelKey: string
  // Extra English match terms that are never displayed.
  keywords?: string
}

// Cross-panel search index: one to three representative entries per panel, each reusing existing
// settings copy as its label. Selection deep-links to the panel through the dialog's navigation.
const SETTINGS_SEARCH_INDEX: ReadonlyArray<SettingsSearchEntry> = [
  {
    id: 'model.add-provider',
    panel: 'model',
    labelKey: 'Add provider',
    keywords: 'api key vendor'
  },
  { id: 'model.main', panel: 'model', labelKey: 'Main model', keywords: 'default thinking' },
  {
    id: 'model.scenarios',
    panel: 'model',
    labelKey: 'Scenario models',
    keywords: 'subagent reviewer vision session details'
  },
  {
    id: 'agent.framework',
    panel: 'agent',
    labelKey: 'Agent framework',
    keywords: 'claude codex opencode backend'
  },
  {
    id: 'skills.manage',
    panel: 'skills',
    labelKey: 'Manage skills',
    keywords: 'enable disable bulk'
  },
  {
    id: 'skills.add',
    panel: 'skills',
    labelKey: 'Add skill',
    keywords: 'import upload zip github'
  },
  { id: 'skills.conversation-imports', panel: 'skills', labelKey: 'Conversation imports' },
  {
    id: 'specialists.add',
    panel: 'specialists',
    labelKey: 'Add specialist',
    keywords: 'create custom role'
  },
  {
    id: 'specialists.marketplace',
    panel: 'specialists',
    labelKey: 'Marketplace',
    keywords: 'browse install'
  },
  { id: 'memory.new-category', panel: 'memory', labelKey: 'New category', keywords: 'remember' },
  {
    id: 'connectors.add',
    panel: 'connectors',
    labelKey: 'Add connector',
    keywords: 'mcp server'
  },
  {
    id: 'connectors.import',
    panel: 'connectors',
    labelKey: 'Import Connector or MCP configuration',
    keywords: 'json claude desktop'
  },
  { id: 'network.proxy', panel: 'network', labelKey: 'Proxy', keywords: 'http https' },
  {
    id: 'network.mirror',
    panel: 'network',
    labelKey: 'Package mirror',
    keywords: 'npm pypi registry conda'
  },
  {
    id: 'network.domains',
    panel: 'network',
    labelKey: 'Notebook network access',
    keywords: 'domains allowlist'
  },
  {
    id: 'remote-control.app-access',
    panel: 'remote-control',
    labelKey: 'App access',
    keywords: 'remote browser link pair'
  },
  {
    id: 'credentials.new',
    panel: 'credentials',
    labelKey: 'New credential',
    keywords: 'token key'
  },
  {
    id: 'credentials.literature',
    panel: 'credentials',
    labelKey: 'Literature access',
    keywords: 'openalex unpaywall'
  },
  { id: 'credentials.github', panel: 'credentials', labelKey: 'GitHub' },
  { id: 'tags.new', panel: 'tags', labelKey: 'New Tag', keywords: 'label organize color' },
  {
    id: 'permissions.default-mode',
    panel: 'permissions',
    labelKey: 'Default permission mode',
    keywords: 'allow deny approve tools'
  },
  {
    id: 'runtimes.runtimes',
    panel: 'runtimes',
    labelKey: 'Notebook runtimes',
    keywords: 'python r kernel jupyter environment'
  },
  {
    id: 'storage.application',
    panel: 'storage',
    labelKey: 'Application storage',
    keywords: 'disk data size'
  },
  {
    id: 'storage.location',
    panel: 'storage',
    labelKey: 'Change location',
    keywords: 'folder move directory'
  },
  {
    id: 'compute.add-host',
    panel: 'compute',
    labelKey: 'Add SSH host',
    keywords: 'ssh remote server gpu'
  },
  { id: 'usage.list', panel: 'usage', labelKey: 'Usage', keywords: 'tokens cost analytics' },
  { id: 'archived.list', panel: 'archived', labelKey: 'Archived', keywords: 'project restore' },
  {
    id: 'general.appearance',
    panel: 'general',
    labelKey: 'Appearance',
    keywords: 'theme dark light'
  },
  { id: 'general.language', panel: 'general', labelKey: 'Language', keywords: 'locale' },
  { id: 'general.notifications', panel: 'general', labelKey: 'Notifications' },
  { id: 'general.diagnostics', panel: 'general', labelKey: 'Diagnostics', keywords: 'log file' },
  {
    id: 'general.cli',
    panel: 'general',
    labelKey: 'Command line tool',
    keywords: 'cli install path shell'
  }
]

type SettingsGlobalSearchProps = {
  panels: ReadonlyArray<{ id: SettingsPanelId; labelKey: string }>
  onNavigate: (panel: SettingsPanelId) => void
}

// Briefly rings the first content block of the freshly navigated panel so the jump target is
// visible. Polls until the target panel has actually rendered (lazy panels load async), so the
// highlight never lands on the previous panel. Purely visual: inline styles over the existing
// --primary token, no persistence.
const highlightNavigatedPanel = (panel: SettingsPanelId): void => {
  const startedAt = Date.now()
  const attempt = (): void => {
    const root = document.querySelector(
      `[data-slot="settings-content-scroll"][data-settings-active-panel="${panel}"]`
    )
    // Prefer the panel's first section/header; panels without section markup fall back to the
    // panel root once the lazy chunk has had time to replace the loading boundary.
    const target =
      root?.querySelector<HTMLElement>('section, [data-slot="settings-panel-header"]') ??
      (root && Date.now() - startedAt > 1200
        ? root.querySelector<HTMLElement>(':scope > div > :first-child')
        : null)
    if (target) {
      target.scrollIntoView({ block: 'nearest' })
      target.style.transition = 'box-shadow 200ms ease-out'
      target.style.borderRadius = '8px'
      target.style.boxShadow = '0 0 0 2px var(--primary)'
      window.setTimeout(() => {
        target.style.boxShadow = ''
        target.style.borderRadius = ''
        target.style.transition = ''
      }, 1600)
      return
    }
    if (Date.now() - startedAt < 3000) window.setTimeout(attempt, 150)
  }
  attempt()
}

// Settings-wide search box for the dialog header. Searches the cross-panel index and deep-links
// to the selected panel through the dialog's own navigation.
const SettingsGlobalSearch = ({
  panels,
  onNavigate
}: SettingsGlobalSearchProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const panelLabel = (panel: SettingsPanelId): string => {
    const entry = panels.find((candidate) => candidate.id === panel)
    return entry ? t(entry.labelKey) : panel
  }

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return SETTINGS_SEARCH_INDEX
    return SETTINGS_SEARCH_INDEX.filter((entry) =>
      [entry.labelKey, t(entry.labelKey), panelLabel(entry.panel), entry.keywords ?? ''].some(
        (haystack) => haystack.toLowerCase().includes(normalized)
      )
    )
    // panelLabel closes over t and panels; both are covered by the deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, t, panels])

  const selectEntry = (entry: SettingsSearchEntry): void => {
    setQuery('')
    setIsOpen(false)
    setActiveIndex(0)
    onNavigate(entry.panel)
    highlightNavigatedPanel(entry.panel)
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      onBlur={(event) => {
        if (!containerRef.current?.contains(event.relatedTarget as Node | null)) setIsOpen(false)
      }}
    >
      <SettingsSearchInput
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setIsOpen(true)
          setActiveIndex(0)
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            if (isOpen) {
              // Swallow the first Escape so it closes only the results list, not the dialog.
              event.stopPropagation()
              setIsOpen(false)
              event.currentTarget.blur()
            }
            return
          }
          if (!isOpen || results.length === 0) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex((index) =>
              event.key === 'ArrowDown'
                ? (index + 1) % results.length
                : (index - 1 + results.length) % results.length
            )
          } else if (event.key === 'Enter') {
            event.preventDefault()
            const entry = results[activeIndex]
            if (entry) selectEntry(entry)
          }
        }}
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={listId}
        aria-activedescendant={
          isOpen && results[activeIndex] ? `${listId}-${results[activeIndex].id}` : undefined
        }
        aria-autocomplete="list"
        aria-label={t('Search settings')}
        placeholder={t('Search settings')}
        className="h-8"
      />
      {isOpen ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t('Search settings')}
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-dialog"
        >
          {results.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {t('No matching settings')}
            </div>
          ) : (
            results.map((entry, index) => (
              <button
                key={entry.id}
                id={`${listId}-${entry.id}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectEntry(entry)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm',
                  index === activeIndex ? 'bg-muted' : undefined
                )}
              >
                <span className="min-w-0 truncate">{t(entry.labelKey)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {panelLabel(entry.panel)}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

export { SettingsGlobalSearch }
export type { SettingsGlobalSearchProps }
