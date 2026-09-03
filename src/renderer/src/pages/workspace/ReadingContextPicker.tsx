/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import { AlertTriangle, FileText, Loader2, Search } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { ProjectFileItem } from '../../../../shared/project-files'
import type { SessionPdfContextSource } from '../../../../shared/session-persistence'
import { ErrorNotice } from '@/components/error-notice'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import { fuzzyScore } from './composer/fuzzy-match'
import { loadAllProjectFiles } from './composer/load-project-files'

type ReadingContextPickerProps = {
  projectId: string
  linkedSources: readonly SessionPdfContextSource[]
  atLimit: boolean
  children: ReactNode
  onSelect: (source: SessionPdfContextSource) => Promise<void>
}

type EligiblePdf = {
  file: ProjectFileItem
  source: SessionPdfContextSource
}

const sourceKey = (source: SessionPdfContextSource): string =>
  `${source.sourceKind}:${source.sourceVersionId}`

const toSource = (file: ProjectFileItem): SessionPdfContextSource | undefined =>
  file.sourceVersionId
    ? {
        sourceKind: file.source === 'upload' ? 'upload-version' : 'artifact-version',
        sourceFileId: file.sourceFileId,
        sourceVersionId: file.sourceVersionId
      }
    : undefined

const isPdfCandidate = (file: ProjectFileItem): boolean =>
  file.mimeType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/pdf' ||
  file.name.toLowerCase().endsWith('.pdf')

const inspectCandidates = async (
  projectId: string,
  files: readonly ProjectFileItem[]
): Promise<EligiblePdf[]> => {
  const byKey = new Map<string, EligiblePdf>()
  for (const file of files) {
    const source = isPdfCandidate(file) ? toSource(file) : undefined
    if (source && !byKey.has(sourceKey(source))) byKey.set(sourceKey(source), { file, source })
  }

  const candidates = [...byKey.values()]
  const eligible = new Set<string>()
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const page = candidates.slice(offset, offset + 100)
    const result = await window.api.sessions.filterPdfContextCandidates({
      projectId,
      sources: page.map(({ source }) => source)
    })
    for (const source of result.sources) eligible.add(sourceKey(source))
  }
  return candidates.filter(({ source }) => eligible.has(sourceKey(source)))
}

export const ReadingContextPicker = ({
  projectId,
  linkedSources,
  atLimit,
  children,
  onSelect
}: ReadingContextPickerProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pendingKey, setPendingKey] = useState<string>()
  const [loadRevision, setLoadRevision] = useState(0)
  const [result, setResult] = useState<{
    projectId?: string
    items: EligiblePdf[]
    status: 'idle' | 'loading' | 'loaded' | 'error'
  }>({ items: [], status: 'idle' })

  useEffect(() => {
    if (!open || atLimit) return
    let cancelled = false
    void loadAllProjectFiles(projectId)
      .then((files) => inspectCandidates(projectId, files))
      .then((items) => {
        if (!cancelled) setResult({ projectId, items, status: 'loaded' })
      })
      .catch(() => {
        if (!cancelled) setResult({ projectId, items: [], status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [atLimit, loadRevision, open, projectId])

  const linked = useMemo(() => new Set(linkedSources.map(sourceKey)), [linkedSources])
  const items = useMemo(() => {
    const needle = query.trim()
    return result.items
      .filter(({ source }) => !linked.has(sourceKey(source)))
      .map((item) => ({ item, match: needle ? fuzzyScore(needle, item.file.name) : undefined }))
      .filter(({ match }) => match !== null)
      .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
      .map(({ item }) => item)
  }, [linked, query, result.items])

  const select = async (item: EligiblePdf): Promise<void> => {
    const key = sourceKey(item.source)
    setPendingKey(key)
    try {
      await onSelect(item.source)
      setOpen(false)
      setQuery('')
      setResult({ items: [], status: 'idle' })
    } catch {
      // The controller owns the visible composer error; keep the picker open for another choice.
    } finally {
      setPendingKey(undefined)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        setResult(
          nextOpen && !atLimit
            ? { projectId, items: [], status: 'loading' }
            : { items: [], status: 'idle' }
        )
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 rounded-xl border border-border-200 bg-bg-000 p-1.5 text-text-100 shadow-md"
      >
        {!atLimit ? (
          <label className="mb-1 flex h-8 items-center gap-2 rounded-lg border border-border-200 bg-bg-100 px-2 focus-within:border-border-300 focus-within:ring-[3px] focus-within:ring-ring/30">
            <Search className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('Search PDFs')}
              aria-label={t('Search PDFs')}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-400"
            />
          </label>
        ) : null}
        {atLimit ? (
          <p className="px-2 py-2 text-sm text-text-300">
            {t('A conversation can link up to 3 PDFs.')}
          </p>
        ) : result.status === 'loading' || result.status === 'idle' ? (
          <p role="status" className="flex items-center gap-2 px-2 py-2 text-sm text-text-300">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t('Checking PDFs…')}
          </p>
        ) : result.status === 'error' ? (
          <div role="alert" className="px-2 py-2">
            <ErrorNotice
              icon={AlertTriangle}
              tone="amber"
              title={t('Could not load project files')}
              primaryButton={{
                label: t('Retry'),
                onClick: () => {
                  setResult({ projectId, items: [], status: 'loading' })
                  setLoadRevision((revision) => revision + 1)
                }
              }}
            />
          </div>
        ) : items.length === 0 ? (
          <p className="px-2 py-2 text-sm text-text-300">{t('No multi-page PDFs available')}</p>
        ) : (
          <ul
            role="listbox"
            aria-label={t('Artifact suggestions')}
            className="max-h-56 overflow-y-auto"
          >
            {items.map((item) => {
              const key = sourceKey(item.source)
              const pending = pendingKey === key
              return (
                <li key={key}>
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    disabled={pendingKey !== undefined}
                    onClick={() => void select(item)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-bg-200 hover:text-text-000 active:bg-bg-300 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {pending ? (
                      <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                    ) : (
                      <FileText className="size-4 shrink-0 text-text-300" aria-hidden="true" />
                    )}
                    <ExtensionPreservingFileName
                      name={item.file.name}
                      className="min-w-0 flex-1 font-medium"
                    />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
