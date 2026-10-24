import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { ReplayDocument, ReplayResource, ReplayStep } from '../../../../shared/replay'
import { ReplayFileRow } from './replay/ReplayFileRow'

const PAGE_SIZE = 40

// Catalogs immutable source records only. Full evidence is read on demand by the existing reader.
export const ResearchMaterialsPanel = ({
  document,
  mode,
  onOpenRecord,
  onOpenFile
}: {
  document: ReplayDocument
  mode: 'records' | 'files'
  onOpenRecord: (step: ReplayStep) => void
  onOpenFile: (resource: ReplayResource) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [branchId, setBranchId] = useState(document.defaultBranchId)
  const [page, setPage] = useState(0)
  const branch = document.branches.find((item) => item.id === branchId) ?? document.branches[0]
  const count = mode === 'records' ? (branch?.steps.length ?? 0) : document.resources.length
  const lastPage = Math.max(0, Math.ceil(count / PAGE_SIZE) - 1)
  const currentPage = Math.min(page, lastPage)
  const start = currentPage * PAGE_SIZE
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={mode === 'records' ? t('Original records') : t('Source files')}
    >
      <div className="space-y-2 border-b border-border-200 p-3">
        <p className="text-xs text-text-300">{t('Read-only recorded materials.')}</p>
        {mode === 'records' && document.branches.length > 1 ? (
          <Select
            value={branch?.id}
            onValueChange={(id) => {
              setBranchId(id)
              setPage(0)
            }}
          >
            <SelectTrigger aria-label={t('Branch')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {document.branches.map((row, index) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.label ?? t('Branch {{number}}', { number: index + 1 })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-auto p-3">
        {count === 0 ? (
          <p className="p-3 text-sm text-text-300">
            {mode === 'records'
              ? t('No original records are available.')
              : t('No source files are available.')}
          </p>
        ) : null}
        {mode === 'records'
          ? branch?.steps.slice(start, start + PAGE_SIZE).map((step, index) => (
              <Button
                key={step.id}
                data-research-record={step.id}
                variant="ghost"
                className="h-auto min-h-12 w-full justify-start gap-3 px-3 py-2 text-left"
                onClick={() => onOpenRecord(step)}
              >
                <span className="shrink-0 text-xs tabular-nums text-text-300">
                  {start + index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {step.message
                      ? step.message.role === 'user'
                        ? t('User')
                        : t('Agent')
                      : step.kind === 'notebook'
                        ? t('Notebook')
                        : step.kind === 'review'
                          ? t('Review')
                          : step.kind === 'artifact'
                            ? t('Files')
                            : t('Tool call')}
                  </span>
                  <span className="block truncate text-xs font-normal text-text-300">
                    {step.title ?? step.message?.content.slice(0, 180) ?? step.activities[0]?.title}
                  </span>
                </span>
              </Button>
            ))
          : document.resources
              .slice(start, start + PAGE_SIZE)
              .map((resource) => (
                <ReplayFileRow
                  key={resource.id}
                  resource={resource}
                  onSelect={() => onOpenFile(resource)}
                />
              ))}
      </div>
      {lastPage > 0 ? (
        <div className="flex items-center justify-between border-t border-border-200 p-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {t('Previous')}
          </Button>
          <span className="text-xs text-text-300">
            {t('Page {{page}} of {{total}}', { page: currentPage + 1, total: lastPage + 1 })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={currentPage === lastPage}
            onClick={() => setPage(currentPage + 1)}
          >
            {t('Next')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
