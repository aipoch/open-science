import { AlertTriangle, Upload } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FileDropOverlay } from '@/components/FileDropOverlay'
import { Button } from '@/components/ui/button'
import { useFileDropZone } from '@/hooks/useFileDropZone'
import { useSettingsStore } from '@/stores/settings-store'
import { SKILL_IMPORT_LIMITS } from '../../../../shared/skill-import-limits'
import { parseSkillDocument } from '../../../../shared/skill-frontmatter'
import { SkillImportCandidatePreview } from './SkillImportCandidatePreview'
import { useSkillImportCandidatePreview } from './useSkillImportCandidatePreview'

// Rounds a byte count to whole MB for a user-facing size-limit message.
const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`

// A danger banner for a parse/validation failure (invalid bundle, missing SKILL.md, no name, ...).
const ErrorBanner = ({ notice }: { notice: Notice }): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000">
      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>{t(notice.key, notice.params)}</span>
    </div>
  )
}

// A muted note listing skills the bundle contained but couldn't import (too large, no SKILL.md, ...),
// so a partial import tells the user exactly what was left out instead of failing silently.
const SkippedNote = ({ items }: { items: SkippedEntry[] }): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">
        {t('Skipped {{count}} skills', {
          defaultValue_one: 'Skipped {{count}} skill',
          count: items.length
        })}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={`${item.fileName}:${item.source}`} className="truncate">
            {item.source} — {item.reason}
          </li>
        ))}
      </ul>
    </div>
  )
}

type SkillUploadViewProps = {
  onUploaded: () => void
  onWriteInstead: () => void
}

// One import candidate awaiting confirmation. A bundle candidate maps one skill root inside a .zip /
// .skill archive (a multi-skill bundle yields several); a markdown candidate maps one uploaded
// SKILL.md. Each carries a stable `key` for selection tracking, and bundles keep the file's base64 so
// confirming re-uses it without re-reading the file.
type Candidate =
  | {
      kind: 'bundle'
      key: string
      fileName: string
      base64: string
      subPath: string
      name: string
      description: string
      metadata: Record<string, string>
      body: string
      previewError?: string
      files: string[]
      alreadyImported: boolean
      replaceableId?: string
    }
  | {
      kind: 'markdown'
      key: string
      fileName: string
      name: string
      description: string
      metadata: Record<string, string>
      body: string
      // Ours, so it carries a key; the bundle variant's comes from the main process as plain text.
      previewError?: Notice
    }

// One skill a bundle contained but that couldn't be imported (too large, no SKILL.md, no name, ...),
// tagged with the file it came from so the user can tell which upload it belongs to.
type SkippedEntry = { fileName: string; source: string; reason: string }

// A message kept as its key plus interpolation values instead of a finished string. Parse errors and
// the import summary outlive the event that produced them, so translating them at render time is what
// lets them follow a language switch rather than freezing in the language that was active on upload.
type NoticeKey =
  | '{{fileName}}: file is too large (limit {{limit}}).'
  | '{{fileName}}: no skills found in the bundle.'
  | '{{fileName}}: {{message}}'
  | '{{fileName}}: needs a name in its YAML frontmatter.'
  | '{{fileName}}: unsupported file — upload a .md file or a .zip / .skill bundle.'
  | '{{fileName}}: preview exceeds the {{limit}} limit. You can still import it.'
  | 'Selection is too large ({{total}}); upload at most {{limit}} at a time.'
  | 'Imported {{imported}} · skipped {{skipped}} · failed {{failed}}'

type Notice = { key: NoticeKey; params?: Record<string, string> }

// The outcome of parsing one picked file: zero-or-more candidates, an optional per-file error (so one
// bad file never blocks the others), and any skills inside the file that were individually skipped.
type ParseResult = { candidates: Candidate[]; error?: Notice; skipped?: SkippedEntry[] }

// Strips the electron IPC wrapper ("Error invoking remote method '…': Error: …") off a rejection so
// the user sees only the human-readable message, never the internal method name.
const cleanMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}

// Reads a File as base64 (for binary-safe bundle transport to the main process).
const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

// Full-page batch upload: drop (or click to browse) any mix of SKILL.md files and .zip / .skill
// bundles, each of which may contain several skills. Everything is parsed into a checklist first;
// nothing is written until the user picks rows and confirms.
const SkillUploadView = ({
  onUploaded,
  onWriteInstead
}: SkillUploadViewProps): React.JSX.Element => {
  const { t } = useTranslation()
  const createSkill = useSettingsStore((state) => state.createSkill)
  const importSkillZipBatch = useSettingsStore((state) => state.importSkillZipBatch)
  const previewSkillZip = useSettingsStore((state) => state.previewSkillZip)
  const skills = useSettingsStore((state) => state.skills)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [errors, setErrors] = useState<Notice[]>([])
  const [skipped, setSkipped] = useState<SkippedEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [summary, setSummary] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const candidatePreview = useSkillImportCandidatePreview()

  // Parses one picked file into its candidates, capturing a per-file error instead of throwing.
  const parseFile = async (file: File): Promise<ParseResult> => {
    const name = file.name.toLowerCase()
    const isBundle = name.endsWith('.zip') || name.endsWith('.skill')

    // Reject on file.size BEFORE reading the file into memory / base64 / IPC. A bundle is bounded by
    // the whole-bundle cap (it may hold many skills); a bare .md by the per-file cap.
    const sizeLimit = isBundle
      ? SKILL_IMPORT_LIMITS.maxBundleBytes
      : SKILL_IMPORT_LIMITS.maxFileBytes
    if (file.size > sizeLimit) {
      return {
        candidates: [],
        error: {
          key: '{{fileName}}: file is too large (limit {{limit}}).',
          params: { fileName: file.name, limit: mb(sizeLimit) }
        }
      }
    }

    if (isBundle) {
      try {
        const base64 = await fileToBase64(file)
        const { previews, skipped } = await previewSkillZip(base64)
        const skippedEntries = skipped.map((entry) => ({
          fileName: file.name,
          source: entry.source,
          reason: entry.reason
        }))
        if (previews.length === 0 && skipped.length === 0) {
          return {
            candidates: [],
            error: {
              key: '{{fileName}}: no skills found in the bundle.',
              params: { fileName: file.name }
            }
          }
        }
        return {
          candidates: previews.map((preview) => ({
            kind: 'bundle',
            key: `${file.name}::${preview.subPath}`,
            fileName: file.name,
            base64,
            subPath: preview.subPath,
            name: preview.name,
            description: preview.description,
            metadata: preview.metadata,
            body: preview.body,
            previewError: preview.previewError,
            files: preview.files,
            alreadyImported: preview.alreadyImported,
            replaceableId: preview.replaceableId
          })),
          skipped: skippedEntries
        }
      } catch (error) {
        // The message half comes from the main process, so it passes through in whatever language the
        // backend produced; only the "<file>: <message>" frame is localized.
        return {
          candidates: [],
          error: {
            key: '{{fileName}}: {{message}}',
            params: { fileName: file.name, message: cleanMessage(error) }
          }
        }
      }
    }

    if (name.endsWith('.md') || name.endsWith('.markdown')) {
      const parsed = parseSkillDocument(await file.text())
      if (!parsed.name) {
        return {
          candidates: [],
          error: {
            key: '{{fileName}}: needs a name in its YAML frontmatter.',
            params: { fileName: file.name }
          }
        }
      }
      return {
        candidates: [
          {
            kind: 'markdown',
            key: file.name,
            fileName: file.name,
            name: parsed.name,
            description: parsed.description ?? '',
            metadata: parsed.metadata,
            body: parsed.body,
            previewError:
              file.size > SKILL_IMPORT_LIMITS.maxPreviewContentBytes
                ? {
                    key: '{{fileName}}: preview exceeds the {{limit}} limit. You can still import it.',
                    params: {
                      fileName: file.name,
                      limit: mb(SKILL_IMPORT_LIMITS.maxPreviewContentBytes)
                    }
                  }
                : undefined
          }
        ]
      }
    }

    return {
      candidates: [],
      error: {
        key: '{{fileName}}: unsupported file — upload a .md file or a .zip / .skill bundle.',
        params: { fileName: file.name }
      }
    }
  }

  // Parses every picked file into one flat, unchecked-by-default candidate list.
  const handleFiles = async (files: File[]): Promise<void> => {
    if (busy || files.length === 0) return
    setBusy(true)
    setSummary(null)
    try {
      // Cap the whole selection before reading anything, so a batch drop can't allocate an unbounded
      // amount of memory across all files at once.
      const totalSize = files.reduce((sum, file) => sum + file.size, 0)
      if (totalSize > SKILL_IMPORT_LIMITS.maxBundleBytes) {
        setCandidates([])
        setErrors([
          {
            key: 'Selection is too large ({{total}}); upload at most {{limit}} at a time.',
            params: {
              total: mb(totalSize),
              limit: mb(SKILL_IMPORT_LIMITS.maxBundleBytes)
            }
          }
        ])
        setSkipped([])
        setSelected(new Set())
        return
      }
      const results = await Promise.all(files.map(parseFile))
      setCandidates(results.flatMap((result) => result.candidates))
      setErrors(results.map((result) => result.error).filter((error): error is Notice => !!error))
      setSkipped(results.flatMap((result) => result.skipped ?? []))
      // Default selection is empty — the user opts in per row (or via Select all).
      setSelected(new Set())
    } finally {
      setBusy(false)
    }
  }

  // Imports every checked candidate, tallying successes / skips (no-op re-imports) / failures. Bundle
  // candidates are grouped by their source file so a bundle holding many skills is decoded and unpacked
  // ONCE (one batch call) instead of re-sent per skill.
  const importSelected = async (): Promise<void> => {
    if (busy || !candidates || selected.size === 0) return
    setBusy(true)
    setSummary(null)
    let imported = 0
    let skipped = 0
    let failed = 0

    const chosen = candidates.filter((entry) => selected.has(entry.key))
    const bundleGroups = new Map<string, Extract<Candidate, { kind: 'bundle' }>[]>()
    const markdowns: Extract<Candidate, { kind: 'markdown' }>[] = []
    for (const candidate of chosen) {
      if (candidate.kind === 'bundle') {
        const group = bundleGroups.get(candidate.base64) ?? []
        group.push(candidate)
        bundleGroups.set(candidate.base64, group)
      } else {
        markdowns.push(candidate)
      }
    }

    for (const [base64, group] of bundleGroups) {
      try {
        const { results } = await importSkillZipBatch(
          base64,
          group.map((candidate) => ({
            subPath: candidate.subPath,
            replaceId: candidate.replaceableId
          }))
        )
        for (const result of results) {
          if (result.error) failed += 1
          else if (result.status === 'unchanged') skipped += 1
          else imported += 1
        }
      } catch {
        failed += group.length
      }
    }

    for (const candidate of markdowns) {
      try {
        await createSkill({
          name: candidate.name,
          description: candidate.description,
          metadata: candidate.metadata,
          body: candidate.body
        })
        imported += 1
      } catch {
        failed += 1
      }
    }

    setSummary({
      key: 'Imported {{imported}} · skipped {{skipped}} · failed {{failed}}',
      params: {
        imported: String(imported),
        skipped: String(skipped),
        failed: String(failed)
      }
    })
    setBusy(false)
    if (imported > 0) onUploaded()
  }

  const toggle = (key: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const allSelected =
    candidates !== null && candidates.length > 0 && selected.size === candidates.length

  const toggleAll = (): void =>
    setSelected(() =>
      allSelected ? new Set() : new Set((candidates ?? []).map((candidate) => candidate.key))
    )

  const invertSelection = (): void =>
    setSelected((prev) => {
      const next = new Set<string>()
      for (const candidate of candidates ?? []) {
        if (!prev.has(candidate.key)) next.add(candidate.key)
      }
      return next
    })

  const onInputChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? [])
    if (files.length > 0) void handleFiles(files)
    event.target.value = ''
  }

  // Drag-and-drop shares the same parse path as the picker; the overlay signals the drop target.
  const { isDragging, dropZoneProps } = useFileDropZone({
    enabled: !busy,
    onFiles: (files) => void handleFiles(files)
  })

  // Names already in the catalog (any source) — used to flag same-name collisions on the checklist.
  const existingNames = new Set(skills.map((skill) => skill.name.trim().toLowerCase()))

  // Confirmation page: a checklist of every parsed candidate (nothing checked by default).
  if (candidates !== null && candidates.length > 0) {
    return (
      <div className="p-5">
        <h2 className="text-base font-semibold text-foreground">{t('Confirm import')}</h2>
        <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
          {t('Pick the skills you want to add. Nothing is written until you import.')}
        </p>

        <div className="mt-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-foreground">
                {t('Found {{count}} skills', {
                  defaultValue_one: 'Found {{count}} skill',
                  count: candidates.length
                })}
              </h3>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  aria-label={t('Select all')}
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={busy}
                  className="size-4 shrink-0"
                />
                {t('Select all')}
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={invertSelection}
                disabled={busy}
              >
                {t('Invert')}
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void importSelected()}
              disabled={busy || selected.size === 0}
            >
              {busy
                ? t('Importing…')
                : t('Import selected ({{selected}})', { selected: selected.size })}
            </Button>
          </div>

          <ul className="mt-2 flex flex-col divide-y divide-border">
            {candidates.map((candidate) => {
              const nameExists = existingNames.has(candidate.name.trim().toLowerCase())
              const alreadyImported = candidate.kind === 'bundle' && candidate.alreadyImported
              const secondary =
                candidate.kind === 'bundle'
                  ? `${candidate.fileName} · ${candidate.subPath}`
                  : candidate.fileName
              return (
                <li key={candidate.key} className="flex items-center gap-3 py-2.5">
                  <input
                    type="checkbox"
                    aria-label={t('Select {{name}}', {
                      name: candidate.name
                    })}
                    checked={selected.has(candidate.key)}
                    onChange={() => toggle(candidate.key)}
                    disabled={busy}
                    className="size-4 shrink-0"
                  />
                  <button
                    type="button"
                    aria-label={t('Preview {{name}}', {
                      name: candidate.name
                    })}
                    onClick={() =>
                      candidatePreview.openPreview(() => {
                        if (candidate.previewError) {
                          // Bundle previews carry a main-process string; markdown ones carry our key.
                          throw new Error(
                            typeof candidate.previewError === 'string'
                              ? candidate.previewError
                              : t(candidate.previewError.key, candidate.previewError.params)
                          )
                        }
                        return {
                          name: candidate.name,
                          description: candidate.description,
                          sourceLabel: secondary,
                          metadata: candidate.metadata,
                          body: candidate.body,
                          files:
                            candidate.kind === 'bundle' ? candidate.files : [candidate.fileName]
                        }
                      })
                    }
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 px-1 py-1">
                      <span className="block truncate text-sm text-foreground">
                        {candidate.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {secondary}
                      </span>
                    </span>
                    {alreadyImported ? (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {t('Already imported')}
                      </span>
                    ) : nameExists ? (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {t('Name exists')}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        {errors.map((error) => (
          <ErrorBanner key={`${error.key}:${error.params?.fileName ?? ''}`} notice={error} />
        ))}
        {skipped.length > 0 ? <SkippedNote items={skipped} /> : null}
        {summary ? (
          <p className="mt-3 text-xs text-muted-foreground">{t(summary.key, summary.params)}</p>
        ) : null}

        <div className="mt-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setCandidates(null)
              setErrors([])
              setSkipped([])
              setSelected(new Set())
              setSummary(null)
            }}
            disabled={busy}
            className="text-muted-foreground"
          >
            {t('Choose different files')}
          </Button>
        </div>
        <SkillImportCandidatePreview {...candidatePreview.previewProps} />
      </div>
    )
  }

  return (
    <div className="p-5">
      <h2 className="text-base font-semibold text-foreground">{t('Upload skills')}</h2>
      <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
        {t(
          'Add skills from SKILL.md files or .zip / .skill bundles on your computer. You can select several files at once, and a single archive may contain multiple skills.'
        )}
      </p>

      <label
        {...dropZoneProps}
        className="relative mt-4 flex cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-6 py-10 text-center transition-colors motion-reduce:transition-none hover:bg-muted/40"
      >
        {isDragging ? <FileDropOverlay label={t('Drop to upload')} className="rounded-lg" /> : null}
        <input
          type="file"
          multiple
          accept=".md,.markdown,.zip,.skill"
          aria-label={t('Upload skill files')}
          onChange={onInputChange}
          className="sr-only"
        />
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Upload className="size-5" aria-hidden="true" />
        </span>
        <span className="text-sm font-medium text-foreground">
          {busy ? t('Reading…') : t('Drag and drop or click to upload')}
        </span>
        <span className="max-w-sm text-xs text-muted-foreground">
          {t(
            ".md files need a name and description in YAML frontmatter. .zip or .skill bundles must contain a SKILL.md. You'll confirm before anything is added."
          )}
        </span>
      </label>

      {errors.map((error) => (
        <ErrorBanner key={`${error.key}:${error.params?.fileName ?? ''}`} notice={error} />
      ))}
      {skipped.length > 0 ? <SkippedNote items={skipped} /> : null}
      {summary ? (
        <p className="mt-3 text-xs text-muted-foreground">{t(summary.key, summary.params)}</p>
      ) : null}

      <div className="mt-5 text-center">
        <Button type="button" variant="ghost" onClick={onWriteInstead}>
          {t('Write from scratch instead')}
        </Button>
      </div>
    </div>
  )
}

export { SkillUploadView }
