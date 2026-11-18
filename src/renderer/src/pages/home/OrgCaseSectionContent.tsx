import { useTranslation } from 'react-i18next'
import { LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import { ORG_CASE_MAX_QUERY_LENGTH } from '../../../../shared/org-cases'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { labSettingsAvailable } from '@/lib/session-package-capabilities'
import { useSettingsStore } from '@/stores/settings-store'
import { OrgCaseCard } from './OrgCaseCard'
import {
  describeOrgCaseError,
  orgCaseErrorNoticeActions,
  resolveOrgCaseLabError
} from './org-case-errors'
import { useOrgCaseSearchActions, useOrgCaseStore } from '@/stores/org-cases-store'

export const OrgCaseSectionContent = ({
  variant,
  showInlineToolbar = variant === 'home',
  importDisabled = false,
  onOpenDetails
}: {
  variant: 'home' | 'marketplace'
  showInlineToolbar?: boolean
  importDisabled?: boolean
  onOpenDetails: (caseId: string, opener?: HTMLElement | null) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const lab = useSettingsStore((state) => state.lab)
  const openSettingsToPanel = useSettingsStore((state) => state.openSettingsToPanel)
  const items = useOrgCaseStore((state) => state.items)
  const total = useOrgCaseStore((state) => state.total)
  const page = useOrgCaseStore((state) => state.page)
  const loading = useOrgCaseStore((state) => state.loading)
  const loadingMore = useOrgCaseStore((state) => state.loadingMore)
  const hasLoadedOnce = useOrgCaseStore((state) => state.hasLoadedOnce)
  const listError = useOrgCaseStore((state) => state.listError)
  const lastListRequestFailedAppend = useOrgCaseStore((state) => state.lastListRequestFailedAppend)
  const download = useOrgCaseStore((state) => state.download)
  const downloadError = useOrgCaseStore((state) => state.downloadError)
  const loadCases = useOrgCaseStore((state) => state.loadCases)
  const importCase = useOrgCaseStore((state) => state.importCase)
  const cancelImport = useOrgCaseStore((state) => state.cancelImport)
  const dismissDownloadError = useOrgCaseStore((state) => state.dismissDownloadError)

  const { query, committedQuery, setQuery, submitSearch, refresh } =
    useOrgCaseSearchActions(showInlineToolbar)

  const labGuardError = resolveOrgCaseLabError(lab)
  const activeError = labGuardError ?? listError
  const errorPresentation = activeError ? describeOrgCaseError(activeError, t) : null
  const isAuthenticated = lab?.state === 'authenticated'
  const showLabSettingsAction = labSettingsAvailable()
  const hasMore = items.length < total
  const handleRetry = (): void => {
    if (!labGuardError && lastListRequestFailedAppend) {
      void loadCases({ q: committedQuery, page: page + 1, append: true })
      return
    }
    refresh()
  }
  const errorNoticeActions = errorPresentation
    ? orgCaseErrorNoticeActions(errorPresentation, t, {
        onOpenLabSettings: showLabSettingsAction ? () => openSettingsToPanel('lab') : undefined,
        onRetry: handleRetry
      })
    : {}

  return (
    <div className={cn(variant === 'marketplace' ? 'space-y-5' : 'space-y-3')}>
      {showInlineToolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1 max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              maxLength={ORG_CASE_MAX_QUERY_LENGTH}
              aria-label={t('Search organization cases')}
              placeholder={t('Search by name or share code')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitSearch()
                }
              }}
              className="h-8 pl-8 pr-8 text-xs"
            />
            {query ? (
              <button
                type="button"
                aria-label={t('Clear search')}
                onClick={() => submitSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          {isAuthenticated ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={loading}
              aria-label={t('Refresh organization cases')}
              onClick={refresh}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              {t('Refresh')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {errorPresentation && items.length === 0 ? (
        <ErrorNotice
          inline={variant === 'home'}
          level={errorPresentation.level}
          title={errorPresentation.title}
          description={errorPresentation.description}
          {...errorNoticeActions}
        />
      ) : loading && items.length === 0 ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-xl border border-border/70 bg-muted/20 px-4 py-6 text-sm text-muted-foreground"
        >
          <LoaderCircle className="h-4 w-4 animate-spin" />
          <span>{t('Loading organization cases…')}</span>
        </div>
      ) : items.length === 0 && hasLoadedOnce ? (
        <div className="flex flex-col items-start justify-between gap-3 rounded-xl border border-dashed border-border/80 bg-muted/15 px-4 py-5 sm:flex-row sm:items-center">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              {committedQuery
                ? t('No matching organization cases')
                : t('No organization cases yet')}
            </p>
            <p className="text-xs text-muted-foreground">
              {committedQuery
                ? t('Try a different case name or 8-character share code.')
                : t('Cases shared by members of your Lab organization will appear here.')}
            </p>
          </div>
          {committedQuery ? (
            <Button type="button" variant="outline" size="sm" onClick={() => submitSearch('')}>
              {t('Reset search')}
            </Button>
          ) : null}
        </div>
      ) : items.length > 0 ? (
        <div className="space-y-3">
          {errorPresentation ? (
            <ErrorNotice
              inline
              level={errorPresentation.level}
              title={errorPresentation.title}
              description={errorPresentation.description}
              {...errorNoticeActions}
            />
          ) : null}

          <div
            className={cn(
              variant === 'home'
                ? 'flex items-stretch gap-3 overflow-x-auto pb-1'
                : 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'
            )}
          >
            {items.map((item) => (
              <OrgCaseCard
                key={item.id}
                item={item}
                layout={variant === 'home' ? 'carousel' : 'grid'}
                download={download}
                downloadError={downloadError?.caseId === item.id ? downloadError.errorCode : null}
                importBusy={Boolean(download && download.caseId !== item.id)}
                importDisabled={importDisabled}
                onExplore={onOpenDetails}
                onImport={(caseId) => {
                  void importCase(caseId)
                }}
                onCancelImport={(caseId) => {
                  void cancelImport(caseId)
                }}
                onDismissError={dismissDownloadError}
                onOpenLabSettings={
                  showLabSettingsAction ? () => openSettingsToPanel('lab') : undefined
                }
              />
            ))}
          </div>

          {variant === 'marketplace' || hasMore ? (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <p className="text-xs text-muted-foreground">
                {t('Showing {{shown}} of {{total}} organization cases', {
                  shown: items.length,
                  total
                })}
              </p>
              {hasMore ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loadingMore || loading}
                  onClick={() =>
                    void loadCases({ q: committedQuery, page: page + 1, append: true })
                  }
                >
                  {loadingMore ? (
                    <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  {t('Load more')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
