import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { useTagStore } from '@/stores/tag-store'
import { SettingsIconAction } from './SettingsLayout'
import {
  getSettingsSearchKeyShortcuts,
  useSettingsSearchShortcut
} from './settings-search-shortcut'
import { TagFilter } from './ResourceTagControls'

type ConnectorRow = {
  id: string
  name: string
  description?: string
  mainEnabled: boolean
  available: boolean
  availability?: 'unavailable' | 'unauthenticated' | 'credential_unavailable'
}

type SkillRow = {
  id: string
  name: string
  description?: string
  source?: string
  mainEnabled: boolean
  missing: boolean
}

// Interaction props for a clickable capability row. A div[role="button"] does not synthesize a
// click from Enter/Space the way a native button does, so both keys are handled explicitly.
// Keyboard activation of an inner control (e.g. the remove button) is left to that control: the
// row only reacts when it is itself the event target.
const clickableRowProps = (
  open: (() => void) | undefined,
  label: string
):
  | {
      role: 'button'
      tabIndex: number
      'aria-label': string
      onClick: () => void
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
    }
  | undefined =>
  open === undefined
    ? undefined
    : {
        role: 'button',
        tabIndex: 0,
        'aria-label': label,
        onClick: open,
        onKeyDown: (event) => {
          if (event.target !== event.currentTarget) return
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          open()
        }
      }

// Shared layout for the capability list rows; `interactive` adds the clickable affordance.
const capabilityRowClassName = (interactive: boolean): string =>
  cn(
    'flex h-[40px] items-center gap-2.5 border-b border-border px-3 last:border-b-0',
    interactive && 'cursor-pointer hover:bg-muted focus-visible:bg-muted'
  )

// The remove action sits inside a row that may itself be clickable; stopping propagation keeps
// removal from also activating the row's navigation.
const stopThen =
  (remove: () => void) =>
  (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    remove()
  }

type SpecialistCapabilitiesSectionProps = {
  // Mirrors the shared domain field form.capabilityMode; the section stays fully
  // controlled so the editor's form remains the single source of truth for what
  // gets saved.
  capabilityMode: 'full' | 'selected'
  onCapabilityModeChange: (mode: 'full' | 'selected') => void
  selectedSkillIds: string[]
  excludedSkillIds: string[]
  selectedConnectorIds: string[]
  excludedConnectorIds: string[]
  // Updater-style callbacks keep add/remove race-free against rapid interactions, exactly
  // like the setForm-based updates this section was extracted from.
  updateSkillIds: (update: (prev: string[]) => string[]) => void
  updateConnectorIds: (update: (prev: string[]) => string[]) => void
  activeTab: 'skills' | 'connectors'
  onActiveTabChange: (tab: 'skills' | 'connectors') => void
  // Called when a selected Skill row is clicked to view that Skill in Settings.
  onOpenSkillDetail?: (skillId: string) => void
  // Called when a selected Connector row is clicked to view that Connector in
  // Settings. Receives the canonical id: a custom server referenced by its legacy
  // name is resolved to server.id before the call.
  onOpenConnectorDetail?: (connectorId: string) => void
}

const SpecialistCapabilitiesSection = ({
  capabilityMode,
  onCapabilityModeChange,
  selectedSkillIds,
  excludedSkillIds,
  selectedConnectorIds,
  excludedConnectorIds,
  updateSkillIds,
  updateConnectorIds,
  activeTab,
  onActiveTabChange,
  onOpenSkillDetail,
  onOpenConnectorDetail
}: SpecialistCapabilitiesSectionProps): React.JSX.Element => {
  const { t } = useTranslation()
  const connectors = useSettingsStore((state) => state.connectors)
  const skills = useSettingsStore((state) => state.skills)
  const customServers = useSettingsStore((state) => state.customServers)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  const loadSkills = useSettingsStore((state) => state.loadSkills)
  const tagAssignments = useTagStore((state) => state.assignments)

  const isFullAccess = capabilityMode === 'full'

  const [skillSearchQuery, setSkillSearchQuery] = useState('')
  const [connectorSearchQuery, setConnectorSearchQuery] = useState('')
  const [skillTagFilter, setSkillTagFilter] = useState('all')
  const [connectorTagFilter, setConnectorTagFilter] = useState('all')
  const skillSearchRef = useRef<HTMLInputElement>(null)
  const connectorSearchRef = useRef<HTMLInputElement>(null)
  const [skillPopoverOpen, setSkillPopoverOpen] = useState(false)
  const [connectorPopoverOpen, setConnectorPopoverOpen] = useState(false)
  const skillDropdownRef = useRef<HTMLDivElement>(null)
  const connectorDropdownRef = useRef<HTMLDivElement>(null)
  useSettingsSearchShortcut(skillSearchRef, skillPopoverOpen)
  useSettingsSearchShortcut(connectorSearchRef, connectorPopoverOpen)
  const skillTriggerRef = useRef<HTMLButtonElement>(null)
  const connectorTriggerRef = useRef<HTMLButtonElement>(null)

  const closeSkillDropdown = useCallback(() => setSkillPopoverOpen(false), [])
  const closeConnectorDropdown = useCallback(() => setConnectorPopoverOpen(false), [])

  useEffect(() => {
    if (!skillPopoverOpen) return
    const handle = (e: MouseEvent): void => {
      if (skillDropdownRef.current && !skillDropdownRef.current.contains(e.target as Node)) {
        closeSkillDropdown()
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [skillPopoverOpen, closeSkillDropdown])

  useEffect(() => {
    if (!connectorPopoverOpen) return
    const handle = (e: MouseEvent): void => {
      if (
        connectorDropdownRef.current &&
        !connectorDropdownRef.current.contains(e.target as Node)
      ) {
        closeConnectorDropdown()
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [connectorPopoverOpen, closeConnectorDropdown])

  useEffect(() => {
    void loadConnectors()
  }, [loadConnectors])

  useEffect(() => {
    if (skills.length === 0) void loadSkills()
  }, [skills.length, loadSkills])

  // Persist references to unavailable entries so a temporarily missing connector is visible and
  // cannot silently broaden the profile when it returns. Main-disabled installed connectors remain
  // selectable: Main's toggle is not a Specialist capability limit.
  const connectorRows = useMemo(() => {
    const referencedIds = new Set([...excludedConnectorIds, ...selectedConnectorIds])
    const known: ConnectorRow[] = [
      ...connectors.map((connector) => ({
        id: connector.id,
        name: connector.displayName,
        description: connector.description,
        mainEnabled: connector.enabled,
        available: true
      })),
      ...customServers.map((server) => ({
        id:
          referencedIds.has(server.name) && !referencedIds.has(server.id) ? server.name : server.id,
        name: server.displayName,
        description: server.description ? `${server.name} · ${server.description}` : server.name,
        mainEnabled: server.enabled,
        available: server.availability === undefined,
        availability: server.availability
      }))
    ]
    const ids = new Set(known.map((row) => row.id))
    for (const id of [...excludedConnectorIds, ...selectedConnectorIds]) {
      if (ids.has(id)) continue
      const legacy = customServers.find((server) => server.name === id)
      if (legacy) {
        known.push({
          id,
          name: legacy.displayName,
          description: legacy.description ? `${legacy.name} · ${legacy.description}` : legacy.name,
          mainEnabled: legacy.enabled,
          available: legacy.availability === undefined,
          availability: legacy.availability
        })
      } else {
        known.push({ id, name: id, mainEnabled: false, available: false })
      }
    }
    return known.sort((a, b) => a.name.localeCompare(b.name))
  }, [connectors, customServers, selectedConnectorIds, excludedConnectorIds])

  // Main-disabled installed Skills remain selectable for a Specialist. Persisted IDs absent from
  // the runtime-available catalog are rendered locally so the user can remove them without blocking
  // the session.
  const skillRows = useMemo(() => {
    const known: SkillRow[] = skills
      .filter((skill) => skill.available !== false)
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source: skill.source,
        mainEnabled: skill.enabled,
        missing: false
      }))
    const ids = new Set(known.map((skill) => skill.id))
    for (const id of [...excludedSkillIds, ...selectedSkillIds]) {
      if (!ids.has(id)) known.push({ id, name: id, mainEnabled: false, missing: true })
    }
    return known.sort((a, b) => a.name.localeCompare(b.name))
  }, [skills, excludedSkillIds, selectedSkillIds])

  // Selected-capabilities mode lists. Skills and Connectors are both whitelists: they start empty
  // and are added explicitly. Persisted IDs missing from the catalog stay visible (and removable)
  // so a stale reference never locks the session. Main-disabled installed items remain addable:
  // Main's toggle is not a Specialist capability limit.
  const selectedSkillRows = useMemo(
    () =>
      selectedSkillIds.map((id) => {
        const found = skillRows.find((row) => row.id === id)
        return found ?? { id, name: id, mainEnabled: false, missing: true }
      }),
    [selectedSkillIds, skillRows]
  )
  const addableSkills = useMemo(
    () =>
      skills
        .filter((skill) => skill.available !== false && !selectedSkillIds.includes(skill.id))
        .map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          source: skill.source
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [skills, selectedSkillIds]
  )

  const selectedConnectorRows = useMemo(
    () =>
      selectedConnectorIds.map((id) => {
        const found = connectorRows.find((row) => row.id === id)
        return found ?? { id, name: id, mainEnabled: false, available: false }
      }),
    [selectedConnectorIds, connectorRows]
  )
  const addableConnectors = useMemo(() => {
    const all: ConnectorRow[] = [
      ...connectors.map((connector) => ({
        id: connector.id,
        name: connector.displayName,
        description: connector.description,
        mainEnabled: connector.enabled,
        available: true
      })),
      ...customServers.map((server) => ({
        id: server.id,
        name: server.displayName,
        description: server.description ? `${server.name} · ${server.description}` : server.name,
        mainEnabled: server.enabled,
        available: server.availability === undefined,
        availability: server.availability
      }))
    ]
    return all
      .filter((row) => {
        if (!row.available) return false
        const custom = customServers.find((server) => server.id === row.id)
        return !selectedConnectorIds.some(
          (id) => id === row.id || (custom !== undefined && id === custom.name)
        )
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [connectors, customServers, selectedConnectorIds])

  const filteredAddableSkills = useMemo(() => {
    const tagged =
      skillTagFilter === 'all'
        ? addableSkills
        : addableSkills.filter((skill) =>
            tagAssignments.some(
              (assignment) =>
                assignment.tagId === skillTagFilter &&
                assignment.resourceType === 'catalog.skill' &&
                assignment.resourceId === skill.id
            )
          )
    if (!skillSearchQuery.trim()) return tagged
    const q = skillSearchQuery.toLowerCase()
    return tagged.filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) ||
        (skill.description && skill.description.toLowerCase().includes(q))
    )
  }, [addableSkills, skillSearchQuery, skillTagFilter, tagAssignments])

  const filteredAddableConnectors = useMemo(() => {
    const tagged =
      connectorTagFilter === 'all'
        ? addableConnectors
        : addableConnectors.filter((connector) =>
            tagAssignments.some(
              (assignment) =>
                assignment.tagId === connectorTagFilter &&
                assignment.resourceType === 'catalog.connector' &&
                assignment.resourceId === connector.id
            )
          )
    if (!connectorSearchQuery.trim()) return tagged
    const q = connectorSearchQuery.toLowerCase()
    return tagged.filter(
      (connector) =>
        connector.name.toLowerCase().includes(q) ||
        (connector.description && connector.description.toLowerCase().includes(q))
    )
  }, [addableConnectors, connectorSearchQuery, connectorTagFilter, tagAssignments])

  const addSkill = (id: string): void =>
    updateSkillIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
  const removeSkill = (id: string): void =>
    updateSkillIds((prev) => prev.filter((skillId) => skillId !== id))
  const addConnector = (id: string): void =>
    updateConnectorIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
  const removeConnector = (id: string): void =>
    updateConnectorIds((prev) => prev.filter((connectorId) => connectorId !== id))

  return (
    <section>
      <h3 className="mb-1 text-base font-semibold text-foreground">{t('Capabilities')}</h3>
      <p className="mb-4 text-[13px] leading-5 text-muted-foreground">
        {t(
          'Skills and connectors this specialist can use. Anything not chosen here stays invisible and unreachable in its sessions, even when enabled globally.'
        )}
      </p>

      {/* Full access — single option, default selected. Loads every Main Agent skill and
          connector; selecting it disables the Select capabilities panel below. */}
      <button
        type="button"
        role="switch"
        aria-checked={isFullAccess}
        aria-label={t('Full access')}
        onClick={() => onCapabilityModeChange(capabilityMode === 'full' ? 'selected' : 'full')}
        className={cn(
          'mb-2 flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
          isFullAccess ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted'
        )}
      >
        <span
          className={cn(
            'mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border-2',
            isFullAccess ? 'border-primary' : 'border-text-300'
          )}
        >
          {isFullAccess ? <span className="size-2.5 rounded-full bg-primary" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-[13px] font-semibold">
            {t('Full access')}
            <span className="rounded bg-primary px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-primary-foreground">
              {t('Default')}
            </span>
          </span>
          <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
            {t(
              "Use all of the Main Agent's skills and connectors, including new ones added later. No need to configure each item."
            )}
          </span>
        </span>
      </button>

      <div className="my-3 flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        <span className="text-[11px] text-text-300">{t('or choose specific capabilities')}</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      {/* Select capabilities — greyed and non-interactive while Full access is on. Clicking the
          greyed panel turns Full access off so the lists become editable. */}
      <div className="relative">
        <div
          className={cn('rounded-lg', isFullAccess && 'pointer-events-none opacity-45 select-none')}
        >
          <div className="mb-3 flex items-center justify-between">
            <div
              className="inline-flex gap-0.5 rounded-lg bg-muted p-1"
              role="tablist"
              aria-label={t('Capability type')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'skills'}
                onClick={() => onActiveTabChange('skills')}
                className={cn(
                  'rounded-md px-3 py-1 text-[12.5px] font-medium',
                  activeTab === 'skills'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('Skills')}{' '}
                <span className="ml-0.5 text-[11px] opacity-75">{selectedSkillIds.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'connectors'}
                onClick={() => onActiveTabChange('connectors')}
                className={cn(
                  'rounded-md px-3 py-1 text-[12.5px] font-medium',
                  activeTab === 'connectors'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('Connectors')}{' '}
                <span className="ml-0.5 text-[11px] opacity-75">{selectedConnectorIds.length}</span>
              </button>
            </div>

            {/* Add button + dropdown — right side of the same row */}
            {activeTab === 'skills' ? (
              <div className="relative" ref={skillDropdownRef}>
                <button
                  ref={skillTriggerRef}
                  type="button"
                  onClick={() => {
                    setSkillPopoverOpen((prev) => !prev)
                    setSkillSearchQuery('')
                    setTimeout(() => skillSearchRef.current?.focus(), 0)
                  }}
                  className="flex h-[28px] items-center rounded-lg border border-dashed border-border bg-card px-3 text-[12px] text-muted-foreground hover:bg-muted"
                >
                  {t('＋ Add a skill')}
                </button>
                {skillPopoverOpen ? (
                  <div className="absolute right-0 top-full z-50 mt-1 flex max-h-[260px] w-[240px] flex-col overflow-y-auto rounded-lg border border-border bg-card shadow-md">
                    <div className="sticky top-0 z-10 border-b border-border bg-card p-2">
                      <input
                        ref={skillSearchRef}
                        type="search"
                        aria-label={t('Search skills to add')}
                        aria-keyshortcuts={getSettingsSearchKeyShortcuts()}
                        placeholder={t('Search skills…')}
                        value={skillSearchQuery}
                        onChange={(e) => setSkillSearchQuery(e.target.value)}
                        className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-foreground placeholder:text-muted-foreground outline-none focus:border-primary"
                      />
                      <TagFilter
                        resourceType="catalog.skill"
                        value={skillTagFilter}
                        onChange={setSkillTagFilter}
                        className="mt-2 w-full"
                      />
                    </div>
                    <div className="flex-1">
                      {filteredAddableSkills.length === 0 ? (
                        <p className="px-3 py-3 text-[12px] text-muted-foreground">
                          {skillSearchQuery ? t('No matching skills') : t('No more skills to add')}
                        </p>
                      ) : (
                        filteredAddableSkills.map((skill) => (
                          <button
                            key={skill.id}
                            type="button"
                            onClick={() => {
                              addSkill(skill.id)
                              setSkillPopoverOpen(false)
                            }}
                            className="flex h-[32px] w-full items-center gap-2 px-3 text-left hover:bg-muted"
                          >
                            <span className="min-w-0 flex-1 truncate text-[12.5px]">
                              {skill.name}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="relative" ref={connectorDropdownRef}>
                <button
                  ref={connectorTriggerRef}
                  type="button"
                  onClick={() => {
                    setConnectorPopoverOpen((prev) => !prev)
                    setConnectorSearchQuery('')
                    setTimeout(() => connectorSearchRef.current?.focus(), 0)
                  }}
                  className="flex h-[28px] items-center rounded-lg border border-dashed border-border bg-card px-3 text-[12px] text-muted-foreground hover:bg-muted"
                >
                  {t('＋ Add a connector')}
                </button>
                {connectorPopoverOpen ? (
                  <div className="absolute right-0 top-full z-50 mt-1 flex max-h-[260px] w-[240px] flex-col overflow-y-auto rounded-lg border border-border bg-card shadow-md">
                    <div className="sticky top-0 z-10 border-b border-border bg-card p-2">
                      <input
                        ref={connectorSearchRef}
                        type="search"
                        aria-label={t('Search connectors to add')}
                        aria-keyshortcuts={getSettingsSearchKeyShortcuts()}
                        placeholder={t('Search connectors…')}
                        value={connectorSearchQuery}
                        onChange={(e) => setConnectorSearchQuery(e.target.value)}
                        className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-foreground placeholder:text-muted-foreground outline-none focus:border-primary"
                      />
                      <TagFilter
                        resourceType="catalog.connector"
                        value={connectorTagFilter}
                        onChange={setConnectorTagFilter}
                        className="mt-2 w-full"
                      />
                    </div>
                    <div className="flex-1">
                      {filteredAddableConnectors.length === 0 ? (
                        <p className="px-3 py-3 text-[12px] text-muted-foreground">
                          {connectorSearchQuery
                            ? t('No matching connectors')
                            : t('No more connectors to add')}
                        </p>
                      ) : (
                        filteredAddableConnectors.map((connector) => (
                          <button
                            key={connector.id}
                            type="button"
                            onClick={() => {
                              addConnector(connector.id)
                              setConnectorPopoverOpen(false)
                            }}
                            className="flex h-[32px] w-full items-center gap-2 px-3 text-left hover:bg-muted"
                          >
                            <span className="min-w-0 flex-1 truncate text-[12.5px]">
                              {connector.name}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {activeTab === 'skills' ? (
            <div>
              <div className="overflow-hidden rounded-lg border border-border">
                {selectedSkillRows.length === 0 ? (
                  <p className="px-3 py-3.5 text-[12px] text-muted-foreground">
                    {t('No skills added yet.')}
                  </p>
                ) : (
                  selectedSkillRows.map((skill) => {
                    const openSkill =
                      !skill.missing && onOpenSkillDetail !== undefined
                        ? () => onOpenSkillDetail(skill.id)
                        : undefined
                    return (
                      <div
                        key={skill.id}
                        {...clickableRowProps(
                          openSkill,
                          t('View {{name}} details', { name: skill.name })
                        )}
                        className={capabilityRowClassName(openSkill !== undefined)}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px]">{skill.name}</div>
                          {!skill.missing && skill.description ? (
                            <div className="truncate text-[11px] text-muted-foreground">
                              {skill.description}
                            </div>
                          ) : null}
                        </div>
                        {skill.missing ? (
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {t('Missing · unavailable')}
                          </span>
                        ) : (
                          <>
                            {skill.source ? (
                              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
                                {skill.source}
                              </span>
                            ) : null}
                            {!skill.mainEnabled ? (
                              <span className="shrink-0 text-[11px] text-muted-foreground">
                                {t('Main disabled · available here')}
                              </span>
                            ) : null}
                          </>
                        )}
                        <SettingsIconAction
                          label={t('Remove {{name}}', { name: skill.name })}
                          icon={X}
                          onClick={stopThen(() => removeSkill(skill.id))}
                          danger
                        />
                      </div>
                    )
                  })
                )}
              </div>
              <p className="mt-2.5 flex gap-2 rounded-lg bg-muted p-2.5 text-[11.5px] leading-snug text-muted-foreground">
                <span aria-hidden="true">ⓘ</span>
                <span>
                  {t(
                    'Skills start empty and must be added. Skills not listed here are hidden from this specialist, and Skill calls to them are rejected.'
                  )}
                </span>
              </p>
            </div>
          ) : null}

          {activeTab === 'connectors' ? (
            <div>
              <div className="overflow-hidden rounded-lg border border-border">
                {selectedConnectorRows.length === 0 ? (
                  <p className="px-3 py-3.5 text-[12px] text-muted-foreground">
                    {t('No connectors added yet.')}
                  </p>
                ) : (
                  selectedConnectorRows.map((connector) => {
                    const canonicalConnectorId = (): string =>
                      customServers.find(
                        (server) => server.id === connector.id || server.name === connector.id
                      )?.id ?? connector.id
                    const openConnector =
                      connector.available && onOpenConnectorDetail !== undefined
                        ? () => onOpenConnectorDetail(canonicalConnectorId())
                        : undefined
                    return (
                      <div
                        key={connector.id}
                        {...clickableRowProps(
                          openConnector,
                          t('View {{name}} details', { name: connector.name })
                        )}
                        className={capabilityRowClassName(openConnector !== undefined)}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px]">{connector.name}</div>
                          {connector.available && connector.description ? (
                            <div className="truncate text-[11px] text-muted-foreground">
                              {connector.description}
                            </div>
                          ) : null}
                        </div>
                        {!connector.available ? (
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {t('Unavailable — {{reason}}', {
                              reason: connector.availability ?? t('not installed')
                            })}
                          </span>
                        ) : !connector.mainEnabled ? (
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {t('Main disabled · available here')}
                          </span>
                        ) : null}
                        <SettingsIconAction
                          label={t('Remove {{name}}', { name: connector.name })}
                          icon={X}
                          onClick={stopThen(() => removeConnector(connector.id))}
                          danger
                        />
                      </div>
                    )
                  })
                )}
              </div>
              <p className="mt-2.5 flex gap-2 rounded-lg bg-muted p-2.5 text-[11.5px] leading-snug text-muted-foreground">
                <span aria-hidden="true">ⓘ</span>
                <span>
                  {t(
                    "Connectors start empty and must be added. Connectors not listed here are blocked at runtime for this specialist's sessions."
                  )}
                </span>
              </p>
            </div>
          ) : null}
        </div>

        {isFullAccess ? (
          <button
            type="button"
            aria-label={t('Enable select capabilities')}
            onClick={() => onCapabilityModeChange('selected')}
            className="absolute inset-0 cursor-pointer rounded-lg"
          />
        ) : null}
      </div>
    </section>
  )
}

export { SpecialistCapabilitiesSection }
