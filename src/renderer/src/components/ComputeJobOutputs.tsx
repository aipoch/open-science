import { ChevronDown, FileText, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { createComputeOutputPreviewKey, type JobSummary } from '../../../shared/compute'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { createPreviewFileItem } from '@/pages/workspace/preview-file-item'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'

export function ComputeJobOutputs({
  job,
  onOpened
}: {
  job: JobSummary
  onOpened?: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const open = usePreviewWorkbenchStore((state) => state.upsertAndActivateItem)
  const projectId = job.project_id
  if (!projectId || job.harvested_at == null || job.harvest_error) return null
  const base = 'hpc/' + job.job_id + '/'
  const files = [...new Set([...(job.featured_files ?? []), ...(job.hidden_files ?? [])])].filter(
    (path) => path.startsWith(base + 'featured/') || path.startsWith(base + 'hidden/')
  )
  if (!files.length) return null
  const relativeName = (path: string): string =>
    path.slice(base.length).replace(/^(featured|hidden)\//, '')
  const available = new Set(files)
  const displayName = (path: string): string => {
    const relative = relativeName(path)
    return available.has(base + 'featured/' + relative) &&
      available.has(base + 'hidden/' + relative)
      ? path.slice(base.length)
      : relative
  }
  const name = (path: string): string => path.split('/').at(-1)!
  const openFile = (path: string): void => {
    const key = createComputeOutputPreviewKey({
      projectId,
      sessionId: job.session_id,
      jobId: job.job_id,
      path
    })
    open(
      createPreviewFileItem({
        id: key,
        projectId,
        sessionId: job.session_id,
        path: key,
        name: name(path),
        source: 'compute-output'
      })
    )
    onOpened?.()
  }
  if (files.length === 1) {
    return (
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="min-w-0 max-w-full text-primary"
        title={relativeName(files[0])}
        onClick={() => openFile(files[0])}
      >
        <FileText aria-hidden="true" />
        <span className="truncate">{name(files[0])}</span>
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="text-primary">
          <FolderOpen aria-hidden="true" />
          {t('Outputs')} ({files.length})<ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-64 max-w-[min(24rem,90vw)] overflow-y-auto">
        {files.map((path) => (
          <DropdownMenuItem key={path} onSelect={() => openFile(path)}>
            <FileText aria-hidden="true" className="size-3.5" />
            <span className="break-all">{displayName(path)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
