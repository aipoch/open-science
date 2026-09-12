import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Checkbox } from 'radix-ui'
import { Check, ChevronDown, Info, Minus } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  const { excludedStorageKeys, selectionPreset, threshold, setThreshold } =
    usePackageOperationStore()
  const [query, setQuery] = useState('')
  const [customizing, setCustomizing] = useState(false)
  const [page, setPage] = useState(0)
  const [retainedPage, setRetainedPage] = useState(0)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [versionCounts, setVersionCounts] = useState<Record<string, number>>({})
  const excluded = new Set(excludedStorageKeys ?? [])
  const groups = useMemo(() => {
    const result = new Map<string, PackageSelectableFile[]>()
    for (const file of files) {
      const key = `${file.source}:${file.groupId}`
      const group = result.get(key)
      if (group) group.push(file)
      else result.set(key, [file])
    }
    return [...result].sort(
      (a, b) =>
        b[1].reduce((sum, file) => sum + file.sizeBytes, 0) -
        a[1].reduce((sum, file) => sum + file.sizeBytes, 0)
    )
  }, [files])
  const filtered = groups.filter(([, entries]) =>
    entries.some((file) => file.filename.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
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
  const selected = files.filter((file) => !excluded.has(file.storageKey))
  const selectedBytes = selected.reduce((sum, file) => sum + file.sizeBytes, 0)
  const retainedBytes =
    (summary?.metadataBytes ?? 0) +
    (summary?.retainedFiles.reduce((sum, file) => sum + file.sizeBytes, 0) ?? 0)
  const oversized = files.some((file) => file.sizeBytes > PACKAGE_MAX_FILE_BYTES)
  const requiredOversized = files.some(
    (file) => file.requiredForEvidence && file.sizeBytes > PACKAGE_MAX_FILE_BYTES
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
          {(['full', 'compact'] as const).map((preset) => (
            <label
              key={preset}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${selectionPreset === preset ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'} ${preset === 'full' && oversized ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <input
                type="radio"
                name="package-preset"
                className="mt-0.5 shrink-0 accent-primary"
                aria-label={preset === 'full' ? t('Full export') : t('Compact export')}
                checked={selectionPreset === preset}
                disabled={preset === 'full' && oversized}
                onChange={() => choosePreset(preset)}
              />
              <span className="space-y-1">
                <span className="block font-medium">
                  {preset === 'full' ? t('Full export') : t('Compact export')}
                </span>
                <span className="block text-xs leading-relaxed text-muted-foreground">
                  {preset === 'full' ? t('All available files.') : t('Required evidence only.')}
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
                  'Full export is unavailable because a file exceeds {{limit}}. Choose Compact export or customize the contents.',
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
                    <button
                      type="button"
                      aria-label={t('About the size estimate')}
                      className="rounded-sm p-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <Info className="size-3.5" aria-hidden="true" />
                    </button>
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
                {packageBytes(
                  retainedBytes +
                    files
                      .filter((file) => file.requiredForEvidence)
                      .reduce((sum, file) => sum + file.sizeBytes, 0)
                )}
              </span>
            </p>
          ) : null}
          {files.some((file) => !file.requiredForEvidence) ? (
            <p className="text-xs text-muted-foreground">
              {t('Selected: {{selected}} / {{total}} files · {{size}}', {
                selected: selected.filter((file) => !file.requiredForEvidence).length,
                total: files.filter((file) => !file.requiredForEvidence).length,
                size: packageBytes(
                  selected
                    .filter((file) => !file.requiredForEvidence)
                    .reduce((sum, file) => sum + file.sizeBytes, 0)
                )
              })}
            </p>
          ) : null}
        </div>
        {excluded.size > 0 && selectionPreset === 'custom' ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('Some file contents are not included. Review your selection in Customize contents.')}
          </p>
        ) : null}
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
        {customizing ? (
          <div id="package-customization" className="space-y-4 border-t border-border pt-4">
            <p className="text-sm text-text-200">
              {t(
                'Conversation and evidence metadata are always included. Unselected file contents are recorded as not included.'
              )}
            </p>
            {files.some((file) => file.requiredForEvidence) ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  'Required files stay included to preserve research evidence. Possible duplicates are retained without scanning file contents.'
                )}
              </p>
            ) : null}
            {summary && summary.retainedFiles.length > 0 ? (
              <details className="rounded-lg border border-border p-3 text-xs">
                <summary className="cursor-pointer font-medium">
                  {t('Retained workspace and evidence files')}
                </summary>
                <p className="mt-3 text-text-200">
                  {t('Retained content')} · {packageBytes(retainedBytes)}
                </p>
                <p className="mt-2 text-text-200">
                  {t('Uncompressed upper estimate. The final package may be smaller.')}
                </p>
                <p className="mt-2 text-text-200">
                  {t(
                    'Review content before sharing; files may contain private information. Files duplicated in retained evidence must remain included.'
                  )}
                </p>
                <p className="my-2 text-text-200">
                  {t(
                    'Formal research evidence cannot be excluded. The large-file filter applies only to optional files.'
                  )}
                </p>
                <div className="max-h-32 overflow-y-auto">
                  {[...summary.retainedFiles]
                    .sort((a, b) => b.sizeBytes - a.sizeBytes)
                    .slice(retainedPage * PAGE_SIZE, (retainedPage + 1) * PAGE_SIZE)
                    .map((file) => (
                      <div key={file.storageKey} className="flex gap-3 py-1">
                        <span className="min-w-0 flex-1 truncate" title={file.filename}>
                          {file.filename}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {packageBytes(file.sizeBytes)}
                        </span>
                      </div>
                    ))}
                </div>
                {summary.retainedFiles.length > 25 ? (
                  <div className="mt-2 flex items-center justify-between gap-2 text-text-200">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={retainedPage === 0}
                      onClick={() => setRetainedPage(retainedPage - 1)}
                    >
                      {t('Previous')}
                    </Button>
                    <span>
                      {retainedPage === 0
                        ? t('Showing the 25 largest retained files.')
                        : t('Page {{page}} of {{pages}}', {
                            page: retainedPage + 1,
                            pages: Math.ceil(summary.retainedFiles.length / PAGE_SIZE)
                          })}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={(retainedPage + 1) * PAGE_SIZE >= summary.retainedFiles.length}
                      onClick={() => setRetainedPage(retainedPage + 1)}
                    >
                      {t('Next')}
                    </Button>
                  </div>
                ) : null}
              </details>
            ) : null}
            <div className="space-y-3">
              <label className="block w-full min-w-0 text-xs">
                {t('Search optional files')}
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setPage(0)
                  }}
                  className="mt-1 w-full rounded border border-border bg-bg-000 px-2 py-1.5"
                />
              </label>
              <details className="group text-xs">
                <summary className="w-fit cursor-pointer rounded-md px-2 py-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                  {t('File filters')}
                </summary>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <label className="text-xs">
                    {t('Large-file threshold (MiB)')}
                    <input
                      type="number"
                      min="1"
                      value={threshold}
                      onChange={(event) => setThreshold(event.target.value)}
                      className="ml-2 w-20 rounded border border-border bg-bg-000 px-2 py-1.5"
                    />
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
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
                  <Button variant="ghost" size="sm" onClick={() => toggle(files, true)}>
                    {t('Select all')}
                  </Button>
                </div>
              </details>
            </div>
            <p className="text-xs text-text-200">
              {t(
                'Optional files are sorted by size, largest first. Files larger than {{limit}} cannot be included.',
                { limit: packageBytes(PACKAGE_MAX_FILE_BYTES) }
              )}
            </p>
            <div className="rounded-lg border border-border px-3">
              {filtered
                .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
                .map(([key, entries]) => {
                  const all = entries.every((file) => !excluded.has(file.storageKey))
                  const partial = !all && entries.some((file) => !excluded.has(file.storageKey))
                  const visibleEntries = query
                    ? entries.filter((file) =>
                        file.filename.toLocaleLowerCase().includes(query.toLocaleLowerCase())
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
                          <span className="text-xs text-muted-foreground">
                            {t('Required evidence')}
                          </span>
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
          {t('Cancel operation')}
        </Button>
        <Button disabled={requiredOversized} onClick={() => onSelect([...excluded])}>
          {t('Choose save location')}
        </Button>
      </div>
    </>
  )
}
