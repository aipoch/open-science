/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4 */
import type { TFunction } from 'i18next'
import { AlertTriangle, ChevronDown, FileUp, Upload, X } from 'lucide-react'
import { RadioGroup } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import type { SkillPackageFileInfo, SkillReference } from '../../../../shared/settings'
import { serializePersonalSkillDocument } from '../../../../shared/personal-skill-document'
import {
  isSkillPackageBudgetedPath,
  SKILL_IMPORT_LIMITS
} from '../../../../shared/skill-import-limits'
import { parseSkillDocument } from '../../../../shared/skill-frontmatter'
import { ErrorNotice } from '@/components/error-notice'
import { FileDropOverlay } from '@/components/FileDropOverlay'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useFileDropZone } from '@/hooks/useFileDropZone'
import { useSettingsStore } from '@/stores/settings-store'
import { SettingsIconAction, SettingsLoadNotice } from './SettingsLayout'

type SkillEditorReference = SkillReference & { sizeBytes?: number }

export type SkillDraft = {
  id?: string
  name: string
  description: string
  body: string
  metadata?: Record<string, string>
  references?: SkillEditorReference[]
  packageFiles?: SkillPackageFileInfo[]
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_NAME_MAX_LENGTH = 64

// Reserved name namespaces a user-authored skill may not claim (mirrors the main-process rule):
// `os-` is the app's own materialized prefix, `mcp-` is reserved for MCP-provided skills.
const RESERVED_SKILL_NAME_PREFIXES = ['os-', 'mcp-']

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const formatBytes = (bytes: number, locale: string): string => {
  const units = [
    { size: 1024 * 1024, suffix: 'MB' },
    { size: 1024, suffix: 'KB' }
  ]
  const unit = units.find((candidate) => bytes >= candidate.size)
  if (!unit) return `${bytes} B`
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    bytes / unit.size
  )} ${unit.suffix}`
}

const isEditorManagedPackagePath = (path: string): boolean => {
  if (path === 'SKILL.md') return true
  if (!path.startsWith('references/')) return false
  return !path.slice('references/'.length).includes('/')
}

const getPreservedPackageFiles = (
  packageFiles: readonly SkillPackageFileInfo[]
): SkillPackageFileInfo[] =>
  packageFiles.filter(
    (file) => isSkillPackageBudgetedPath(file.path) && !isEditorManagedPackagePath(file.path)
  )

type SkillBudgetViolation =
  { kind: 'fileSize'; path: string } | { kind: 'fileCount' } | { kind: 'totalSize' }

type SkillBudgetEvaluation = {
  totalBytes: number
  violation: SkillBudgetViolation | null
}

const evaluateSkillBudget = (
  documentBytes: number,
  references: ReadonlyArray<{ path: string; sizeBytes: number }>,
  preservedFiles: readonly SkillPackageFileInfo[]
): SkillBudgetEvaluation => {
  const packageFiles = [
    { path: 'SKILL.md', sizeBytes: documentBytes },
    ...references.map((reference) => ({
      path: `references/${reference.path}`,
      sizeBytes: reference.sizeBytes
    })),
    ...preservedFiles
  ]
  const totalBytes = packageFiles.reduce((total, file) => total + file.sizeBytes, 0)
  let violation: SkillBudgetViolation | null = null

  const oversizedFile = packageFiles.find(
    (file) => file.sizeBytes > SKILL_IMPORT_LIMITS.maxFileBytes
  )
  if (oversizedFile) {
    violation = { kind: 'fileSize', path: oversizedFile.path }
  } else if (packageFiles.length > SKILL_IMPORT_LIMITS.maxFiles) {
    violation = { kind: 'fileCount' }
  } else if (totalBytes > SKILL_IMPORT_LIMITS.maxTotalBytes) {
    violation = { kind: 'totalSize' }
  }

  return { totalBytes, violation }
}

const budgetViolationMessage = (
  violation: SkillBudgetViolation,
  t: TFunction,
  locale: string
): string => {
  switch (violation.kind) {
    case 'fileSize':
      return t('{{file}} exceeds the {{limit}} per-file limit.', {
        file: violation.path,
        limit: formatBytes(SKILL_IMPORT_LIMITS.maxFileBytes, locale)
      })
    case 'fileCount':
      return t('A skill package can contain at most {{limit}} files.', {
        limit: SKILL_IMPORT_LIMITS.maxFiles
      })
    case 'totalSize':
      return t('The skill package exceeds the {{limit}} total size limit.', {
        limit: formatBytes(SKILL_IMPORT_LIMITS.maxTotalBytes, locale)
      })
  }
}

// Reads a File as base64 (for binary-safe reference transport to the main process).
const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error())
    reader.readAsDataURL(file)
  })

type SkillEditorProps = {
  initial: SkillDraft
  onCancel: () => void
  onSave: (draft: SkillDraft) => Promise<void>
}

const SkillEditorAlert = ({ message }: { message: string }): React.JSX.Element => (
  <div
    role="alert"
    className="mt-2 flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
  >
    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
    <span className="min-w-0 break-words">{message}</span>
  </div>
)

// Create/edit form for a personal skill: Identity (name/description) + Content (SKILL.md body).
// Pasting a full SKILL.md with a frontmatter block auto-fills name/description.
const SkillEditor = ({ initial, onCancel, onSave }: SkillEditorProps): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const { t: tCommon } = useTranslation()
  const isCreate = !initial.id
  const skills = useSettingsStore((state) => state.skills)
  const preservedPackageFiles = useMemo(
    () => getPreservedPackageFiles(initial.packageFiles ?? []),
    [initial.packageFiles]
  )
  const maxReferenceFiles = Math.max(
    0,
    SKILL_IMPORT_LIMITS.maxFiles - 1 - preservedPackageFiles.length
  )
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  const [body, setBody] = useState(initial.body)
  const [metadata, setMetadata] = useState(initial.metadata)
  const [frontmatterImportMode, setFrontmatterImportMode] = useState(false)
  const [contentMode, setContentMode] = useState<'write' | 'upload'>('write')
  const [references, setReferences] = useState<SkillEditorReference[]>(() =>
    (initial.references ?? []).map((ref) => ({
      path: ref.path,
      dataBase64: ref.dataBase64,
      sizeBytes: ref.sizeBytes ?? 0
    }))
  )
  const [advancedOpen, setAdvancedOpen] = useState(
    (initial.references?.length ?? 0) > 0 || preservedPackageFiles.length > 0
  )
  const [saving, setSaving] = useState(false)
  const [addingReferences, setAddingReferences] = useState(false)
  const [referenceProgress, setReferenceProgress] = useState<{
    completed: number
    total: number
  } | null>(null)
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const [contentImportError, setContentImportError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const currentName = name.trim()

  // Validates the immutable name against the same rules the main process enforces, plus a live
  // collision check against already-loaded personal skills. Only meaningful when creating.
  const nameError = useMemo((): string | null => {
    if (!isCreate) return null
    if (!currentName) return t('Name is required.')
    if (!SKILL_NAME_PATTERN.test(currentName) || currentName.length > SKILL_NAME_MAX_LENGTH) {
      return t('Use up to 64 lowercase letters, numbers, and single hyphens.')
    }
    if (RESERVED_SKILL_NAME_PREFIXES.some((prefix) => currentName.startsWith(prefix))) {
      // Intl joins the prefixes with the locale's own "or" — a hardcoded ' or ' would leak
      // English into the zh sentence, which uses 「或」 with no surrounding spaces.
      const prefixes = new Intl.ListFormat(i18n.language, {
        style: 'short',
        type: 'disjunction'
      }).format(RESERVED_SKILL_NAME_PREFIXES)
      return t("Can't start with {{prefixes}}.", { prefixes })
    }
    if (skills.some((entry) => entry.id === `personal-${currentName}`)) {
      return t('A skill with this name already exists.')
    }
    return null
  }, [isCreate, currentName, skills, t, i18n.language])

  const importedContent = frontmatterImportMode ? parseSkillDocument(body) : undefined
  const persistedBody = importedContent?.hasFrontmatter ? importedContent.body : body
  const persistedMetadata = importedContent?.hasFrontmatter ? importedContent.metadata : metadata
  const metadataEntries = Object.entries(persistedMetadata ?? {})
  const documentBytes = useMemo(
    () =>
      utf8ByteLength(
        serializePersonalSkillDocument({
          name: currentName,
          description: description.trim(),
          body: persistedBody,
          metadata: persistedMetadata
        })
      ),
    [currentName, description, persistedBody, persistedMetadata]
  )
  const budgetEvaluation = useMemo(
    () =>
      evaluateSkillBudget(
        documentBytes,
        references.map((reference) => ({
          path: reference.path,
          sizeBytes: reference.sizeBytes ?? 0
        })),
        preservedPackageFiles
      ),
    [documentBytes, references, preservedPackageFiles]
  )
  const { totalBytes } = budgetEvaluation
  const budgetError = budgetEvaluation.violation
    ? budgetViolationMessage(budgetEvaluation.violation, t, i18n.language)
    : null
  const canSave =
    currentName.length > 0 &&
    persistedBody.trim().length > 0 &&
    !nameError &&
    !budgetError &&
    !saving &&
    !addingReferences

  // Plain textarea edits are always literal body content and keep the separately displayed metadata.
  // In import mode the visible frontmatter is authoritative, so removing it clears derived metadata.
  const handleBodyChange = (value: string): void => {
    if (frontmatterImportMode) {
      const parsed = parseSkillDocument(value)
      if (parsed.hasFrontmatter) {
        if (isCreate && parsed.name !== undefined) setName(parsed.name)
        if (parsed.description !== undefined) setDescription(parsed.description)
        setMetadata(parsed.metadata)
      } else {
        setMetadata(undefined)
        setFrontmatterImportMode(false)
      }
    }
    setBody(value)
  }

  // Explicit paste/upload/drop imports opt into frontmatter semantics. The raw block remains visible
  // in the textarea so users can edit or remove it; it is stripped only from the persisted body.
  const importContent = (value: string): void => {
    const parsed = parseSkillDocument(value)
    if (parsed.hasFrontmatter) {
      if (isCreate && parsed.name && !name.trim()) setName(parsed.name)
      if (parsed.description && !description.trim()) setDescription(parsed.description)
      setMetadata(parsed.metadata)
      setFrontmatterImportMode(true)
    } else {
      setMetadata(undefined)
      setFrontmatterImportMode(false)
    }
    setBody(value)
  }

  const handleBodyPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = event.clipboardData.getData('text/plain')
    const replacesAll =
      body.length === 0 ||
      (event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === body.length)
    if (!replacesAll || !parseSkillDocument(pasted).hasFrontmatter) return

    event.preventDefault()
    importContent(pasted)
  }

  // Uploads a text/markdown file into the content body, then flips back to the Write editor.
  const importContentFile = async (file: File): Promise<void> => {
    setContentImportError(null)
    if (file.size > SKILL_IMPORT_LIMITS.maxFileBytes) {
      setContentImportError(
        t('The selected content file exceeds the {{limit}} per-file limit.', {
          limit: formatBytes(SKILL_IMPORT_LIMITS.maxFileBytes, i18n.language)
        })
      )
      return
    }

    try {
      importContent(await file.text())
      setContentMode('write')
    } catch (error) {
      setContentImportError(
        error instanceof Error && error.message
          ? error.message
          : t('Unable to read the selected content file.')
      )
    }
  }

  const uploadContent = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt,text/*'
    input.onchange = () => {
      const file = input.files?.[0]
      if (file) void importContentFile(file)
    }
    input.click()
  }

  // Loads the first dropped text file into the body — the drop counterpart of uploadContent().
  const dropContent = async (files: File[]): Promise<void> => {
    const file = files[0]
    if (file) await importContentFile(file)
  }

  // Adds one or more supporting files to the references list (base64-encoded), replacing any
  // existing entry with the same name.
  const addReferences = async (files: File[]): Promise<void> => {
    if (addingReferences || files.length === 0) return

    setReferenceError(null)
    const selected = new Map<string, File>()
    for (const file of files) selected.set(file.name, file)
    const retained = references.filter((reference) => !selected.has(reference.path))
    const prospectiveBudget = evaluateSkillBudget(
      documentBytes,
      [
        ...retained.map((reference) => ({
          path: reference.path,
          sizeBytes: reference.sizeBytes ?? 0
        })),
        ...[...selected.values()].map((file) => ({
          path: file.name,
          sizeBytes: file.size
        }))
      ],
      preservedPackageFiles
    )
    if (prospectiveBudget.violation) {
      setReferenceError(budgetViolationMessage(prospectiveBudget.violation, t, i18n.language))
      return
    }

    setAddingReferences(true)
    setReferenceProgress({ completed: 0, total: selected.size })
    try {
      const added: SkillEditorReference[] = []
      for (const file of selected.values()) {
        added.push({
          path: file.name,
          sizeBytes: file.size,
          dataBase64: await fileToBase64(file)
        })
        setReferenceProgress({ completed: added.length, total: selected.size })
      }
      setReferences([...retained, ...added])
    } catch (error) {
      setReferenceError(
        error instanceof Error && error.message
          ? error.message
          : t('Unable to read the selected reference files.')
      )
    } finally {
      setAddingReferences(false)
      setReferenceProgress(null)
    }
  }

  // Each content area is its own drop zone with an independent overlay state.
  const contentDrop = useFileDropZone({
    enabled: true,
    onFiles: (files) => void dropContent(files)
  })
  const referenceDrop = useFileDropZone({
    enabled: !addingReferences,
    onFiles: (files) => void addReferences(files)
  })

  const handleSave = async (): Promise<void> => {
    if (!canSave) return
    setSaveError(null)
    setSaving(true)
    try {
      await onSave({
        id: initial.id,
        name: currentName,
        description: description.trim(),
        body: persistedBody,
        metadata: persistedMetadata,
        references: references.map((ref) => ({ path: ref.path, dataBase64: ref.dataBase64 }))
      })
    } catch (error) {
      setSaveError(
        error instanceof Error && error.message ? error.message : t('Unable to save this skill.')
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-5">
          <label data-slot="settings-editor-field" className="grid min-w-0 gap-1.5">
            <span className="text-sm font-medium text-foreground">{t('Name')}</span>
            <Input
              aria-label={t('Skill name')}
              value={name}
              onChange={isCreate ? (event) => setName(event.target.value) : undefined}
              disabled={!isCreate}
              aria-invalid={nameError ? true : undefined}
              placeholder={t('e.g. changelog-style')}
            />
            {nameError ? <span className="text-xs text-danger-000">{nameError}</span> : null}
          </label>
          <label data-slot="settings-editor-field" className="grid min-w-0 gap-1.5">
            <span className="text-sm font-medium text-foreground">{t('Description')}</span>
            <Textarea
              aria-label={t('Skill description')}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              placeholder={t(
                'One sentence — what does this skill teach the agent, and when does it apply?'
              )}
              className="resize-none text-sm"
            />
            <span className="text-xs text-muted-foreground">
              {t('This is how the agent decides when to use the skill — be specific.')}
            </span>
          </label>
          <div data-slot="settings-editor-field" className="grid min-w-0 gap-1.5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('Content')}</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {t('Markdown shown to the agent when the skill is invoked.')}
                </p>
              </div>
              <RadioGroup.Root
                aria-label={t('Content mode')}
                value={contentMode}
                onValueChange={(value) => setContentMode(value as 'write' | 'upload')}
                orientation="horizontal"
                className="inline-flex shrink-0 items-center rounded-lg bg-muted p-0.5"
              >
                <RadioGroup.Item
                  value="write"
                  className={`inline-flex h-7 items-center rounded-md px-2.5 text-sm transition-colors motion-reduce:transition-none ${
                    contentMode === 'write'
                      ? 'bg-card font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t('Write')}
                </RadioGroup.Item>
                <RadioGroup.Item
                  value="upload"
                  className={`inline-flex h-7 items-center rounded-md px-2.5 text-sm transition-colors motion-reduce:transition-none ${
                    contentMode === 'upload'
                      ? 'bg-card font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t('Upload')}
                </RadioGroup.Item>
              </RadioGroup.Root>
            </div>

            {contentMode === 'write' ? (
              <>
                <Textarea
                  aria-label={t('Skill body')}
                  value={body}
                  onChange={(event) => handleBodyChange(event.target.value)}
                  onPaste={handleBodyPaste}
                  rows={16}
                  placeholder={'# Instructions\n\nStep-by-step guidance for the agent…'}
                  className="min-h-64 resize-y font-mono text-[13px]"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  <Trans
                    i18nKey="Paste a full SKILL.md — if it has a <code>---</code> metadata block at the top, the fields above auto-fill."
                    components={{ code: <code className="font-mono" /> }}
                  />
                </p>
                {!frontmatterImportMode && metadataEntries.length > 0 ? (
                  <div
                    aria-label={t('Skill metadata')}
                    className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">{t('Saved metadata')}</p>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {metadataEntries.map(([key, value]) => (
                          <span key={key} className="break-all">
                            {key}: {value}
                          </span>
                        ))}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t('Clear skill metadata')}
                      onClick={() => setMetadata(undefined)}
                    >
                      {t('Clear')}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                onClick={uploadContent}
                {...contentDrop.dropZoneProps}
                className="relative flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-8 text-center transition-colors motion-reduce:transition-none hover:bg-muted/50"
              >
                {contentDrop.isDragging ? (
                  <FileDropOverlay label={t('Drop to upload')} className="rounded-lg" />
                ) : null}
                <Upload className="size-5 text-muted-foreground" aria-hidden="true" />
                <span className="text-sm font-medium text-foreground">
                  {t('Upload a SKILL.md or text file')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('Its contents fill the editor; switch back to Write to tweak.')}
                </span>
              </button>
            )}
            {contentImportError ? <SkillEditorAlert message={contentImportError} /> : null}
          </div>

          <div>
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls="skill-advanced-settings"
              onClick={() => setAdvancedOpen((open) => !open)}
              className="flex min-h-8 w-full items-center gap-2 rounded-lg py-1.5 text-left text-sm font-medium whitespace-nowrap text-foreground transition-colors duration-150 outline-none motion-reduce:transition-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ChevronDown
                className={`size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${
                  advancedOpen ? '' : '-rotate-90'
                }`}
                aria-hidden="true"
              />
              {t('Advanced settings')}
            </button>

            {advancedOpen ? (
              <section id="skill-advanced-settings" className="mt-3">
                <div>
                  <h2 className="text-sm font-medium text-foreground">{t('References')}</h2>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {t(
                      'Supporting files (scripts, templates, data) the skill can read at runtime.'
                    )}
                  </p>
                </div>

                <p
                  aria-label={t('Skill package usage')}
                  className="mt-2 text-xs text-muted-foreground"
                >
                  {t('References: {{count}} / {{limit}}; package: {{size}} / {{total}}', {
                    count: references.length,
                    limit: maxReferenceFiles,
                    size: formatBytes(totalBytes, i18n.language),
                    total: formatBytes(SKILL_IMPORT_LIMITS.maxTotalBytes, i18n.language)
                  })}
                </p>
                {preservedPackageFiles.length > 0 ? (
                  <div
                    aria-label={t('Preserved package files')}
                    className="mt-3 rounded-lg border border-border bg-muted/20 px-3 py-2"
                  >
                    <p className="text-xs font-medium text-foreground">
                      {t('Preserved package files')} ({preservedPackageFiles.length})
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('These files stay unchanged when you save in the editor.')}
                    </p>
                    <ul className="mt-1 max-h-36 divide-y divide-border overflow-y-auto">
                      {preservedPackageFiles.map((file) => (
                        <li key={file.path} className="flex items-center gap-2 py-1.5">
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                            {file.path}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatBytes(file.sizeBytes, i18n.language)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {referenceError ? <SkillEditorAlert message={referenceError} /> : null}
                {referenceProgress ? (
                  <p aria-live="polite" className="mt-2 text-xs text-muted-foreground">
                    {t('Reading reference files... {{completed}} / {{total}}', referenceProgress)}
                  </p>
                ) : null}

                <label
                  {...referenceDrop.dropZoneProps}
                  aria-busy={addingReferences}
                  className="relative mt-3 flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-6 text-center transition-colors motion-reduce:transition-none hover:bg-muted/50 focus-within:ring-3 focus-within:ring-ring/50"
                >
                  {referenceDrop.isDragging ? (
                    <FileDropOverlay label={t('Drop reference files')} className="rounded-lg" />
                  ) : null}
                  <input
                    type="file"
                    multiple
                    aria-label={t('Add reference files')}
                    disabled={addingReferences}
                    className="sr-only"
                    onChange={(event) => void addReferences(Array.from(event.target.files ?? []))}
                  />
                  <FileUp className="size-5 text-muted-foreground" aria-hidden="true" />
                  <span className="text-sm font-medium text-foreground">
                    {t('Drop reference files or click to browse')}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <Trans
                      i18nKey="Saved under <code>references/</code> in the skill."
                      components={{ code: <code className="font-mono" /> }}
                    />
                  </span>
                </label>

                {references.length > 0 ? (
                  <ul className="mt-3 flex flex-col divide-y divide-border">
                    {references.map((ref) => (
                      <li key={ref.path} className="flex items-center gap-2 py-2 text-sm">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                          references/{ref.path}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatBytes(ref.sizeBytes ?? 0, i18n.language)}
                        </span>
                        <SettingsIconAction
                          label={`Remove ${ref.path}`}
                          icon={X}
                          onClick={() => {
                            setReferences((prev) => prev.filter((item) => item.path !== ref.path))
                            setReferenceError(null)
                          }}
                          className="size-6"
                          danger
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
          </div>
          {budgetError ? <SkillEditorAlert message={budgetError} /> : null}
          {saveError ? <SkillEditorAlert message={saveError} /> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-card px-5 py-3">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {tCommon('Cancel')}
        </Button>
        <Button type="button" onClick={() => void handleSave()} disabled={!canSave}>
          {saving ? t('Saving…') : initial.id ? t('Save') : t('Publish')}
        </Button>
      </div>
    </div>
  )
}

type SkillEditLoaderProps = {
  skillId: string
  onDone: () => void
}

// Loads an existing personal skill's content, then renders the editor pre-filled.
const SkillEditLoader = ({ skillId, onDone }: SkillEditLoaderProps): React.JSX.Element => {
  const { t } = useTranslation()
  const updateSkill = useSettingsStore((state) => state.updateSkill)
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'not-found'>('loading')
  const loadRequestRef = useRef(0)

  const requestDetail = useCallback(
    (requestId: number): void => {
      void window.api.settings.getSkillDetail(skillId).then(
        (detail) => {
          if (loadRequestRef.current !== requestId) return
          setDraft({
            id: detail.id,
            name: detail.name,
            description: detail.description,
            body: detail.body,
            metadata: detail.metadata,
            references: detail.references.map((ref) => ({
              path: ref.path,
              sizeBytes: ref.sizeBytes
            })),
            packageFiles: detail.packageFiles
          })
          setLoadState('ready')
        },
        (error) => {
          if (loadRequestRef.current !== requestId) return
          const message = error instanceof Error ? error.message : String(error)
          setLoadState(message.includes(`Unknown skill: ${skillId}`) ? 'not-found' : 'error')
        }
      )
    },
    [skillId]
  )

  const loadDetail = useCallback((): void => {
    const requestId = ++loadRequestRef.current
    setDraft(null)
    setLoadState('loading')
    requestDetail(requestId)
  }, [requestDetail])

  useEffect(() => {
    requestDetail(++loadRequestRef.current)
    return () => {
      loadRequestRef.current += 1
    }
  }, [requestDetail])

  if (!draft) {
    if (loadState === 'not-found') {
      return (
        <div role="alert" className="flex min-h-64 justify-center p-5">
          <ErrorNotice
            icon={AlertTriangle}
            tone="red"
            title={t('This Skill is no longer available.')}
            primaryButton={{ label: t('Back'), onClick: onDone }}
          />
        </div>
      )
    }
    return (
      <div className="p-5">
        <SettingsLoadNotice
          state={loadState === 'error' ? 'error' : 'loading'}
          loadingLabel={t('Loading Skill…')}
          errorMessage={t('Open Science could not load this Skill.')}
          onRetry={loadDetail}
        />
      </div>
    )
  }

  return (
    <SkillEditor
      initial={draft}
      onCancel={onDone}
      onSave={async (next) => {
        await updateSkill({
          id: next.id ?? skillId,
          description: next.description,
          body: next.body,
          metadata: next.metadata,
          references: next.references
        })
        onDone()
      }}
    />
  )
}

export { SkillEditor, SkillEditLoader }
