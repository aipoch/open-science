import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Checkbox } from 'radix-ui'
import { Check, ChevronDown, FileCheck2, Info, Files, ListFilter, Minus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  dialogBodyClassName,
  dialogFooterClassName,
  dialogCancelButtonClassName
} from '@/components/ui/dialog-chrome'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { usePackageOperationStore } from '@/stores/package-operation-store'
import type {
  PackageSelectableFile,
  PackageSelectionSummary
} from '../../../shared/session-package'

import {
  formatPackageBytes as packageBytes,
  PACKAGE_MAX_FILE_BYTES
} from '../../../shared/session-package'
const PAGE_SIZE = 25

export const PackageFileSelection = ({
  files,
  summary,
  onSelect,
  onCancel,
  notice,
  children
}: {
  files: PackageSelectableFile[]
  summary?: PackageSelectionSummary
  onSelect: (excludedStorageKeys: string[]) => void
  onCancel: () => void
  notice?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const thresholdId = useId()
  const retainedFilesId = useId()
  const [showRetainedFiles, setShowRetainedFiles] = useState(false)
  const { excludedStorageKeys, selectionPreset, threshold, setThreshold } =
    usePackageOperationStore()
  const [query, setQuery] = useState('')
  const [customizing, setCustomizing] = useState(false)
  const [page, setPage] = useState(0)
  const [retainedPage, setRetainedPage] = useState(0)
  const [retainedCategory, setRetainedCategory] = useState('')
  const retainedCategories = [
    { id: 'notebooks', label: t('Notebook') },
    { id: 'artifacts', label: t('Artifacts') },
    { id: 'uploads', label: t('Uploads') },
    { id: 'execution-file-evidence', label: t('Execution evidence') },
    { id: 'other', label: t('Other files') }
  ]
  const retainedFiles = useMemo(
    () =>
      [...(summary?.retainedFiles ?? [])]
        .map((file) => {
          const source = file.storageKey.split('/')[0]
          return {
            ...file,
            category: ['notebooks', 'artifacts', 'uploads', 'execution-file-evidence'].includes(
              source
            )
              ? source
              : 'other'
          }
        })
        .sort((a, b) => b.sizeBytes - a.sizeBytes),
    [summary?.retainedFiles]
  )
  const retainedByCategory = useMemo(() => {
    const groups = new Map<string, typeof retainedFiles>()
    for (const file of retainedFiles) {
      const group = groups.get(file.category)
      if (group) group.push(file)
      else groups.set(file.category, [file])
    }
    return groups
  }, [retainedFiles])
  const visibleRetainedFiles = retainedCategory
    ? (retainedByCategory.get(retainedCategory) ?? [])
    : retainedFiles
  const retainedPages = Math.max(1, Math.ceil(visibleRetainedFiles.length / PAGE_SIZE))
  const currentRetainedPage = Math.min(retainedPage, retainedPages - 1)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [versionCounts, setVersionCounts] = useState<Record<string, number>>({})
  const excluded = useMemo(() => new Set(excludedStorageKeys ?? []), [excludedStorageKeys])
  const groups = useMemo(() => {
    const result = new Map<string, PackageSelectableFile[]>()
    const sizes = new Map<string, number>()
    for (const file of files) {
      const key = `${file.source}:${file.groupId}`
      sizes.set(key, (sizes.get(key) ?? 0) + file.sizeBytes)
      const group = result.get(key)
      if (group) group.push(file)
      else result.set(key, [file])
    }
    return [...result].sort((a, b) => sizes.get(b[0])! - sizes.get(a[0])!)
  }, [files])
  const normalizedQuery = query.toLocaleLowerCase()
  const filtered = useMemo(
    () =>
      normalizedQuery
        ? groups.filter(([, entries]) =>
            entries.some((file) => file.filename.toLocaleLowerCase().includes(normalizedQuery))
          )
        : groups,
    [groups, normalizedQuery]
  )
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages - 1)
  const toggle = (entries: PackageSelectableFile[], include: boolean): void =>
    usePackageOperationStore.setState((previous) => {
      const next = new Set(previous.excludedStorageKeys ?? [])
      for (const file of entries) {
        if (file.requiredForEvidence) continue
        if (include && file.sizeBytes <= PACKAGE_MAX_FILE_BYTES) next.delete(file.storageKey)
        else next.add(file.storageKey)
      }
      return { excludedStorageKeys: [...next], selectionPreset: 'custom' }
    })
  const stats = useMemo(() => {
    let selectedBytes = 0,
      requiredBytes = 0,
      optionalCount = 0,
      selectedOptionalCount = 0,
      selectedOptionalBytes = 0
    let oversized = false,
      requiredOversized = false
    for (const file of files) {
      const selected = !excluded.has(file.storageKey)
      if (selected) selectedBytes += file.sizeBytes
      if (file.requiredForEvidence) requiredBytes += file.sizeBytes
      else {
        optionalCount++
        if (selected) {
          selectedOptionalCount++
          selectedOptionalBytes += file.sizeBytes
        }
      }
      if (file.sizeBytes > PACKAGE_MAX_FILE_BYTES) {
        oversized = true
        if (file.requiredForEvidence) requiredOversized = true
      }
    }
    return {
      selectedBytes,
      requiredBytes,
      optionalCount,
      selectedOptionalCount,
      selectedOptionalBytes,
      oversized,
      requiredOversized
    }
  }, [files, excluded])
  const { selectedBytes, oversized, requiredOversized } = stats
  const retainedBytes = useMemo(
    () =>
      (summary?.metadataBytes ?? 0) +
      (summary?.retainedFiles.reduce((sum, file) => sum + file.sizeBytes, 0) ?? 0),
    [summary]
  )
  const choosePreset = (preset: 'full' | 'compact'): void => {
    usePackageOperationStore.setState({
      selectionPreset: preset,
      excludedStorageKeys:
        preset === 'full'
          ? []
          : files.filter((file) => !file.requiredForEvidence).map((file) => file.storageKey)
    })
    setCustomizing(false)
  }
  return (
    <>
      <div
        className={`${dialogBodyClassName} min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]`}
      >
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">{t('Package contents')}</legend>
          {(['compact', 'full'] as const).map((preset) => (
            <label
              key={preset}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${selectionPreset === preset ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'} ${preset === 'full' && oversized ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <input
                type="radio"
                name="package-preset"
                className="mt-0.5 shrink-0 accent-primary"
                aria-label={preset === 'full' ? t('Full export') : t('Essential export')}
                checked={selectionPreset === preset}
                disabled={preset === 'full' && oversized}
                onChange={() => choosePreset(preset)}
              />
              <span className="space-y-1">
                <span className="flex items-center gap-2 font-medium">
                  {preset === 'compact' ? (
                    <FileCheck2 className="size-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <Files className="size-4 shrink-0" aria-hidden="true" />
                  )}
                  {preset === 'full' ? t('Full export') : t('Essential export')}
                </span>
                <span className="block text-xs leading-relaxed text-muted-foreground">
                  {preset === 'full'
                    ? t('Plus all available files')
                    : t('History + required evidence')}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {oversized ? (
          <p className="text-xs text-status-warning">
            {requiredOversized
              ? t(
                  'Required evidence exceeds {{limit}} per file. This Session cannot be exported.',
                  { limit: packageBytes(PACKAGE_MAX_FILE_BYTES) }
                )
              : t(
                  'Full export is unavailable because a file exceeds {{limit}}. Choose Essential export or customize the contents.',
                  { limit: packageBytes(PACKAGE_MAX_FILE_BYTES) }
                )}
          </p>
        ) : null}
        <div className="space-y-3 rounded-lg bg-muted/50 p-4">
          {selectionPreset === 'custom' ? (
            <p className="text-sm font-medium">{t('Custom selection')}</p>
          ) : null}
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              {t('Estimated size')}
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('About the size estimate')}
                    >
                      <Info className="size-3.5" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('Uncompressed upper estimate. The final package may be smaller.')}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </span>
            <strong className="text-base font-semibold tabular-nums text-foreground">
              {summary ? packageBytes(retainedBytes + selectedBytes) : '—'}
            </strong>
          </div>
          {summary ? (
            <p className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>{t('History and required evidence')}</span>
              <span className="tabular-nums">
                {packageBytes(retainedBytes + stats.requiredBytes)}
              </span>
            </p>
          ) : null}
          {stats.optionalCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('Selected: {{selected}} / {{total}} files · {{size}}', {
                selected: stats.selectedOptionalCount,
                total: stats.optionalCount,
                size: packageBytes(stats.selectedOptionalBytes)
              })}
            </p>
          ) : null}
        </div>
        {excluded.size > 0 && selectionPreset === 'custom' ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('Some file contents are not included. Review your selection in Customize contents.')}
          </p>
        ) : null}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            className="-ml-2 gap-2"
            aria-expanded={customizing}
            aria-controls="package-customization"
            onClick={() => setCustomizing(!customizing)}
          >
            <ChevronDown
              className={`size-4 transition-transform ${customizing ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
            {t('Customize contents')}
          </Button>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('Package contents')}
                  className="text-muted-foreground"
                >
                  <Info className="size-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-72">
                {t(
                  'Conversation and evidence metadata are always included. Unselected file contents are recorded as not included.'
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {customizing ? (
          <div id="package-customization" className="space-y-4 border-t border-border pt-4">
            {summary && summary.retainedFiles.length > 0 ? (
              <section className="rounded-lg border border-border p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Files className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="font-medium">{t('Required files')}</span>
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t('Required evidence')}
                          className="text-muted-foreground"
                        >
                          <Info className="size-3.5" aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-72">
                        {t(
                          'Required to preserve research evidence. These files cannot be excluded.'
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {packageBytes(
                      summary.retainedFiles.reduce((sum, file) => sum + file.sizeBytes, 0)
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={showRetainedFiles}
                    aria-controls={retainedFilesId}
                    onClick={() => setShowRetainedFiles(!showRetainedFiles)}
                  >
                    {showRetainedFiles ? t('Hide files') : t('View files')}
                  </Button>
                </div>
                {showRetainedFiles ? (
                  <div id={retainedFilesId} className="mt-3 border-t border-border pt-2">
                    <div
                      className="mb-2 flex flex-wrap gap-1"
                      role="group"
                      aria-label={t('Required files')}
                    >
                      {[{ id: '', label: t('All') }, ...retainedCategories].map((category) => {
                        const count = category.id
                          ? (retainedByCategory.get(category.id)?.length ?? 0)
                          : retainedFiles.length
                        return count > 0 ? (
                          <Button
                            key={category.id}
                            size="xs"
                            variant={retainedCategory === category.id ? 'secondary' : 'ghost'}
                            aria-pressed={retainedCategory === category.id}
                            onClick={() => {
                              setRetainedCategory(category.id)
                              setRetainedPage(0)
                            }}
                          >
                            {category.label}
                            <span className="tabular-nums text-muted-foreground">{count}</span>
                          </Button>
                        ) : null
                      })}
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                      {visibleRetainedFiles
                        .slice(
                          currentRetainedPage * PAGE_SIZE,
                          (currentRetainedPage + 1) * PAGE_SIZE
                        )
                        .map((file) => (
                          <div key={file.storageKey} className="flex gap-3 py-1">
                            <span className="min-w-0 flex-1 truncate" title={file.filename}>
                              {file.filename.split(/[\\/]/).pop() || file.filename}
                            </span>
                            {!retainedCategory ? (
                              <span className="shrink-0 text-muted-foreground">
                                {
                                  retainedCategories.find(
                                    (category) => category.id === file.category
                                  )?.label
                                }
                              </span>
                            ) : null}
                            <span className="shrink-0 tabular-nums">
                              {packageBytes(file.sizeBytes)}
                            </span>
                          </div>
                        ))}
                    </div>
                    {retainedPages > 1 ? (
                      <div className="mt-2 flex items-center justify-between gap-2 text-text-200">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={currentRetainedPage === 0}
                          onClick={() => setRetainedPage(currentRetainedPage - 1)}
                        >
                          {t('Previous')}
                        </Button>
                        <span>
                          {t('Page {{page}} of {{pages}}', {
                            page: currentRetainedPage + 1,
                            pages: retainedPages
                          })}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={currentRetainedPage + 1 >= retainedPages}
                          onClick={() => setRetainedPage(currentRetainedPage + 1)}
                        >
                          {t('Next')}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            ) : null}
            <div className="space-y-3">
              <label className="block w-full min-w-0 text-xs">
                {t('Search optional files')}
                <Input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setPage(0)
                  }}
                  className="mt-1"
                />
              </label>
              <details className="group text-xs">
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  className="ml-auto flex w-fit cursor-pointer list-none text-muted-foreground group-open:bg-primary/10 group-open:text-primary [&::-webkit-details-marker]:hidden"
                >
                  <summary>
                    <ListFilter aria-hidden="true" />
                    {t('File filters')}
                  </summary>
                </Button>
                <div className="mt-3 space-y-2">
                  <Label htmlFor={thresholdId} className="text-xs text-muted-foreground">
                    {t('Large-file threshold (MiB)')}
                  </Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id={thresholdId}
                      type="number"
                      min="1"
                      value={threshold}
                      onChange={(event) => setThreshold(event.target.value)}
                      className="w-24 tabular-nums"
                    />
                    <Button
                      variant="outline"
                      disabled={!Number.isFinite(Number(threshold)) || Number(threshold) <= 0}
                      onClick={() =>
                        toggle(
                          files.filter((file) => file.sizeBytes > Number(threshold) * 1024 ** 2),
                          false
                        )
                      }
                    >
                      {t('Exclude large files')}
                    </Button>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t(
                      'Optional files are sorted by size, largest first. Files larger than {{limit}} cannot be included.',
                      { limit: packageBytes(PACKAGE_MAX_FILE_BYTES) }
                    )}
                  </p>
                </div>
              </details>
            </div>
            <div className="rounded-lg border border-border px-3">
              {stats.optionalCount > 0 ? (
                <div className="flex justify-end border-b border-border py-2">
                  <Button variant="ghost" size="sm" onClick={() => toggle(files, true)}>
                    {t('Select all')}
                  </Button>
                </div>
              ) : null}
              {filtered
                .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
                .map(([key, entries]) => {
                  const all = entries.every((file) => !excluded.has(file.storageKey))
                  const partial = !all && entries.some((file) => !excluded.has(file.storageKey))
                  const visibleEntries = query
                    ? entries.filter((file) =>
                        file.filename.toLocaleLowerCase().includes(normalizedQuery)
                      )
                    : entries
                  const isExpanded = Boolean(query) || (expanded[key] ?? false)
                  return (
                    <div key={key} className="border-b border-border py-3 last:border-0">
                      <label className="flex items-center gap-2 text-sm font-medium">
                        <Checkbox.Root
                          aria-label={entries[0].filename}
                          disabled={entries.every(
                            (file) =>
                              file.requiredForEvidence || file.sizeBytes > PACKAGE_MAX_FILE_BYTES
                          )}
                          checked={partial ? 'indeterminate' : all}
                          onCheckedChange={(value) => toggle(entries, value === true)}
                          className="grid size-4 shrink-0 place-items-center rounded border border-border disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
                        >
                          <Checkbox.Indicator>
                            {partial ? <Minus className="size-3" /> : <Check className="size-3" />}
                          </Checkbox.Indicator>
                        </Checkbox.Root>
                        <span className="min-w-0 flex-1 break-all">{entries[0].filename}</span>
                        {entries.some((file) => file.requiredForEvidence) ? (
                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  className="text-muted-foreground"
                                >
                                  {t('Required evidence')}
                                  <Info className="size-3" aria-hidden="true" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-72">
                                {t(
                                  'Required files stay included to preserve research evidence. Possible duplicates are retained without scanning file contents.'
                                )}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : null}
                        {entries.length > 1 ? (
                          <span className="shrink-0 text-xs text-text-200">
                            {t('All versions')}
                          </span>
                        ) : null}
                        <span className="shrink-0 text-xs tabular-nums text-text-200">
                          {packageBytes(entries.reduce((sum, file) => sum + file.sizeBytes, 0))}
                        </span>
                      </label>
                      <details
                        open={isExpanded}
                        onToggle={(event) => {
                          if (query) return
                          const open = event.currentTarget.open
                          setExpanded((previous) => {
                            if ((previous[key] ?? false) === open) return previous
                            return { ...previous, [key]: open }
                          })
                        }}
                        className="ml-6 mt-2 text-xs"
                      >
                        <summary className="cursor-pointer text-text-200">
                          {t('Versions and dependencies')}
                        </summary>
                        {isExpanded ? (
                          <>
                            {visibleEntries.slice(0, versionCounts[key] ?? 50).map((file) => (
                              <label key={file.storageKey} className="mt-2 flex items-start gap-2">
                                <input
                                  type="checkbox"
                                  className="accent-primary"
                                  checked={!excluded.has(file.storageKey)}
                                  disabled={
                                    file.requiredForEvidence ||
                                    file.sizeBytes > PACKAGE_MAX_FILE_BYTES
                                  }
                                  onChange={(event) => toggle([file], event.target.checked)}
                                />
                                <span className="min-w-0 flex-1">
                                  {file.source === 'reproducibility'
                                    ? t('Reproduced output')
                                    : t('Version {{number}}', { number: file.versionNumber })}
                                  {file.filename !== entries[0].filename ? (
                                    <span className="mt-1 block break-all">{file.filename}</span>
                                  ) : null}
                                  {file.dependentFiles.length ? (
                                    <span className="mt-1 block break-words text-text-200">
                                      {t('Used by: {{files}}', {
                                        files: file.dependentFiles.join(', ')
                                      })}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="shrink-0 tabular-nums text-text-200">
                                  {packageBytes(file.sizeBytes)}
                                </span>
                              </label>
                            ))}
                            {visibleEntries.length > (versionCounts[key] ?? 50) ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setVersionCounts((previous) => ({
                                    ...previous,
                                    [key]: (previous[key] ?? 50) + 50
                                  }))
                                }
                              >
                                {t('Show more versions')}
                              </Button>
                            ) : null}
                          </>
                        ) : null}
                      </details>
                    </div>
                  )
                })}
              {filtered.length === 0 ? (
                <p className="py-4 text-sm text-text-200">{t('No optional files match.')}</p>
              ) : null}
            </div>
            {pages > 1 ? (
              <div className="flex items-center justify-between text-xs">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  {t('Previous')}
                </Button>
                <span>{t('Page {{page}} of {{pages}}', { page: currentPage + 1, pages })}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={currentPage + 1 === pages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  {t('Next')}
                </Button>
              </div>
            ) : null}
            {children}
          </div>
        ) : null}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('Review private data before sharing.')}
        </p>
        {notice}
      </div>
      <div className={`${dialogFooterClassName} shrink-0 flex-wrap`}>
        <Button variant="ghost" className={dialogCancelButtonClassName} onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button disabled={requiredOversized} onClick={() => onSelect([...excluded])}>
          {t('Export')}
        </Button>
      </div>
    </>
  )
}
