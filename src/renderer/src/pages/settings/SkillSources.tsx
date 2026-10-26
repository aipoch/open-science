import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, GitBranch, FolderGit2, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SavedSkillSource } from '../../../../shared/skill-sources'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/error-notice'

export function SkillSources({
  onBrowse
}: {
  onBrowse: (repository: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [sources, setSources] = useState<SavedSkillSource[]>([])
  const [repository, setRepository] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const active = useRef(false)
  const inFlight = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const load = useCallback(async () => {
    try {
      const result = await window.api.settings.listSkillSources()
      if (active.current) {
        setSources(result)
        setError(undefined)
      }
    } catch {
      if (active.current) setError(t('Could not load Skill sources.'))
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
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(undefined)
    try {
      const result = source
        ? await window.api.settings.removeSkillSource({ id: source.id })
        : await window.api.settings.addSkillSource({ repository })
      if (!active.current) return
      setSources(result)
      if (!source) setRepository('')
      input.current?.focus()
    } catch {
      if (active.current)
        setError(
          source
            ? t('Could not remove this source. Your saved sources have been preserved.')
            : t('Could not save this source. Check the repository address and try again.')
        )
    } finally {
      inFlight.current = false
      if (active.current) setPending(false)
    }
  }

  return (
    <div className="space-y-6 p-5" data-slot="skill-sources">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">{t('Skill sources')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('Save GitHub repositories to browse and import their Skills.')}
        </p>
      </div>
      <form
        className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label htmlFor="skill-source-repository" className="block text-sm font-medium">
          {t('GitHub repository')}
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
            ref={input}
            id="skill-source-repository"
            className="min-w-0 flex-1 basis-64"
            value={repository}
            placeholder={t('https://github.com/owner/repository')}
            disabled={loading}
            readOnly={pending}
            onChange={(event) => setRepository(event.target.value)}
            aria-describedby="skill-source-hint"
          />
          <Button type="submit" disabled={loading || pending || !repository.trim()}>
            <Plus className="size-4" aria-hidden="true" />
            {pending ? t('Saving…') : t('Add source')}
          </Button>
        </div>
        <p id="skill-source-hint" className="text-xs leading-5 text-muted-foreground">
          {t('Use a repository URL or owner/repo@ref to select a branch or tag.')}
        </p>
      </form>
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
      <section aria-label={t('Saved sources')} aria-busy={loading || pending} className="space-y-3">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium">{t('Saved sources')}</h4>
          {!loading ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
              {sources.length}
            </span>
          ) : null}
        </div>
        {loading ? (
          <p role="status" className="py-6 text-sm text-muted-foreground">
            {t('Loading…')}
          </p>
        ) : sources.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {sources.map((source) => (
              <li key={source.id} className="flex flex-wrap items-center gap-3 px-4 py-4">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <FolderGit2 className="size-4 text-muted-foreground" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1 basis-48">
                  <p className="break-all text-sm font-medium">{source.repository}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                    <span className="break-all">{source.ref ?? t('Default branch')}</span>
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => onBrowse(source.repository + (source.ref ? `@${source.ref}` : ''))}
                >
                  {t('Browse')}
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={pending}
                  aria-label={t('Remove source {{name}}', { name: source.repository })}
                  onClick={() => void save(source)}
                >
                  <Trash2 className="size-4 text-muted-foreground" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : !error ? (
          <div className="rounded-lg border border-border border-dashed px-6 py-10 text-center">
            <FolderGit2 className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">{t('No saved sources yet')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('Add a repository above to keep its Skills within reach.')}
            </p>
          </div>
        ) : null}
        <p className="text-xs leading-5 text-muted-foreground">
          {t(
            'Removing a source keeps its installed Skills. Saved sources do not update Skills automatically.'
          )}
        </p>
      </section>
    </div>
  )
}
