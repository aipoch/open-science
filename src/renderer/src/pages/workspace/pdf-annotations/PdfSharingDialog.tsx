import { tagPresentation } from '../../settings/tag-presentation'
import { useTagStore } from '@/stores/tag-store'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LiteratureImportDialogFrame } from '../../literature/imports/LiteratureImportDialogFrame'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type {
  PdfAnnotationSource,
  PdfSharingPreview,
  PdfSharingDecision
} from '../../../../../shared/pdf-annotations'
import {
  literatureItemInputSchema,
  type LiteratureItemView
} from '../../../../../shared/literature'

export function PdfSharingDialog({
  source,
  onChanged
}: {
  source: PdfAnnotationSource
  onChanged: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const tags = useTagStore((state) => state.tags)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [projectNames, setProjectNames] = useState<Record<string, string>>({})
  const [items, setItems] = useState<LiteratureItemView[]>([])
  const [selected, setSelected] = useState<LiteratureItemView>()
  const [preview, setPreview] = useState<PdfSharingPreview>()
  const [decisions, setDecisions] = useState<Record<string, PdfSharingDecision['choice']>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    if (!open) return
    let active = true
    void window.api.projects
      .list()
      .then((projects) => {
        if (active)
          setProjectNames(Object.fromEntries(projects.map((project) => [project.id, project.name])))
      })
      .catch(() => {
        /* Names are display-only; source authority is verified in main. */
      })
    return () => {
      active = false
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    let active = true
    const timer = setTimeout(() => {
      void window.api.literature
        .search({ scope: 'library', entryKind: 'paper', query, limit: 30 })
        .then((result) => {
          if (active)
            setItems(result.entries.filter((entry): entry is LiteratureItemView => 'item' in entry))
        })
        .catch(() => {
          if (active) setError(t('References could not be loaded.'))
        })
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [open, query, t])
  useEffect(
    () => () => {
      generation.current += 1
    },
    []
  )
  if (!source.projectId || !source.sessionId || source.kind === 'literature-attachment-version')
    return null
  const review = async (
    item: LiteratureItemView,
    requestGeneration = generation.current
  ): Promise<void> => {
    if (requestGeneration !== generation.current) return
    setBusy(true)
    setError('')
    setPreview(undefined)
    setSelected(item)
    setDecisions({})
    try {
      const result = await window.api.literature.sharePdf({
        source,
        itemId: item.id,
        decisions: []
      })
      if (requestGeneration === generation.current) setPreview(result)
    } catch {
      if (requestGeneration !== generation.current) return
      setError(
        t(
          'PDF sharing could not be prepared. Check that both sources are available and contain the same PDF.'
        )
      )
    } finally {
      if (requestGeneration === generation.current) setBusy(false)
    }
  }
  const create = async (): Promise<void> => {
    const requestGeneration = generation.current
    setBusy(true)
    setError('')
    try {
      const result = await window.api.literature.transact({
        kind: 'create-item',
        item: literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: query.trim() || source.name.replace(/\.pdf$/i, '')
        })
      })
      if (result.kind !== 'item') throw new Error('Missing reference')
      const item = await window.api.literature.get(result.id)
      if (!item) throw new Error('Missing reference')
      await review(item, requestGeneration)
    } catch {
      if (requestGeneration !== generation.current) return
      setError(t('PDF could not be added.'))
      setBusy(false)
    }
  }
  const commit = async (): Promise<void> => {
    if (!preview || !selected) return
    const requestGeneration = generation.current
    setBusy(true)
    setError('')
    try {
      await window.api.literature.sharePdf({
        source,
        itemId: selected.id,
        targetVersionId: preview.targetVersionId,
        token: preview.token,
        decisions: Object.entries(decisions).map(([key, choice]) => ({ key, choice }))
      })
      if (requestGeneration !== generation.current) return
      onChanged()
      setOpen(false)
      setPreview(undefined)
    } catch {
      if (requestGeneration !== generation.current) return
      setPreview(undefined)
      setError(t('Sharing was not completed. Review the current notes again before retrying.'))
    } finally {
      if (requestGeneration === generation.current) setBusy(false)
    }
  }
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true)
          setError('')
          setPreview(undefined)
        }}
      >
        {t('Share notes with Literature')}
      </Button>
      {open ? (
        <LiteratureImportDialogFrame
          title={t('Share notes with Literature')}
          description={t(
            'Linked sources share notes, edits, tags and deletions. Independently uploaded PDFs remain separate until you link them.'
          )}
          busy={busy}
          onClose={() => setOpen(false)}
          footer={null}
        >
          <div className="space-y-3 overflow-y-auto p-5">
            <Input
              aria-label={t('Search references')}
              placeholder={t('Search references')}
              value={query}
              disabled={busy}
              onChange={(event) => {
                setQuery(event.target.value)
                setPreview(undefined)
              }}
            />
            <div className="max-h-44 space-y-1 overflow-y-auto">
              {items.map((item) => (
                <Button
                  key={item.id}
                  variant="ghost"
                  className="h-auto w-full justify-start whitespace-normal text-left"
                  disabled={busy}
                  onClick={() => void review(item)}
                >
                  {item.item.title}
                </Button>
              ))}
            </div>
            <Button variant="outline" disabled={busy} onClick={() => void create()}>
              {t('Create reference and review sharing')}
            </Button>
            {selected && !preview ? (
              <Button disabled={busy} onClick={() => void review(selected)}>
                {t('Review sharing')}
              </Button>
            ) : null}
            {preview ? (
              <div className="space-y-3">
                <p className="font-medium">{selected?.item.title}</p>
                <p className="text-sm text-muted-foreground">
                  {t('Edits and deletions will affect every linked source listed below.')}
                </p>
                <ul className="text-sm">
                  <li>
                    {source.name} — {projectNames[source.projectId] ?? t('Workspace')}
                  </li>
                  {preview.sources
                    .filter(
                      (entry) =>
                        entry.versionId !== source.versionId || entry.projectId !== source.projectId
                    )
                    .map((entry) => (
                      <li key={`${entry.projectId ?? ''}:${entry.versionId}`}>
                        {entry.name} —{' '}
                        {entry.projectId
                          ? (projectNames[entry.projectId] ?? t('Workspace'))
                          : t('Literature')}
                      </li>
                    ))}
                  {!preview.sources.some(
                    (entry) => entry.kind === 'literature-attachment-version'
                  ) ? (
                    <li>
                      {selected?.item.title} — {t('Literature')}
                    </li>
                  ) : null}
                </ul>
                {preview.conflicts.map((conflict) => (
                  <div key={conflict.key} className="space-y-2 rounded-md border border-border p-3">
                    <p className="text-sm">
                      {conflict.unknown
                        ? t(
                            'This historical annotation has no verifiable original identity. Choose how to retain it.'
                          )
                        : t(
                            'These notes have conflicting edits or deletions. Choose what to keep.'
                          )}
                    </p>
                    <p className="whitespace-pre-wrap text-sm">
                      {t('Workspace')}:{' '}
                      {conflict.left?.note ||
                        (conflict.left ? t('No comment') : t('Deleted or not imported'))}
                    </p>
                    <p className="whitespace-pre-wrap text-sm">
                      {t('Literature')}:{' '}
                      {conflict.right?.note ||
                        (conflict.right ? t('No comment') : t('Deleted or not imported'))}
                    </p>
                    {[conflict.left, conflict.right].map((entry, index) =>
                      entry ? (
                        <div key={entry.id} className="text-xs text-muted-foreground">
                          <span>{index === 0 ? t('Workspace') : t('Literature')}</span>
                          {entry.pageNumber ? (
                            <span> · {t('Page {{page}}', { page: entry.pageNumber })}</span>
                          ) : null}
                          {entry.color ? (
                            <span>
                              {' '}
                              ·{' '}
                              {
                                {
                                  yellow: t('Yellow'),
                                  blue: t('Blue'),
                                  green: t('Green'),
                                  pink: t('Pink'),
                                  purple: t('Purple')
                                }[entry.color]
                              }
                            </span>
                          ) : null}
                          <p className="whitespace-pre-wrap">{entry.quote}</p>
                          <p>
                            {entry.tagIds
                              .map((id) => {
                                const tag = tags.find((tag) => tag.id === id)
                                return tag ? tagPresentation(tag, t).name : id
                              })
                              .join(', ')}
                          </p>
                        </div>
                      ) : null
                    )}
                    <Select
                      value={decisions[conflict.key] ?? ''}
                      onValueChange={(choice) =>
                        setDecisions((values) => ({
                          ...values,
                          [conflict.key]: choice as PdfSharingDecision['choice']
                        }))
                      }
                      disabled={busy}
                    >
                      <SelectTrigger aria-label={t('Resolve annotation conflict')}>
                        <SelectValue placeholder={t('Choose what to keep')} />
                      </SelectTrigger>
                      <SelectContent>
                        {conflict.left ? (
                          <SelectItem value="left">{t('Keep Workspace note')}</SelectItem>
                        ) : null}
                        {conflict.right ? (
                          <SelectItem value="right">{t('Keep Literature note')}</SelectItem>
                        ) : null}
                        {conflict.left && conflict.right ? (
                          <SelectItem value="both">{t('Keep both as separate notes')}</SelectItem>
                        ) : null}
                        <SelectItem value="delete">{t('Keep deleted')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ))}
                <Button
                  disabled={busy || preview.conflicts.some((conflict) => !decisions[conflict.key])}
                  onClick={() => void commit()}
                >
                  {t('Link sources and share notes')}
                </Button>
              </div>
            ) : null}
            {busy ? (
              <p role="status" className="text-sm">
                {t('Preparing…')}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </LiteratureImportDialogFrame>
      ) : null}
    </>
  )
}
