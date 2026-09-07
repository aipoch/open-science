import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger
} from '@/components/ui/select'
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
  type SpecialistView
} from '../../../../shared/specialist'
import { SpecialistAvatar } from './specialist-avatar'
import { AVATAR_COLORS, SPECIALIST_COLOR_OPTIONS } from './specialist-icons'
import { APP_ICON_GROUPS, APP_ICONS, DEFAULT_APP_ICON } from '@/components/app-icons/registry'
import { SpecialistCapabilitiesSection } from './SpecialistCapabilitiesSection'
import { formFromProfile, useSpecialistEditorForm } from './useSpecialistEditorForm'

type SpecialistEditorProps = {
  onCancel: () => void
  onSave: (input: CreateSpecialistInput) => Promise<void>
  existingNames?: string[]
  existingIds?: string[]
  // Edit mode: when provided, the form is prefilled from this profile and Save
  // calls onSaveEdit (with id + revision for optimistic concurrency) instead of
  // onSave.
  editSpecialist?: SpecialistView
  initialInput?: CreateSpecialistInput
  onSaveEdit?: (input: UpdateSpecialistInput) => Promise<void>
  // Called when the user clicks "Reload" after a revision conflict.
  // Should fetch the latest profile from the store and return it.
  onReload?: () => Promise<SpecialistView | undefined>
  // Called when a selected Skill row is clicked to view that Skill in Settings.
  onOpenSkillDetail?: (skillId: string) => void
  // Called when a selected Connector row is clicked to view that Connector in
  // Settings. Receives the canonical id: a custom server referenced by its legacy
  // name is resolved to server.id before the call.
  onOpenConnectorDetail?: (connectorId: string) => void
}

// Flat view of the grouped registry for selected-value lookups (trigger label, previews).
const ICON_ENTRIES = APP_ICON_GROUPS.flatMap((group) => group.icons)

const SpecialistEditor = ({
  onCancel,
  onSave,
  onSaveEdit,
  onReload,
  onOpenSkillDetail,
  onOpenConnectorDetail,
  existingNames = [],
  existingIds = [],
  editSpecialist,
  initialInput
}: SpecialistEditorProps): React.JSX.Element => {
  const { t } = useTranslation()

  // Group headers for the icon picker. Literal t() call sites keep the i18n catalog
  // guard able to see them; a dynamic t(group.label) lookup would be invisible to it.
  const iconGroupLabels: Record<string, string> = {
    science: t('Science'),
    research: t('Research'),
    roles: t('Roles'),
    engineering: t('Engineering')
  }

  const isEdit = editSpecialist !== undefined
  // Form state machine: mount-time seeding (profile, create prefill, or restorable
  // draft) plus the unsaved-form draft kept in the specialist store. Restore rules
  // live in the hook.
  const {
    form,
    setForm,
    idTouched,
    setIdTouched,
    activeCapTab,
    setActiveCapTab,
    clearDraft,
    suppressNextDraftWrite
  } = useSpecialistEditorForm({ editSpecialist, initialInput })
  const [fallbackId] = useState(() => crypto.randomUUID())
  const [fieldErrors, setFieldErrors] = useState<SpecialistFieldError[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()
  // Tracks a revision conflict that requires the user to reload before saving.
  const [hasConflict, setHasConflict] = useState(false)
  const [isReloading, setIsReloading] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(initialInput?.id !== undefined)

  const getFieldError = (field: SpecialistFieldError['field']): string | undefined =>
    fieldErrors.find((e) => e.field === field)?.message

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
        description: isEdit ? form.description.trim() : form.description.trim() || undefined,
        systemPrompt: isEdit ? form.systemPrompt.trim() : form.systemPrompt.trim() || undefined,
        iconKey: form.iconKey,
        colorKey: form.colorKey,
        capabilityMode: form.capabilityMode,
        fullAccess: {
          excludedSkillIds: form.excludedSkillIds,
          excludedConnectorIds: form.excludedConnectorIds,
          connectorTools: form.fullConnectorTools
        },
        selectedCapabilities: {
          skillIds: form.selectedSkillIds,
          connectorIds: form.connectorIds,
          connectorTools: form.selectedConnectorTools
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
        // Advance the base revision only after a confirmed save, and keep that form update
        // from re-creating the draft the save just cleared.
        suppressNextDraftWrite()
        setForm((prev) => ({ ...prev, baseRevision: prev.baseRevision + 1 }))
        clearDraft()
      } else {
        await onSave({
          ...(submittedId ? { id: submittedId } : {}),
          name: form.name.trim(),
          ...trimmed
        })
        clearDraft()
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
        setForm(formFromProfile(fresh))
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
                      const Icon = APP_ICONS[form.iconKey] ?? DEFAULT_APP_ICON
                      return <Icon className="size-4 shrink-0" aria-hidden="true" />
                    })()}
                    <span>
                      {(() => {
                        const label = ICON_ENTRIES.find(
                          (option) => option.key === form.iconKey
                        )?.label
                        return label === undefined ? undefined : t(label)
                      })()}
                    </span>
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {APP_ICON_GROUPS.map((group) => (
                    <SelectGroup key={group.key}>
                      <SelectLabel>{iconGroupLabels[group.key] ?? group.label}</SelectLabel>
                      {group.icons.map((option) => (
                        <SelectItem key={option.key} value={option.key}>
                          <span className="flex items-center gap-2">
                            <option.Icon className="size-4 shrink-0" aria-hidden="true" />
                            {t(option.label)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
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
                      {t(
                        SPECIALIST_COLOR_OPTIONS.find((option) => option.key === form.colorKey)
                          ?.label ?? 'Purple'
                      )}
                    </span>
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {SPECIALIST_COLOR_OPTIONS.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      <span className="flex items-center gap-2">
                        <span
                          className="size-3.5 shrink-0 rounded border border-black/10"
                          style={{ background: AVATAR_COLORS[option.key] }}
                          aria-hidden="true"
                        />
                        {t(option.label)}
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
        <section className="mb-6">
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
        <SpecialistCapabilitiesSection
          capabilityMode={form.capabilityMode}
          onCapabilityModeChange={(capabilityMode) =>
            setForm((prev) => ({ ...prev, capabilityMode }))
          }
          selectedSkillIds={form.selectedSkillIds}
          excludedSkillIds={form.excludedSkillIds}
          selectedConnectorIds={form.connectorIds}
          excludedConnectorIds={form.excludedConnectorIds}
          updateSkillIds={(update) =>
            setForm((prev) => ({ ...prev, selectedSkillIds: update(prev.selectedSkillIds) }))
          }
          updateConnectorIds={(update) =>
            setForm((prev) => ({ ...prev, connectorIds: update(prev.connectorIds) }))
          }
          activeTab={activeCapTab}
          onActiveTabChange={setActiveCapTab}
          onOpenSkillDetail={onOpenSkillDetail}
          onOpenConnectorDetail={onOpenConnectorDetail}
        />

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
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              // Cancel discards the form explicitly; the draft must not resurrect it later.
              clearDraft()
              onCancel()
            }}
            disabled={isSaving}
          >
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
