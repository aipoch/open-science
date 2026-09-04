/* Hallmark · macrostructure: Workbench · tone: utilitarian · palette: existing warm paper + teal */
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import { useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  ScrollText,
  SearchX,
  Star
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type {
  GitHubRepositorySearchView,
  ScannedSkillView,
  SkillView
} from '../../../../shared/settings'
import { GITHUB_REPOSITORY_SEARCH_TOO_LONG_MESSAGE } from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatDisplayNumber } from '@/lib/locale-format'
import { useSettingsStore } from '@/stores/settings-store'
import { SkillImportCandidatePreview } from './SkillImportCandidatePreview'
import { useSkillImportCandidatePreview } from './useSkillImportCandidatePreview'

type SkillImportViewProps = {
  onImported: () => void
  onOpenCredentials?: () => void
}

type BusyOperation =
  { kind: 'find' } | { kind: 'scan'; repositoryName: string } | { kind: 'import' }

// Full-page GitHub import. Keywords discover repositories; direct references and chosen search
// results reuse the commit-pinned scan and batch-import flow.
const SkillImportView = ({
  onImported,
  onOpenCredentials
}: SkillImportViewProps): React.JSX.Element => {
  const { t } = useTranslation()
  const skills = useSettingsStore((state) => state.skills)
  const importSkill = useSettingsStore((state) => state.importSkill)
  const scanRepoSkills = useSettingsStore((state) => state.scanRepoSkills)
  const previewGitHubSkill = useSettingsStore((state) => state.previewGitHubSkill)
  const [input, setInput] = useState('')
  const inputRef = useRef('')
  const [operation, setOperation] = useState<BusyOperation | null>(null)
  const [message, setMessage] = useState<{ kind: 'error' | 'status'; text: string } | null>(null)
  const [repositories, setRepositories] = useState<GitHubRepositorySearchView[] | null>(null)
  const [repositoriesExpanded, setRepositoriesExpanded] = useState(true)
  const [scanned, setScanned] = useState<ScannedSkillView[] | null>(null)
  const [scannedRepo, setScannedRepo] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const candidatePreview = useSkillImportCandidatePreview()
  const busy = operation !== null

  const imported = skills.filter((skill: SkillView) => skill.source === 'imported')

  const runPreview = async (
    requestedInput = input,
    options: { preserveRepositories?: boolean; repositoryName?: string } = {}
  ): Promise<void> => {
    const value = requestedInput.trim()
    if (!value || busy) return
    const visibleInputAtStart = inputRef.current
    candidatePreview.invalidatePreview()
    setOperation(
      options.repositoryName
        ? { kind: 'scan', repositoryName: options.repositoryName }
        : { kind: 'find' }
    )
    setMessage(null)
    setScanned(null)
    setScannedRepo(null)
    setSelected(new Set())
    if (!options.preserveRepositories) {
      setRepositories(null)
      setRepositoriesExpanded(true)
    }
    try {
      const result = await scanRepoSkills(value)
      if (inputRef.current !== visibleInputAtStart) return
      if (result.repositories !== undefined) {
        setRepositories(result.repositories)
        setRepositoriesExpanded(true)
        if (result.repositories.length === 0) {
          setMessage({
            kind: 'status',
            text: t(
              'No matching Skill repositories found. Try another keyword or paste an owner/repo reference.'
            )
          })
        }
        return
      }

      setScanned(result.skills)
      setScannedRepo(options.repositoryName ?? value)
      if (options.repositoryName) setRepositoriesExpanded(false)
      // Pre-select every skill that isn't already imported.
      setSelected(
        new Set(result.skills.filter((skill) => !skill.alreadyImported).map((skill) => skill.url))
      )
      if (result.skills.length === 0) {
        setMessage({ kind: 'status', text: t('No skills found in that repo.') })
      }
    } catch (error) {
      if (inputRef.current !== visibleInputAtStart) return
      setMessage({
        kind: 'error',
        // Main-process failures arrive already worded; only the fallback is ours to translate.
        text: error instanceof Error ? error.message : t('GitHub request failed.')
      })
    } finally {
      setOperation(null)
    }
  }

  const updateInput = (value: string): void => {
    inputRef.current = value
    setInput(value)
    candidatePreview.invalidatePreview()
    setMessage(null)
    setRepositories(null)
    setRepositoriesExpanded(true)
    setScanned(null)
    setScannedRepo(null)
    setSelected(new Set())
  }

  const importSelected = async (): Promise<void> => {
    if (busy || selected.size === 0) return
    candidatePreview.invalidatePreview()
    setOperation({ kind: 'import' })
    setMessage(null)
    let done = 0
    try {
      for (const url of selected) {
        await importSkill(url)
        done += 1
      }
      setMessage({
        kind: 'status',
        text: t('Imported {{count}} skills.', {
          defaultValue_one: 'Imported {{count}} skill.',
          count: done
        })
      })
      setScanned(null)
      setScannedRepo(null)
      onImported()
    } catch (error) {
      setMessage({
        kind: 'error',
        text:
          error instanceof Error
            ? error.message
            : t('Imported {{count}}, then failed.', { count: done })
      })
    } finally {
      setOperation(null)
    }
  }

  const toggle = (url: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })

  const allSelected = scanned !== null && scanned.length > 0 && selected.size === scanned.length

  const toggleAll = (): void =>
    setSelected(() =>
      allSelected ? new Set() : new Set((scanned ?? []).map((skill) => skill.url))
    )

  const invertSelection = (): void =>
    setSelected((prev) => {
      const next = new Set<string>()
      for (const skill of scanned ?? []) {
        if (!prev.has(skill.url)) next.add(skill.url)
      }
      return next
    })

  return (
    <div className="p-5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{t('Import from GitHub')}</h2>
          <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
            {t(
              'Search repositories by keyword, or scan a GitHub repository for Skill folders to import.'
            )}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={onOpenCredentials}>
          {t('Manage GitHub credential')}
        </Button>
      </div>

      <div className="mt-4">
        <label
          htmlFor="github-skill-source"
          className="mb-1.5 block text-xs font-medium text-foreground"
        >
          {t('GitHub keyword or repository')}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            id="github-skill-source"
            aria-label={t('GitHub keyword or repository')}
            aria-invalid={
              (message?.kind === 'error' &&
                message.text === GITHUB_REPOSITORY_SEARCH_TOO_LONG_MESSAGE) ||
              undefined
            }
            placeholder={t('keywords, owner/repo, owner/repo@ref, or a github.com URL')}
            className="[@media(pointer:coarse)]:min-h-11"
            value={input}
            onChange={(event) => updateInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runPreview()
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => void runPreview()}
            disabled={busy || input.trim().length === 0}
            className="shrink-0 [@media(pointer:coarse)]:min-h-11"
          >
            {operation?.kind === 'find' ? (
              <>
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {t('Finding…')}
              </>
            ) : (
              t('Find skills')
            )}
          </Button>
        </div>
      </div>
      <div aria-busy={busy}>
        {message?.kind === 'error' ? (
          <div
            role="alert"
            className="mt-2 flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1 break-words py-0.5">{message.text}</p>
          </div>
        ) : null}

        {repositories ? (
          <section aria-label={t('Repository results')} className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">
                {t('Repositories ({{count}})', { count: repositories.length })}
              </h3>
              {repositories.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  aria-label={
                    repositoriesExpanded ? t('Hide repositories') : t('Show repositories')
                  }
                  aria-expanded={repositoriesExpanded}
                  aria-controls="github-repository-results"
                  className="shrink-0 gap-1.5 [@media(pointer:coarse)]:min-h-11"
                  onClick={() => setRepositoriesExpanded((expanded) => !expanded)}
                >
                  {repositoriesExpanded ? (
                    <ChevronUp className="size-4" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="size-4" aria-hidden="true" />
                  )}
                  {repositoriesExpanded ? t('Hide repositories') : t('Show repositories')}
                </Button>
              ) : null}
            </div>
            {repositories.length > 0 ? (
              <div id="github-repository-results">
                {repositoriesExpanded ? (
                  <ul className="mt-2 flex flex-col">
                    {repositories.map((repository) => (
                      <li
                        key={repository.fullName}
                        className="flex min-w-0 flex-col gap-2 py-3 hover:bg-muted/40 sm:flex-row sm:items-center"
                      >
                        <div className="min-w-0 flex-1 px-1">
                          <p className="truncate text-sm font-medium text-foreground">
                            {repository.fullName}
                          </p>
                          {repository.description ? (
                            <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">
                              {repository.description}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center justify-between gap-3 px-1 sm:justify-end">
                          <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                            <Star className="size-3.5" aria-hidden="true" />
                            {formatDisplayNumber(repository.stars)}
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={t('Scan {{repo}} for skills', {
                              repo: repository.fullName
                            })}
                            aria-pressed={scannedRepo === repository.fullName}
                            disabled={busy}
                            aria-busy={
                              operation?.kind === 'scan' &&
                              operation.repositoryName === repository.fullName
                            }
                            className="whitespace-nowrap [@media(pointer:coarse)]:min-h-11"
                            onClick={() => {
                              void runPreview(repository.fullName, {
                                preserveRepositories: true,
                                repositoryName: repository.fullName
                              })
                            }}
                          >
                            {operation?.kind === 'scan' &&
                            operation.repositoryName === repository.fullName ? (
                              <>
                                <LoaderCircle
                                  className="size-4 animate-spin motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                                {t('Scanning…')}
                              </>
                            ) : scannedRepo === repository.fullName ? (
                              scanned && scanned.length > 0 ? (
                                t('Scanned')
                              ) : (
                                t('No skills found')
                              )
                            ) : (
                              t('Scan for skills')
                            )}
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : repositories.length === 0 ? (
              <div className="mt-2 flex items-center gap-2 py-3 text-xs text-muted-foreground">
                <SearchX className="size-4 shrink-0" aria-hidden="true" />
                <p>{message?.kind === 'status' ? message.text : t('No repositories found.')}</p>
              </div>
            ) : null}
          </section>
        ) : null}

        {message?.kind === 'status' && (repositories === null || repositories.length > 0) ? (
          <p className="mt-2 text-xs text-muted-foreground">{message.text}</p>
        ) : null}

        {scanned && scanned.length > 0 ? (
          <section
            aria-label={t('Skills found in {{repo}}', { repo: scannedRepo ?? '' })}
            className="mt-5"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-foreground">
                  {t('Skills in {{repo}}', { repo: scannedRepo ?? '' })}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('Found {{count}} skills.', {
                    defaultValue_one: 'Found {{count}} skill.',
                    count: scanned.length
                  })}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void importSelected()}
                disabled={busy || selected.size === 0}
                className="self-start [@media(pointer:coarse)]:min-h-11 sm:self-auto"
              >
                {operation?.kind === 'import' ? (
                  <>
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    {t('Importing…')}
                  </>
                ) : (
                  t('Import selected ({{count}})', { count: selected.size })
                )}
              </Button>
            </div>

            <div
              role="group"
              aria-label={t('Skill selection controls')}
              className="mt-3 flex min-h-10 items-center gap-2 border-y border-border bg-muted/20 px-1 py-1"
            >
              <label className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground [@media(pointer:coarse)]:min-h-11">
                <input
                  type="checkbox"
                  aria-label={t('Select all')}
                  checked={allSelected}
                  onChange={toggleAll}
                  className="size-4 shrink-0"
                />
                {t('Select all')}
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="[@media(pointer:coarse)]:min-h-11"
                onClick={invertSelection}
              >
                {t('Invert selection')}
              </Button>
            </div>

            <ul className="flex flex-col">
              {scanned.map((skill) => (
                <li key={skill.url} className="flex items-center gap-3 py-2.5">
                  <span className="flex size-4 shrink-0 items-center justify-center [@media(pointer:coarse)]:size-11">
                    <input
                      type="checkbox"
                      aria-label={t('Select {{name}}', { name: skill.name })}
                      checked={selected.has(skill.url)}
                      onChange={() => toggle(skill.url)}
                      className="size-4 shrink-0"
                    />
                  </span>
                  <button
                    type="button"
                    aria-label={t('Preview {{name}}', { name: skill.name })}
                    onClick={() =>
                      candidatePreview.openPreview(() => previewGitHubSkill(skill.url))
                    }
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
                  >
                    <span className="min-w-0 flex-1 px-1 py-1">
                      <span className="block truncate text-sm text-foreground">{skill.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {skill.path}
                      </span>
                    </span>
                    {skill.alreadyImported ? (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {t('Imported')}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <section aria-labelledby="imported-skills-heading">
        <h3 id="imported-skills-heading" className="mt-8 text-sm font-semibold text-foreground">
          {t('Imported skills')}
        </h3>
        {imported.length > 0 ? (
          <ul className="mt-2 flex flex-col">
            {imported.map((skill) => (
              <li key={skill.id} className="flex items-center gap-2 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {skill.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{skill.id}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex min-h-64 flex-col items-center justify-center px-4 py-8 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <ScrollText className="size-5" aria-hidden="true" />
            </span>
            <p className="mt-3 text-sm font-medium text-foreground">
              {t('No imported skills yet')}
            </p>
            <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
              {t('Repos you import from will appear here.')}
            </p>
          </div>
        )}
      </section>

      <SkillImportCandidatePreview {...candidatePreview.previewProps} />
    </div>
  )
}

export { SkillImportView }
