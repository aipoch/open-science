import { useEffect, useId, useMemo, useRef, useState } from 'react'
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
  // Value of the data-settings-anchor attribute marking this entry's exact jump target inside the
  // panel. Entries without one fall back to the panel's first content block.
  anchor?: string
}

// Cross-panel search index: one to three representative entries per panel, each reusing existing
// settings copy as its label. Selection deep-links to the panel through the dialog's navigation.
const SETTINGS_SEARCH_INDEX: ReadonlyArray<SettingsSearchEntry> = [
  {
    id: 'model.add-provider',
    panel: 'model',
    labelKey: 'Add provider',
    keywords: 'api key vendor',
    anchor: 'model.add-provider'
  },
  {
    id: 'model.main',
    panel: 'model',
    labelKey: 'Main model',
    keywords: 'default thinking',
    anchor: 'model.main'
  },
  {
    id: 'model.scenarios',
    panel: 'model',
    labelKey: 'Scenario models',
    keywords: 'subagent reviewer vision session details',
    anchor: 'model.scenarios'
  },
  {
    id: 'agent.framework',
    panel: 'agent',
    labelKey: 'Agent framework',
    keywords: 'claude codex opencode backend',
    anchor: 'agent.framework'
  },
  {
    id: 'skills.manage',
    panel: 'skills',
    labelKey: 'Manage skills',
    keywords: 'enable disable bulk',
    anchor: 'skills.manage'
  },
  {
    id: 'skills.add',
    panel: 'skills',
    labelKey: 'Add skill',
    keywords: 'import upload zip github',
    anchor: 'skills.add'
  },
  {
    id: 'skills.conversation-imports',
    panel: 'skills',
    labelKey: 'Conversation imports',
    anchor: 'skills.conversation-imports'
  },
  {
    id: 'specialists.add',
    panel: 'specialists',
    labelKey: 'Add specialist',
    keywords: 'create custom role',
    anchor: 'specialists.add'
  },
  {
    id: 'specialists.marketplace',
    panel: 'specialists',
    labelKey: 'Marketplace',
    keywords: 'browse install',
    anchor: 'specialists.marketplace'
  },
  {
    id: 'memory.new-category',
    panel: 'memory',
    labelKey: 'New category',
    keywords: 'remember',
    anchor: 'memory.new-category'
  },
  {
    id: 'connectors.add',
    panel: 'connectors',
    labelKey: 'Add connector',
    keywords: 'mcp server',
    anchor: 'connectors.add'
  },
  {
    id: 'connectors.import',
    panel: 'connectors',
    labelKey: 'Import Connector or MCP configuration',
    keywords: 'json claude desktop'
    // No anchor: the import action lives inside the Add connector dropdown, which is unmounted at
    // jump time — fall back to the panel's first block immediately instead of waiting.
  },
  {
    id: 'network.proxy',
    panel: 'network',
    labelKey: 'Proxy',
    keywords: 'http https',
    anchor: 'network.proxy'
  },
  {
    id: 'network.mirror',
    panel: 'network',
    labelKey: 'Package mirror',
    keywords: 'npm pypi registry conda',
    anchor: 'network.mirror'
  },
  {
    id: 'network.domains',
    panel: 'network',
    labelKey: 'Notebook network access',
    keywords: 'domains allowlist',
    anchor: 'network.domains'
  },
  {
    id: 'remote-control.app-access',
    panel: 'remote-control',
    labelKey: 'App access',
    keywords: 'remote browser link pair',
    anchor: 'remote-control.app-access'
  },
  {
    id: 'credentials.new',
    panel: 'credentials',
    labelKey: 'New credential',
    keywords: 'token key',
    anchor: 'credentials.new'
  },
  {
    id: 'credentials.literature',
    panel: 'credentials',
    labelKey: 'Literature access',
    keywords: 'openalex unpaywall',
    anchor: 'credentials.literature'
  },
  {
    id: 'credentials.github',
    panel: 'credentials',
    labelKey: 'GitHub',
    anchor: 'credentials.github'
  },
  {
    id: 'tags.new',
    panel: 'tags',
    labelKey: 'New Tag',
    keywords: 'label organize color',
    anchor: 'tags.new'
  },
  {
    id: 'permissions.default-mode',
    panel: 'permissions',
    labelKey: 'Default permission mode',
    keywords: 'allow deny approve tools',
    anchor: 'permissions.default-mode'
  },
  {
    id: 'runtimes.runtimes',
    panel: 'runtimes',
    labelKey: 'Notebook runtimes',
    keywords: 'python r kernel jupyter environment',
    anchor: 'runtimes.runtimes'
  },
  {
    id: 'storage.application',
    panel: 'storage',
    labelKey: 'Application storage',
    keywords: 'disk data size',
    anchor: 'storage.application'
  },
  {
    id: 'storage.location',
    panel: 'storage',
    labelKey: 'Change location',
    keywords: 'folder move directory',
    anchor: 'storage.location'
  },
  {
    id: 'compute.add-host',
    panel: 'compute',
    labelKey: 'Add SSH host',
    keywords: 'ssh remote server gpu',
    anchor: 'compute.add-host'
  },
  {
    id: 'usage.list',
    panel: 'usage',
    labelKey: 'Usage',
    keywords: 'tokens cost analytics',
    anchor: 'usage.list'
  },
  {
    id: 'archived.list',
    panel: 'archived',
    labelKey: 'Archived',
    keywords: 'project restore',
    anchor: 'archived.list'
  },
  {
    id: 'general.appearance',
    panel: 'general',
    labelKey: 'Appearance',
    keywords: 'theme dark light',
    anchor: 'general.appearance'
  },
  {
    id: 'general.language',
    panel: 'general',
    labelKey: 'Language',
    keywords: 'locale',
    anchor: 'general.language'
  },
  {
    id: 'general.notifications',
    panel: 'general',
    labelKey: 'Notifications',
    anchor: 'general.notifications'
  },
  {
    id: 'general.diagnostics',
    panel: 'general',
    labelKey: 'Diagnostics',
    keywords: 'log file',
    anchor: 'general.diagnostics'
  },
  {
    id: 'general.cli',
    panel: 'general',
    labelKey: 'Command line tool',
    keywords: 'cli install path shell',
    anchor: 'general.cli'
  }
]

type SettingsGlobalSearchProps = {
  panels: ReadonlyArray<{ id: SettingsPanelId; labelKey: string }>
  onNavigate: (panel: SettingsPanelId) => void
}

// Elements that can already receive keyboard focus; anything else is lent a temporary tabindex.
const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]'

const HIGHLIGHT_CLASS = 'settings-search-highlight'
const HIGHLIGHT_FADE_CLASS = 'settings-search-highlight-fading'

// Rings and focuses the search jump target once the freshly navigated panel has rendered, so the
// user sees exactly where they landed. Entries with an anchor jump to their own setting element;
// the anchor gets a grace period (lazy chunks, async data) before falling back to the panel's
// first content block. Polls until the target panel has actually rendered, so the highlight never
// lands on the previous panel. Purely visual and focus-only: no persistence. Returns a cancel
// function that stops polling and strips any active ring — callers run it on unmount and before
// starting another highlight.
const highlightNavigatedPanel = (panel: SettingsPanelId, anchor?: string): (() => void) => {
  const startedAt = Date.now()
  const timers: number[] = []
  let highlighted: HTMLElement | null = null
  let addedTabIndex = false

  const stripRing = (): void => {
    if (!highlighted) return
    if (highlighted.isConnected) {
      highlighted.classList.remove(HIGHLIGHT_CLASS, HIGHLIGHT_FADE_CLASS)
      if (addedTabIndex) highlighted.removeAttribute('tabindex')
    }
    highlighted = null
    addedTabIndex = false
  }

  // Prefer the panel's first section/header; panels without section markup fall back to the
  // panel root once the lazy chunk has had time to replace the loading boundary.
  const fallbackTarget = (root: Element, elapsed: number): HTMLElement | null =>
    root.querySelector<HTMLElement>('section, [data-slot="settings-panel-header"]') ??
    (elapsed > 1200 ? root.querySelector<HTMLElement>(':scope > div > :first-child') : null)

  const attempt = (): void => {
    const root = document.querySelector(
      `[data-slot="settings-content-scroll"][data-settings-active-panel="${panel}"]`
    )
    if (!root) {
      if (Date.now() - startedAt < 3000) timers.push(window.setTimeout(attempt, 150))
      return
    }
    const elapsed = Date.now() - startedAt
    let target: HTMLElement | null = null
    if (anchor) {
      target = root.querySelector<HTMLElement>(`[data-settings-anchor="${anchor}"]`)
      // Anchored entries wait for their exact target instead of ringing the wrong block early.
      if (!target && elapsed > 1200) target = fallbackTarget(root, elapsed)
    } else {
      target = fallbackTarget(root, elapsed)
    }
    if (target) {
      highlighted = target
      target.classList.add(HIGHLIGHT_CLASS)
      if (!target.matches(FOCUSABLE_SELECTOR)) {
        target.setAttribute('tabindex', '-1')
        addedTabIndex = true
      }
      // Scroll first with the highlight's scroll-margin for breathing room, then move focus
      // without scrolling again.
      target.scrollIntoView({ block: 'nearest' })
      target.focus({ preventScroll: true })
      timers.push(
        window.setTimeout(() => {
          if (highlighted?.isConnected) highlighted.classList.add(HIGHLIGHT_FADE_CLASS)
        }, 1400),
        window.setTimeout(stripRing, 1600)
      )
      return
    }
    if (elapsed < 3000) timers.push(window.setTimeout(attempt, 150))
  }
  attempt()

  return () => {
    for (const timer of timers) window.clearTimeout(timer)
    stripRing()
  }
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
  const cancelHighlightRef = useRef<(() => void) | null>(null)

  // Stop highlight polling and strip any ring when the dialog (and this field) unmounts.
  useEffect(
    () => () => {
      cancelHighlightRef.current?.()
      cancelHighlightRef.current = null
    },
    []
  )

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
    cancelHighlightRef.current?.()
    cancelHighlightRef.current = highlightNavigatedPanel(entry.panel, entry.anchor)
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      onBlur={(event) => {
        if (!containerRef.current?.contains(event.relatedTarget as Node | null)) setIsOpen(false)
      }}
      onKeyDown={(event) => {
        // Container-level fallback: Escape closes the results list wherever focus sits inside the
        // combobox, and never reaches the dialog's own Escape handling while the list is open.
        if (event.key !== 'Escape' || !isOpen) return
        event.stopPropagation()
        setIsOpen(false)
        containerRef.current?.querySelector('input')?.blur()
      }}
    >
      <SettingsSearchInput
        value={query}
        shortcutPriority={1}
        onChange={(event) => {
          setQuery(event.target.value)
          setIsOpen(true)
          setActiveIndex(0)
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') return
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
                // Combobox pattern: focus stays on the input; options are mouse/aria-only targets.
                tabIndex={-1}
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

export { SettingsGlobalSearch, SETTINGS_SEARCH_INDEX }
export type { SettingsGlobalSearchProps, SettingsSearchEntry }
