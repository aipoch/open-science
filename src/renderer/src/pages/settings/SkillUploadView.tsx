import { AlertTriangle, FileText, Info, Upload } from 'lucide-react'
import { useState } from 'react'

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

// A parsed upload awaiting confirmation: either a bundle (imported as-is) or a markdown skill (created
// from its frontmatter). The raw payload is kept so confirming re-uses it without re-reading the file.
type Pending =
  | {
      kind: 'bundle'
      fileName: string
      base64: string
      name: string
      description: string
      files: string[]
      alreadyImported: boolean
    }
  | { kind: 'markdown'; fileName: string; name: string; description: string; body: string }

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

// Full-page upload: drop (or click to browse) a SKILL.md or a .zip / .skill bundle. The file is parsed
// first and shown as a preview; nothing is written until the user confirms.
const SkillUploadView = ({
  onUploaded,
  onWriteInstead
}: SkillUploadViewProps): React.JSX.Element => {
  const createSkill = useSettingsStore((state) => state.createSkill)
  const importSkillZip = useSettingsStore((state) => state.importSkillZip)
  const previewSkillZip = useSettingsStore((state) => state.previewSkillZip)
  const skills = useSettingsStore((state) => state.skills)
  const [pending, setPending] = useState<Pending | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Parses a picked file into a preview without importing it.
  const handleFile = async (file: File): Promise<void> => {
    setMessage(null)
    const name = file.name.toLowerCase()

    if (name.endsWith('.zip') || name.endsWith('.skill')) {
      setBusy(true)
      try {
        const base64 = await fileToBase64(file)
        const preview = await previewSkillZip(base64)
        setPending({ kind: 'bundle', fileName: file.name, base64, ...preview })
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Could not read the bundle.')
      } finally {
        setBusy(false)
      }
      return
    }

    if (name.endsWith('.md') || name.endsWith('.markdown')) {
      const parsed = consumeFrontmatter(await file.text())
      if (!parsed.name) {
        setMessage('The .md file needs a name (and description) in its YAML frontmatter.')
        return
      }
      setPending({
        kind: 'markdown',
        fileName: file.name,
        name: parsed.name,
        description: parsed.description ?? '',
        body: parsed.body
      })
      return
    }

    setMessage('Unsupported file — upload a .md file or a .zip/.skill bundle.')
  }

  // Commits the previewed upload: importing a bundle or creating a skill from the markdown.
  const confirm = async (): Promise<void> => {
    if (!pending || busy) return
    setBusy(true)
    setMessage(null)
    try {
      if (pending.kind === 'bundle') {
        await importSkillZip(pending.base64)
      } else {
        await createSkill({
          name: pending.name,
          description: pending.description,
          body: pending.body
        })
      }
      onUploaded()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Import failed.')
    } finally {
      setBusy(false)
    }
  }

  const onInputChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    if (file) void handleFile(file)
    event.target.value = ''
  }

  const onDrop = (event: React.DragEvent<HTMLLabelElement>): void => {
    event.preventDefault()
    const file = event.dataTransfer.files?.[0]
    if (file) void handleFile(file)
  }

  // Confirmation page: the parsed skill and its files, then Import / Cancel.
  if (pending) {
    // Two duplicate signals: an exact re-upload (bundle content signature already imported), and a
    // same-name skill already in the catalog (any source) — the latter also covers .md uploads.
    const exactDuplicate = pending.kind === 'bundle' && pending.alreadyImported
    const nameTaken = skills.some(
      (skill) => skill.name.trim().toLowerCase() === pending.name.trim().toLowerCase()
    )
    const duplicate = exactDuplicate || nameTaken

    return (
      <div className="max-w-2xl p-5">
        <h2 className="text-lg font-semibold text-foreground">Confirm import</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Review what will be added from <span className="text-foreground">{pending.fileName}</span>
          .
        </p>

        <div className="mt-4 rounded-lg border border-border bg-muted/20 p-4">
          <div className="flex items-start gap-3">
            <FileText className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-foreground">
                  {pending.name}
                </span>
                {duplicate ? (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    Already uploaded
                  </span>
                ) : null}
              </div>
              {pending.description ? (
                <p className="mt-1 text-xs text-muted-foreground [text-wrap:pretty]">
                  {pending.description}
                </p>
              ) : null}
            </div>
          </div>

          {pending.kind === 'bundle' ? (
            <div className="mt-3 border-t border-border pt-3">
              <span className="text-xs font-medium text-muted-foreground">
                Files ({pending.files.length})
              </span>
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {pending.files.map((file) => (
                  <li key={file} className="truncate font-mono text-xs text-foreground">
                    {file}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="mt-3 border-t border-border pt-3">
              <span className="text-xs font-medium text-muted-foreground">
                Creates a personal skill (SKILL.md)
              </span>
            </div>
          )}
        </div>

        {message ? <ErrorBanner message={message} /> : null}

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
          <button
            type="button"
            onClick={() => {
              setPending(null)
              setMessage(null)
            }}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            Choose a different file
          </button>
        </div>
        {duplicate ? (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" aria-hidden="true" />
            {exactDuplicate
              ? 'This exact bundle is already imported — re-importing is a no-op.'
              : `A skill named "${pending.name}" already exists.`}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="max-w-2xl p-5">
      <h2 className="text-lg font-semibold text-foreground">Upload a skill</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Add a skill from a SKILL.md file or a .zip / .skill bundle on your computer.
      </p>

      <label
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        className="mt-4 flex cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-6 py-10 text-center transition-colors hover:bg-muted/40"
      >
        <input
          type="file"
          accept=".md,.zip,.skill"
          aria-label="Upload a skill file"
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

      {message ? <ErrorBanner message={message} /> : null}

      <div className="mt-5 text-center">
        <button
          type="button"
          onClick={onWriteInstead}
          className="rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Write from scratch instead
        </button>
      </div>
    </div>
  )
}

export { SkillUploadView }
