import { useCallback, useEffect, useRef, useState } from 'react'
import { Bookmark, Check, FolderGit2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { parseSavedSkillRepository, type SavedSkillSource } from '../../../../shared/skill-sources'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'

export function SavedSkillRepositories({
  scannedRepository,
  busy,
  onScan
}: {
  scannedRepository: string | null
  busy: boolean
  onScan: (repository: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [sources, setSources] = useState<SavedSkillSource[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const active = useRef(false)
  const inFlight = useRef(false)
  const section = useRef<HTMLElement>(null)
  let candidate: Omit<SavedSkillSource, 'id'> | undefined
  try {
    if (scannedRepository) candidate = parseSavedSkillRepository(scannedRepository)
  } catch {
    // Individual Skill and subtree URLs remain importable, but are not repository bookmarks.
  }
  const saved =
    candidate &&
    sources.some(
      (source) => source.repository === candidate.repository && source.ref === candidate.ref
    )
  const load = useCallback(async () => {
    try {
      const result = await window.api.settings.listSkillSources()
      if (active.current) {
        setSources(result)
        setError(undefined)
      }
    } catch {
      if (active.current) setError(t('Could not load saved repositories.'))
    } finally {
      if (active.current) setLoading(false)
    }
  }, [t])
  useEffect(() => {
    active.current = true
    let disposed = false
    void Promise.resolve().then(() => {
      if (!disposed) void load()
    })
    return () => {
      disposed = true
      active.current = false
    }
  }, [load])

  const save = async (source?: SavedSkillSource): Promise<void> => {
    if (inFlight.current || loading || busy || (!source && (!candidate || saved))) return
    inFlight.current = true
    setPending(true)
    setError(undefined)
    try {
      const result = source
        ? await window.api.settings.removeSkillSource({ id: source.id })
        : await window.api.settings.addSkillSource({ repository: scannedRepository! })
      if (!active.current) return
      setSources(result)
      if (source) section.current?.focus()
    } catch {
      if (active.current)
        setError(
          source
            ? t('Could not remove this bookmark. Your saved repositories have been preserved.')
            : t('Could not save this repository. Try again.')
        )
    } finally {
      inFlight.current = false
      if (active.current) setPending(false)
    }
  }

  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label={t('Saved repositories')}
      aria-busy={loading || pending}
      className="mt-5 space-y-2 rounded-lg border border-border bg-muted/20 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs font-medium">
          <Bookmark className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {t('Saved repositories')}
          {!loading && sources.length > 0 ? (
            <span className="text-muted-foreground tabular-nums">{sources.length}</span>
          ) : null}
        </h3>
        {candidate ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={loading || pending || busy || saved}
            onClick={() => void save()}
          >
            {saved ? (
              <Check className="size-3.5" aria-hidden="true" />
            ) : (
              <Bookmark className="size-3.5" aria-hidden="true" />
            )}
            {pending ? t('Saving…') : saved ? t('Saved') : t('Save repository')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <ErrorNotice
          title={error}
          tone="amber"
          primaryButton={{
            label: t('Retry'),
            onClick: () => {
              setLoading(true)
              setError(undefined)
              void load()
            },
            disabled: pending || loading
          }}
        />
      ) : null}
      {loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('Loading…')}
        </p>
      ) : sources.length ? (
        <ul className="divide-y divide-border">
          {sources.map((source) => (
            <li key={source.id} className="flex items-center gap-2 py-1">
              <Button
                variant="ghost"
                disabled={pending || busy}
                className="h-auto min-w-0 flex-1 justify-start px-2 py-2 text-left"
                onClick={() => onScan(source.repository + (source.ref ? `@${source.ref}` : ''))}
              >
                <FolderGit2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block break-all text-xs font-medium">{source.repository}</span>
                  <span className="mt-0.5 block break-all text-xs font-normal text-muted-foreground">
                    {source.ref ?? t('Default branch')}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t('Scan for skills')}
                </span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                disabled={pending || busy}
                aria-label={t('Remove saved repository {{name}}', {
                  name: source.repository + (source.ref ? `@${source.ref}` : '')
                })}
                onClick={() => void save(source)}
              >
                <Trash2 className="size-3.5 text-muted-foreground" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : !error ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {t('Scan a repository, then save it here for next time.')}
        </p>
      ) : null}
      {sources.length > 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {t(
            'Removing a bookmark keeps its installed Skills. Saved repositories do not update Skills automatically.'
          )}
        </p>
      ) : null}
    </section>
  )
}
