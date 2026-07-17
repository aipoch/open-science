import { AlertTriangle, Upload } from 'lucide-react'
import { useState } from 'react'

import { FileDropOverlay } from '@/components/FileDropOverlay'
import { Button } from '@/components/ui/button'
import { useFileDropZone } from '@/hooks/useFileDropZone'
import { useSettingsStore } from '@/stores/settings-store'

// A danger banner for a parse/validation failure (invalid bundle, missing SKILL.md, no name, ...).
const ErrorBanner = ({ message }: { message: string }): React.JSX.Element => (
  <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000">
    <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
    <span>{message}</span>
  </div>
)

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
      body: string
    }

// The outcome of parsing one picked file: zero-or-more candidates, plus an optional per-file error so
// one bad file never blocks the others.
type ParseResult = { candidates: Candidate[]; error?: string }

// Pulls name/description out of a .md frontmatter block, returning the stripped body (mirrors the
// editor's consumeFrontmatter so an uploaded SKILL.md fills the same fields).
const consumeFrontmatter = (
  text: string
): { name?: string; description?: string; body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!match) return { body: text }

  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (field) fields[field[1].toLowerCase()] = field[2].trim()
  }
  return {
    name: fields.name,
    description: fields.description,
    body: text.slice(match[0].length).replace(/^\n+/, '')
  }
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
  const createSkill = useSettingsStore((state) => state.createSkill)
  const importSkillZip = useSettingsStore((state) => state.importSkillZip)
  const previewSkillZip = useSettingsStore((state) => state.previewSkillZip)
  const skills = useSettingsStore((state) => state.skills)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [summary, setSummary] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Parses one picked file into its candidates, capturing a per-file error instead of throwing.
  const parseFile = async (file: File): Promise<ParseResult> => {
    const name = file.name.toLowerCase()

    if (name.endsWith('.zip') || name.endsWith('.skill')) {
      try {
        const base64 = await fileToBase64(file)
        const previews = await previewSkillZip(base64)
        if (previews.length === 0) {
          return { candidates: [], error: `${file.name}: no skills found in the bundle.` }
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
            files: preview.files,
            alreadyImported: preview.alreadyImported,
            replaceableId: preview.replaceableId
          }))
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'could not read the bundle.'
        return { candidates: [], error: `${file.name}: ${detail}` }
      }
    }

    if (name.endsWith('.md') || name.endsWith('.markdown')) {
      const parsed = consumeFrontmatter(await file.text())
      if (!parsed.name) {
        return { candidates: [], error: `${file.name}: needs a name in its YAML frontmatter.` }
      }
      return {
        candidates: [
          {
            kind: 'markdown',
            key: file.name,
            fileName: file.name,
            name: parsed.name,
            description: parsed.description ?? '',
            body: parsed.body
          }
        ]
      }
    }

    return {
      candidates: [],
      error: `${file.name}: unsupported file — upload a .md file or a .zip / .skill bundle.`
    }
  }

  // Parses every picked file into one flat, unchecked-by-default candidate list.
  const handleFiles = async (files: File[]): Promise<void> => {
    if (busy || files.length === 0) return
    setBusy(true)
    setSummary(null)
    try {
      const results = await Promise.all(files.map(parseFile))
      setCandidates(results.flatMap((result) => result.candidates))
      setErrors(results.map((result) => result.error).filter((error): error is string => !!error))
      // Default selection is empty — the user opts in per row (or via Select all).
      setSelected(new Set())
    } finally {
      setBusy(false)
    }
  }

  // Imports every checked candidate, tallying successes / skips (no-op re-imports) / failures.
  const importSelected = async (): Promise<void> => {
    if (busy || !candidates || selected.size === 0) return
    setBusy(true)
    setSummary(null)
    let imported = 0
    let skipped = 0
    let failed = 0
    for (const candidate of candidates.filter((entry) => selected.has(entry.key))) {
      try {
        if (candidate.kind === 'bundle') {
          const result = await importSkillZip(candidate.base64, {
            subPath: candidate.subPath,
            replaceId: candidate.replaceableId
          })
          if (result.status === 'unchanged') skipped += 1
          else imported += 1
        } else {
          await createSkill({
            name: candidate.name,
            description: candidate.description,
            body: candidate.body
          })
          imported += 1
        }
      } catch {
        failed += 1
      }
    }
    setSummary(`Imported ${imported} · skipped ${skipped} · failed ${failed}`)
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
        <h2 className="text-base font-semibold text-foreground">Confirm import</h2>
        <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
          Pick the skills you want to add. Nothing is written until you import.
        </p>

        <div className="mt-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-foreground">
                Found {candidates.length} skill{candidates.length === 1 ? '' : 's'}
              </h3>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={busy}
                  className="size-4 shrink-0"
                />
                Select all
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={invertSelection}
                disabled={busy}
              >
                Invert
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void importSelected()}
              disabled={busy || selected.size === 0}
            >
              {busy ? 'Importing…' : `Import selected (${selected.size})`}
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
                    aria-label={`Select ${candidate.name}`}
                    checked={selected.has(candidate.key)}
                    onChange={() => toggle(candidate.key)}
                    disabled={busy}
                    className="size-4 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{candidate.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {secondary}
                    </span>
                  </div>
                  {alreadyImported ? (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      Already imported
                    </span>
                  ) : nameExists ? (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      Name exists
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>

        {errors.map((error) => (
          <ErrorBanner key={error} message={error} />
        ))}
        {summary ? <p className="mt-3 text-xs text-muted-foreground">{summary}</p> : null}

        <div className="mt-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setCandidates(null)
              setErrors([])
              setSelected(new Set())
              setSummary(null)
            }}
            disabled={busy}
            className="text-muted-foreground"
          >
            Choose different files
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-5">
      <h2 className="text-base font-semibold text-foreground">Upload skills</h2>
      <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
        Add skills from SKILL.md files or .zip / .skill bundles on your computer. You can select
        several files at once, and a single archive may contain multiple skills.
      </p>

      <label
        {...dropZoneProps}
        className="relative mt-4 flex cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-6 py-10 text-center transition-colors motion-reduce:transition-none hover:bg-muted/40"
      >
        {isDragging ? <FileDropOverlay label="Drop to upload" className="rounded-lg" /> : null}
        <input
          type="file"
          multiple
          accept=".md,.markdown,.zip,.skill"
          aria-label="Upload skill files"
          onChange={onInputChange}
          className="sr-only"
        />
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Upload className="size-5" aria-hidden="true" />
        </span>
        <span className="text-sm font-medium text-foreground">
          {busy ? 'Reading…' : 'Drag and drop or click to upload'}
        </span>
        <span className="max-w-sm text-xs text-muted-foreground">
          .md files need a name and description in YAML frontmatter. .zip or .skill bundles must
          contain a SKILL.md. You&apos;ll confirm before anything is added.
        </span>
      </label>

      {errors.map((error) => (
        <ErrorBanner key={error} message={error} />
      ))}
      {summary ? <p className="mt-3 text-xs text-muted-foreground">{summary}</p> : null}

      <div className="mt-5 text-center">
        <Button type="button" variant="ghost" onClick={onWriteInstead}>
          Write from scratch instead
        </Button>
      </div>
    </div>
  )
}

export { SkillUploadView }
