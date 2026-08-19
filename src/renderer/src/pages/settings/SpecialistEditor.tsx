import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { ChevronDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { formatDisplayNumber } from '@/lib/locale-format'
import {
  SPECIALIST_DESCRIPTION_MAX_LENGTH,
  SPECIALIST_ID_MAX_LENGTH,
  SPECIALIST_NAME_MAX_LENGTH,
  SPECIALIST_SYSTEM_PROMPT_MAX_LENGTH,
  inferSpecialistId,
  validateCreateSpecialistInput,
  validateSpecialistPackageVersion,
  validateUpdateSpecialistInput,
  type CreateSpecialistInput,
  type UpdateSpecialistInput,
  type SpecialistFieldError,
  type SpecialistProfileView
} from '../../../../shared/specialist'
import { SpecialistAvatar } from './specialist-avatar'
import { AVATAR_COLORS, AVATAR_ICONS } from './specialist-icons'
import { useSettingsStore } from '@/stores/settings-store'
import { SettingsIconAction } from './SettingsLayout'
import {
  getSettingsSearchKeyShortcuts,
  useSettingsSearchShortcut
} from './settings-search-shortcut'

type SpecialistEditorProps = {
  onCancel: () => void
  onSave: (input: CreateSpecialistInput) => Promise<void>
  existingNames?: string[]
  existingIds?: string[]
  // Edit mode: when provided, the form is prefilled from this profile and Save
  // calls onSaveEdit (with id + revision for optimistic concurrency) instead of
  // onSave.
  editSpecialist?: SpecialistProfileView
  initialInput?: CreateSpecialistInput
  onSaveEdit?: (input: UpdateSpecialistInput) => Promise<void>
  // Called when the user clicks "Reload" after a revision conflict.
  // Should fetch the latest profile from the store and return it.
  onReload?: () => Promise<SpecialistProfileView | undefined>
}

type FormState = {
  id: string
  name: string
  packageVersion: string
  description: string
  systemPrompt: string
  iconKey: string
  colorKey: string
  capabilityMode: 'full' | 'selected'
  excludedSkillIds: string[]
  selectedSkillIds: string[]
  excludedConnectorIds: string[]
  connectorIds: string[]
  // Pinned at mount from editSpecialist.revision; updated only on a successful save
  // or explicit Reload. Never updated by prop changes — that would silently defeat
  // the optimistic concurrency guard.
  baseRevision: number
}

type ConnectorRow = {
  id: string
  name: string
  description?: string
  mainEnabled: boolean
  available: boolean
  availability?: 'unavailable' | 'unauthenticated'
}

type SkillRow = {
  id: string
  name: string
  description?: string
  source?: string
  mainEnabled: boolean
  missing: boolean
}

const ICON_OPTIONS = [
  { key: 'brain', label: 'Brain' },
  { key: 'beaker', label: 'Beaker' },
  { key: 'book-open', label: 'Book' },
  { key: 'flask-conical', label: 'Flask' },
  { key: 'microscope', label: 'Microscope' },
  { key: 'search', label: 'Search' }
] as const

const COLOR_OPTIONS = [
  { key: 'blue', label: 'Blue' },
  { key: 'green', label: 'Green' },
  { key: 'teal', label: 'Teal' },
  { key: 'amber', label: 'Amber' },
  { key: 'purple', label: 'Purple' },
  { key: 'slate', label: 'Slate' }
] as const

const SpecialistEditor = ({
  onCancel,
  onSave,
  onSaveEdit,
  onReload,
  existingNames = [],
  existingIds = [],
  editSpecialist,
  initialInput
}: SpecialistEditorProps): React.JSX.Element => {
  const { t } = useTranslation()

  const isEdit = editSpecialist !== undefined
  const connectors = useSettingsStore((state) => state.connectors)
  const skills = useSettingsStore((state) => state.skills)
  const customServers = useSettingsStore((state) => state.customServers)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  const loadSkills = useSettingsStore((state) => state.loadSkills)
  const [form, setForm] = useState<FormState>(() =>
    editSpecialist
      ? {
          id: editSpecialist.id,
          name: editSpecialist.displayName ?? editSpecialist.name,
          packageVersion: editSpecialist.packageVersion ?? '0.1.0',
          description: editSpecialist.description,
          systemPrompt: editSpecialist.systemPrompt,
          iconKey: editSpecialist.iconKey ?? 'brain',
          colorKey: editSpecialist.colorKey ?? 'purple',
          capabilityMode: editSpecialist.capabilityMode,
          excludedSkillIds: editSpecialist.fullAccess.excludedSkillIds,
          selectedSkillIds: editSpecialist.selectedCapabilities.skillIds,
          excludedConnectorIds: editSpecialist.fullAccess.excludedConnectorIds,
          connectorIds: editSpecialist.selectedCapabilities.connectorIds,
          // Pin base revision at mount so concurrent remote writes do not silently
          // refresh it. Only a successful save or an explicit Reload may update it.
          baseRevision: editSpecialist.revision
        }
      : {
          id: initialInput?.id ?? '',
          name: initialInput?.name ?? '',
          packageVersion: '0.1.0',
          description: initialInput?.description ?? '',
          systemPrompt: initialInput?.systemPrompt ?? '',
          iconKey: initialInput?.iconKey ?? 'brain',
          colorKey: initialInput?.colorKey ?? 'purple',
          capabilityMode: initialInput?.capabilityMode ?? 'full',
          excludedSkillIds: initialInput?.fullAccess?.excludedSkillIds ?? [],
          selectedSkillIds: initialInput?.selectedCapabilities?.skillIds ?? [],
          excludedConnectorIds: initialInput?.fullAccess?.excludedConnectorIds ?? [],
          connectorIds: initialInput?.selectedCapabilities?.connectorIds ?? [],
          baseRevision: 0
        }
  )
  const [idTouched, setIdTouched] = useState(initialInput?.id !== undefined)
  const [fallbackId] = useState(() => crypto.randomUUID())
  const [fieldErrors, setFieldErrors] = useState<SpecialistFieldError[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()
  // Tracks a revision conflict that requires the user to reload before saving.
  const [hasConflict, setHasConflict] = useState(false)
  const [isReloading, setIsReloading] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(initialInput?.id !== undefined)
  const [activeCapTab, setActiveCapTab] = useState<'skills' | 'connectors'>('skills')
  const [skillSearchQuery, setSkillSearchQuery] = useState('')
  const [connectorSearchQuery, setConnectorSearchQuery] = useState('')
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
    const referencedIds = new Set([...form.excludedConnectorIds, ...form.connectorIds])
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
    for (const id of [...form.excludedConnectorIds, ...form.connectorIds]) {
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
  }, [connectors, customServers, form.connectorIds, form.excludedConnectorIds])

  // Main-disabled installed Skills remain selectable for a Specialist. Persisted IDs absent from
  // the live catalog are rendered locally so the user can remove them without blocking the session.
  const skillRows = useMemo(() => {
    const known: SkillRow[] = skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      mainEnabled: skill.enabled,
      missing: false
    }))
    const ids = new Set(known.map((skill) => skill.id))
    for (const id of [...form.excludedSkillIds, ...form.selectedSkillIds]) {
      if (!ids.has(id)) known.push({ id, name: id, mainEnabled: false, missing: true })
    }
    return known.sort((a, b) => a.name.localeCompare(b.name))
  }, [skills, form.excludedSkillIds, form.selectedSkillIds])

  // Selected-capabilities mode lists. Skills and Connectors are both whitelists: they start empty
  // and are added explicitly. Persisted IDs missing from the catalog stay visible (and removable)
  // so a stale reference never locks the session. Main-disabled installed items remain addable:
  // Main's toggle is not a Specialist capability limit.
  const selectedSkillRows = useMemo(
    () =>
      form.selectedSkillIds.map((id) => {
        const found = skillRows.find((row) => row.id === id)
        return found ?? { id, name: id, mainEnabled: false, missing: true }
      }),
    [form.selectedSkillIds, skillRows]
  )
  const addableSkills = useMemo(
    () =>
      skills
        .filter((skill) => !form.selectedSkillIds.includes(skill.id))
        .map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          source: skill.source
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [skills, form.selectedSkillIds]
  )

  const selectedConnectorRows = useMemo(
    () =>
      form.connectorIds.map((id) => {
        const found = connectorRows.find((row) => row.id === id)
        return found ?? { id, name: id, mainEnabled: false, available: false }
      }),
    [form.connectorIds, connectorRows]
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
        return !form.connectorIds.some(
          (id) => id === row.id || (custom !== undefined && id === custom.name)
        )
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [connectors, customServers, form.connectorIds])

  const filteredAddableSkills = useMemo(() => {
    if (!skillSearchQuery.trim()) return addableSkills
    const q = skillSearchQuery.toLowerCase()
    return addableSkills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) ||
        (skill.description && skill.description.toLowerCase().includes(q))
    )
  }, [addableSkills, skillSearchQuery])

  const filteredAddableConnectors = useMemo(() => {
    if (!connectorSearchQuery.trim()) return addableConnectors
    const q = connectorSearchQuery.toLowerCase()
    return addableConnectors.filter(
      (connector) =>
        connector.name.toLowerCase().includes(q) ||
        (connector.description && connector.description.toLowerCase().includes(q))
    )
  }, [addableConnectors, connectorSearchQuery])

  const addSkill = (id: string): void =>
    setForm((prev) =>
      prev.selectedSkillIds.includes(id)
        ? prev
        : { ...prev, selectedSkillIds: [...prev.selectedSkillIds, id] }
    )
  const removeSkill = (id: string): void =>
    setForm((prev) => ({
      ...prev,
      selectedSkillIds: prev.selectedSkillIds.filter((skillId) => skillId !== id)
    }))
  const addConnector = (id: string): void =>
    setForm((prev) =>
      prev.connectorIds.includes(id) ? prev : { ...prev, connectorIds: [...prev.connectorIds, id] }
    )
  const removeConnector = (id: string): void =>
    setForm((prev) => ({
      ...prev,
      connectorIds: prev.connectorIds.filter((connectorId) => connectorId !== id)
    }))

  const getFieldError = (field: SpecialistFieldError['field']): string | undefined =>
    fieldErrors.find((e) => e.field === field)?.message

  const isFullAccess = form.capabilityMode === 'full'
  const inferredId = inferSpecialistId(form.name)
  const generatedId = inferredId && !existingIds.includes(inferredId) ? inferredId : fallbackId
  const currentId = idTouched ? form.id : generatedId
  const submittedId = idTouched
    ? form.id.trim()
    : generatedId === fallbackId
      ? fallbackId
      : undefined
  const idError = getFieldError('id')
  const advancedVisible = advancedOpen || Boolean(idError)
  const translatedIdError =
    idError === 'ID may only contain lowercase letters, numbers, and hyphens.'
      ? t('ID may only contain lowercase letters, numbers, and hyphens.')
      : idError === 'IDs starting with os- or mcp- are reserved.'
        ? t('IDs starting with os- or mcp- are reserved.')
        : idError === 'ID is already in use.'
          ? t('ID is already in use.')
          : idError

  const validate = (): boolean => {
    // Client-side validation using the shared validator.
    const errors = isEdit
      ? validateUpdateSpecialistInput({
          id: editSpecialist.id,
          revision: form.baseRevision,
          displayName: form.name,
          description: form.description || undefined,
          systemPrompt: form.systemPrompt || undefined
        })
      : validateCreateSpecialistInput(
          {
            ...(currentId.trim() ? { id: currentId.trim() } : {}),
            name: form.name,
            displayName: form.name,
            description: form.description || undefined,
            systemPrompt: form.systemPrompt || undefined
          },
          existingNames,
          undefined,
          existingIds
        )
    if (isEdit) {
      const packageVersionError = validateSpecialistPackageVersion(form.packageVersion)
      if (packageVersionError) {
        errors.push({ field: 'packageVersion', message: packageVersionError })
      }
    }
    setFieldErrors(errors)
    return errors.length === 0
  }

  const handleSave = async (): Promise<void> => {
    if (!validate()) return

    setIsSaving(true)
    setSaveError(undefined)
    setHasConflict(false)
    try {
      const trimmed = {
        displayName: form.name.trim(),
        description: form.description.trim() || undefined,
        systemPrompt: form.systemPrompt.trim() || undefined,
        iconKey: form.iconKey,
        colorKey: form.colorKey,
        capabilityMode: form.capabilityMode,
        fullAccess: {
          ...(editSpecialist?.fullAccess ?? {
            excludedSkillIds: [],
            excludedConnectorIds: [],
            connectorTools: []
          }),
          excludedSkillIds: form.excludedSkillIds,
          excludedConnectorIds: form.excludedConnectorIds
        },
        selectedCapabilities: {
          ...(editSpecialist?.selectedCapabilities ?? {
            skillIds: [],
            connectorIds: [],
            connectorTools: []
          }),
          skillIds: form.selectedSkillIds,
          connectorIds: form.connectorIds
        }
      }
      if (editSpecialist) {
        // Send the base revision pinned at mount (or last successful save / reload),
        // not the current prop revision, which may have been refreshed by a remote
        // write and would silently defeat the optimistic concurrency guard.
        await onSaveEdit?.({
          id: editSpecialist.id,
          revision: form.baseRevision,
          packageVersion: form.packageVersion,
          ...(editSpecialist.setupPending ? { completeSetup: true as const } : {}),
          ...trimmed
        })
        // Advance the base revision only after a confirmed save.
        setForm((prev) => ({ ...prev, baseRevision: prev.baseRevision + 1 }))
      } else {
        await onSave({
          ...(submittedId ? { id: submittedId } : {}),
          name: form.name.trim(),
          ...trimmed
        })
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : isEdit
            ? t('Could not save changes.')
            : t('Could not create specialist.')
      // Detect optimistic concurrency conflict — preserve local edits and show the
      // conflict banner instead of a generic error so the user can choose to reload.
      if (/revision conflict/i.test(message)) {
        setHasConflict(true)
      } else {
        setSaveError(message)
      }
    } finally {
      setIsSaving(false)
    }
  }

  // Reloads the latest revision from the store. The caller is expected to return the
  // fresh profile. When it does, form state (including baseRevision) is reset from the
  // fresh data so the user's stale edits are fully replaced. The conflict banner is
  // cleared and Save is re-enabled only after this reset completes.
  const handleReload = async (): Promise<void> => {
    if (!onReload) return
    setIsReloading(true)
    try {
      const fresh = await onReload()
      if (fresh) {
        setForm({
          id: fresh.id,
          name: fresh.displayName ?? fresh.name,
          packageVersion: fresh.packageVersion ?? '0.1.0',
          description: fresh.description,
          systemPrompt: fresh.systemPrompt,
          iconKey: fresh.iconKey ?? 'brain',
          colorKey: fresh.colorKey ?? 'purple',
          capabilityMode: fresh.capabilityMode,
          excludedSkillIds: fresh.fullAccess.excludedSkillIds,
          selectedSkillIds: fresh.selectedCapabilities.skillIds,
          excludedConnectorIds: fresh.fullAccess.excludedConnectorIds,
          connectorIds: fresh.selectedCapabilities.connectorIds,
          baseRevision: fresh.revision
        })
        setHasConflict(false)
      }
    } finally {
      setIsReloading(false)
    }
  }

  return (
    <div className="p-5">
      <div className="max-w-2xl">
        {/* Save error — shown at the top so it is immediately visible */}
        {saveError ? (
          <div
            className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            role="alert"
          >
            <svg className="mt-0.5 shrink-0" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M8 4.5v4M8 10.5v.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <span>{saveError}</span>
          </div>
        ) : null}

        {/* Saved identity bar — stable reference of what's currently persisted (edit only).
            In create mode there is nothing saved yet, so the bar is omitted. */}
        {isEdit && editSpecialist ? (
          <div className="mb-5 flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <SpecialistAvatar iconKey={editSpecialist.iconKey} colorKey={editSpecialist.colorKey} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-semibold text-foreground">
                  {editSpecialist.displayName ?? editSpecialist.name}
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {editSpecialist.setupPending ? t('Setup incomplete') : t('Saved')}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 max-w-xl text-xs text-muted-foreground">
                {editSpecialist.description || t('No description')}
              </p>
              {editSpecialist.origin === 'imported' ? (
                <div className="mt-2 text-xs text-muted-foreground">
                  <strong className="text-foreground">{t('Package provenance')}</strong>
                  <span className="block">
                    {t('Imported · Original version {{version}} · {{status}}', {
                      version: editSpecialist.packageVersion ?? '0.1.0',
                      status: editSpecialist.modifiedSinceImport
                        ? t('Modified after import')
                        : t('Unchanged since import')
                    })}
                  </span>
                </div>
              ) : null}
              {editSpecialist.setupPending ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t(
                    'This imported Specialist is saved but disabled. Save changes to complete setup and enable it.'
                  )}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Identity section */}
        <section className="mb-6">
          <h3 className="mb-1 text-base font-semibold text-foreground">{t('Identity')}</h3>
          <p className="mb-4 text-[13px] leading-5 text-muted-foreground">
            {t('How this specialist appears in the registry and session picker.')}
          </p>

          {/* Live preview — reflects the current icon + color + name, matching the list */}
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-border p-3">
            <SpecialistAvatar iconKey={form.iconKey} colorKey={form.colorKey} size="lg" />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">
                {form.name.trim() || t('Untitled specialist')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('Preview — matches the list and picker.')}
              </span>
            </div>
            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              {t('Live')}
            </span>
          </div>

          <div className="mb-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold">{t('Icon')}</label>
              <Select
                value={form.iconKey}
                onValueChange={(iconKey) => setForm((prev) => ({ ...prev, iconKey }))}
              >
                <SelectTrigger aria-label={t('Specialist icon')}>
                  <span className="flex items-center gap-2">
                    {(() => {
                      const Icon = AVATAR_ICONS[form.iconKey] ?? AVATAR_ICONS.brain
                      return <Icon className="size-4 shrink-0" aria-hidden="true" />
                    })()}
                    <span>{ICON_OPTIONS.find((option) => option.key === form.iconKey)?.label}</span>
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {ICON_OPTIONS.map((option) => {
                    const Icon = AVATAR_ICONS[option.key] ?? AVATAR_ICONS.brain
                    return (
                      <SelectItem key={option.key} value={option.key}>
                        <span className="flex items-center gap-2">
                          <Icon className="size-4 shrink-0" aria-hidden="true" />
                          {option.label}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold">{t('Color')}</label>
              <Select
                value={form.colorKey}
                onValueChange={(colorKey) => setForm((prev) => ({ ...prev, colorKey }))}
              >
                <SelectTrigger aria-label={t('Specialist color')}>
                  <span className="flex items-center gap-2">
                    <span
                      className="size-3.5 shrink-0 rounded border border-black/10"
                      style={{ background: AVATAR_COLORS[form.colorKey] }}
                      aria-hidden="true"
                    />
                    <span>
                      {COLOR_OPTIONS.find((option) => option.key === form.colorKey)?.label}
                    </span>
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {COLOR_OPTIONS.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      <span className="flex items-center gap-2">
                        <span
                          className="size-3.5 shrink-0 rounded border border-black/10"
                          style={{ background: AVATAR_COLORS[option.key] }}
                          aria-hidden="true"
                        />
                        {option.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Name */}
          <div className="mb-4">
            <label htmlFor="sp-name" className="mb-1.5 flex items-baseline justify-between text-xs">
              <span>{isEdit ? t('Display name') : t('Name')}</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {form.name.length} / {SPECIALIST_NAME_MAX_LENGTH}
              </span>
            </label>
            <Input
              id="sp-name"
              value={form.name}
              maxLength={SPECIALIST_NAME_MAX_LENGTH}
              onChange={(e) => {
                setForm((prev) => ({ ...prev, name: e.target.value }))
                setFieldErrors((prev) => prev.filter((er) => er.field !== 'name'))
              }}
              placeholder={t('e.g. RNA-seq Reviewer')}
              aria-describedby={getFieldError('name') ? 'sp-name-err' : undefined}
              aria-invalid={!!getFieldError('name')}
              className={cn(getFieldError('name') && 'border-destructive')}
            />
            {getFieldError('name') ? (
              <p id="sp-name-err" className="mt-1 text-xs text-destructive" role="alert">
                {getFieldError('name')}
              </p>
            ) : null}
          </div>

          {/* Description */}
          <div className="mb-0">
            <label
              htmlFor="sp-description"
              className="mb-1.5 flex items-baseline justify-between text-xs"
            >
              <span>
                <Trans
                  i18nKey="Description <muted>(optional)</muted>"
                  components={{ muted: <span className="text-muted-foreground" /> }}
                />
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {form.description.length} / {SPECIALIST_DESCRIPTION_MAX_LENGTH}
              </span>
            </label>
            <Input
              id="sp-description"
              value={form.description}
              maxLength={SPECIALIST_DESCRIPTION_MAX_LENGTH}
              onChange={(e) => {
                setForm((prev) => ({ ...prev, description: e.target.value }))
                setFieldErrors((prev) => prev.filter((er) => er.field !== 'description'))
              }}
              aria-describedby={getFieldError('description') ? 'sp-description-err' : undefined}
              aria-invalid={!!getFieldError('description')}
              className={cn(getFieldError('description') && 'border-destructive')}
              placeholder={t('Short description shown in the list and picker')}
            />
            {getFieldError('description') ? (
              <p id="sp-description-err" className="mt-1 text-xs text-destructive" role="alert">
                {getFieldError('description')}
              </p>
            ) : null}
          </div>

          {!isEdit ? (
            <div className="mt-4">
              <button
                type="button"
                aria-expanded={advancedVisible}
                aria-controls="specialist-advanced-settings"
                onClick={() => setAdvancedOpen((open) => !open)}
                className="flex min-h-8 w-full items-center gap-2 rounded-lg py-1.5 text-left text-sm font-medium whitespace-nowrap text-foreground transition-colors duration-150 outline-none motion-reduce:transition-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <ChevronDown
                  className={cn(
                    'size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
                    !advancedVisible && '-rotate-90'
                  )}
                  aria-hidden="true"
                />
                {t('Advanced settings')}
              </button>

              {advancedVisible ? (
                <div id="specialist-advanced-settings" className="mt-3">
                  <label htmlFor="sp-specialist-id" className="mb-1.5 block text-sm font-medium">
                    {t('Specialist ID')}{' '}
                    <span className="font-normal text-muted-foreground">{t('(optional)')}</span>
                  </label>
                  <Input
                    id="sp-specialist-id"
                    value={currentId}
                    maxLength={SPECIALIST_ID_MAX_LENGTH}
                    className={cn('font-mono', idError && 'border-destructive')}
                    aria-invalid={idError ? true : undefined}
                    aria-describedby="sp-specialist-id-help"
                    onChange={(event) => {
                      const id = event.target.value
                      const idErrors = id.trim()
                        ? validateCreateSpecialistInput(
                            { id: id.trim(), name: form.name },
                            existingNames,
                            undefined,
                            existingIds
                          ).filter((error) => error.field === 'id')
                        : []
                      setIdTouched(true)
                      setForm((previous) => ({ ...previous, id }))
                      setFieldErrors((previous) => [
                        ...previous.filter((error) => error.field !== 'id'),
                        ...idErrors
                      ])
                    }}
                  />
                  <p
                    id="sp-specialist-id-help"
                    className={cn(
                      'mt-1 text-xs',
                      idError ? 'text-destructive' : 'text-muted-foreground'
                    )}
                    role={idError ? 'alert' : undefined}
                  >
                    {translatedIdError ??
                      t(
                        'Generated from the name when possible. Edit it now or leave it blank to generate automatically; it cannot be changed after creation.'
                      )}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {isEdit && editSpecialist ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="sp-package-version" className="mb-1.5 block text-xs font-semibold">
                  {t('Package version')}
                </label>
                <Input
                  id="sp-package-version"
                  value={form.packageVersion}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, packageVersion: e.target.value }))
                    setFieldErrors((prev) =>
                      prev.filter((error) => error.field !== 'packageVersion')
                    )
                  }}
                  aria-invalid={!!getFieldError('packageVersion')}
                  aria-describedby={
                    getFieldError('packageVersion') ? 'sp-package-version-err' : undefined
                  }
                />
                {getFieldError('packageVersion') ? (
                  <p
                    id="sp-package-version-err"
                    className="mt-1 text-xs text-destructive"
                    role="alert"
                  >
                    {getFieldError('packageVersion')}
                  </p>
                ) : null}
              </div>
              <div>
                <label htmlFor="sp-specialist-name" className="mb-1.5 block text-xs font-semibold">
                  {t('Specialist name')}
                </label>
                <Input id="sp-specialist-name" value={editSpecialist.name} readOnly />
                <p className="mt-1 text-xs text-muted-foreground">{t('Fixed after creation.')}</p>
              </div>
              <div>
                <label htmlFor="sp-specialist-id" className="mb-1.5 block text-xs font-semibold">
                  {t('Specialist ID')}
                </label>
                <Input id="sp-specialist-id" value={editSpecialist.id} readOnly />
              </div>
            </div>
          ) : null}
        </section>

        {/* Instructions section */}
        <section className="mb-6 border-t border-border pt-5">
          <h3 className="mb-1 text-base font-semibold text-foreground">{t('Instructions')}</h3>
          <p className="mb-4 text-[13px] leading-5 text-muted-foreground">
            {t(
              "Appended to the app's base prompt — does not replace safety rules or tool instructions. Optional."
            )}
          </p>
          <div className="relative">
            <label htmlFor="sp-system-prompt" className="sr-only">
              {t('Instructions')}
            </label>
            <Textarea
              id="sp-system-prompt"
              value={form.systemPrompt}
              onChange={(e) => setForm((prev) => ({ ...prev, systemPrompt: e.target.value }))}
              maxLength={SPECIALIST_SYSTEM_PROMPT_MAX_LENGTH}
              placeholder={t('Optional — leave empty to use the base prompt as-is.')}
              className="min-h-[120px] resize-y pb-7 text-[13px]"
            />
            <span className="pointer-events-none absolute bottom-2 right-3 text-[11px] tabular-nums text-muted-foreground">
              {formatDisplayNumber(form.systemPrompt.length)} /{' '}
              {formatDisplayNumber(SPECIALIST_SYSTEM_PROMPT_MAX_LENGTH)}
            </span>
            {getFieldError('systemPrompt') ? (
              <p className="mt-1 text-xs text-danger-000">{getFieldError('systemPrompt')}</p>
            ) : null}
          </div>
        </section>

        {/* Capabilities */}
        <section className="border-t border-border pt-5">
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
            onClick={() =>
              setForm((prev) => ({
                ...prev,
                capabilityMode: prev.capabilityMode === 'full' ? 'selected' : 'full'
              }))
            }
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
            <span className="text-[11px] text-text-300">
              {t('or choose specific capabilities')}
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>

          {/* Select capabilities — greyed and non-interactive while Full access is on. Clicking the
              greyed panel turns Full access off so the lists become editable. */}
          <div className="relative">
            <div
              className={cn(
                'rounded-lg',
                isFullAccess && 'pointer-events-none opacity-45 select-none'
              )}
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
                    aria-selected={activeCapTab === 'skills'}
                    onClick={() => setActiveCapTab('skills')}
                    className={cn(
                      'rounded-md px-3 py-1 text-[12.5px] font-medium',
                      activeCapTab === 'skills'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t('Skills')}{' '}
                    <span className="ml-0.5 text-[11px] opacity-75">
                      {form.selectedSkillIds.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeCapTab === 'connectors'}
                    onClick={() => setActiveCapTab('connectors')}
                    className={cn(
                      'rounded-md px-3 py-1 text-[12.5px] font-medium',
                      activeCapTab === 'connectors'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t('Connectors')}{' '}
                    <span className="ml-0.5 text-[11px] opacity-75">
                      {form.connectorIds.length}
                    </span>
                  </button>
                </div>

                {/* Add button + dropdown — right side of the same row */}
                {activeCapTab === 'skills' ? (
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
                        </div>
                        <div className="flex-1">
                          {filteredAddableSkills.length === 0 ? (
                            <p className="px-3 py-3 text-[12px] text-muted-foreground">
                              {skillSearchQuery
                                ? t('No matching skills')
                                : t('No more skills to add')}
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

              {activeCapTab === 'skills' ? (
                <div>
                  <div className="overflow-hidden rounded-lg border border-border">
                    {selectedSkillRows.length === 0 ? (
                      <p className="px-3 py-3.5 text-[12px] text-muted-foreground">
                        {t('No skills added yet.')}
                      </p>
                    ) : (
                      selectedSkillRows.map((skill) => (
                        <div
                          key={skill.id}
                          className="flex h-[40px] items-center gap-2.5 border-b border-border px-3 last:border-b-0"
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
                            onClick={() => removeSkill(skill.id)}
                            danger
                          />
                        </div>
                      ))
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

              {activeCapTab === 'connectors' ? (
                <div>
                  <div className="overflow-hidden rounded-lg border border-border">
                    {selectedConnectorRows.length === 0 ? (
                      <p className="px-3 py-3.5 text-[12px] text-muted-foreground">
                        {t('No connectors added yet.')}
                      </p>
                    ) : (
                      selectedConnectorRows.map((connector) => (
                        <div
                          key={connector.id}
                          className="flex h-[40px] items-center gap-2.5 border-b border-border px-3 last:border-b-0"
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
                            onClick={() => removeConnector(connector.id)}
                            danger
                          />
                        </div>
                      ))
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
                onClick={() => setForm((prev) => ({ ...prev, capabilityMode: 'selected' }))}
                className="absolute inset-0 cursor-pointer rounded-lg"
              />
            ) : null}
          </div>
        </section>

        {/* Revision conflict banner — shown when another save raced ahead.
            Local edits are preserved so the user can review before reloading. */}
        {hasConflict ? (
          <div
            role="alert"
            aria-label={t('Revision conflict')}
            className="mt-4 flex items-start gap-3 rounded-lg border border-border bg-muted/50 p-3 text-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-foreground">
                {t('Someone else saved a newer version')}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(
                  'Your local edits are preserved. Reload to get the latest version (your unsaved changes will be discarded), or cancel and try again.'
                )}
              </p>
            </div>
            {onReload ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleReload()}
                disabled={isReloading}
                className="shrink-0"
              >
                {isReloading ? t('Reloading…') : t('Reload')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* Footer actions */}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isSaving}>
            {t('Cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving || !form.name.trim() || hasConflict}
          >
            {isSaving
              ? isEdit
                ? t('Saving…')
                : t('Creating…')
              : isEdit
                ? t('Save changes')
                : t('Create specialist')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export { SpecialistEditor }
