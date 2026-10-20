import { Button } from '@/components/ui/button'
import { formatByteSize } from '@/lib/utils'
import type { ReplayResource } from '../../../../../shared/replay'
import { ExtensionPreservingFileName } from '../ExtensionPreservingFileName'
import { FileTypeIcon } from '../file-type-icon'
import { useTranslation } from 'react-i18next'

// Reuse the Files presentation without mounting its live project queries or write actions.
export const ReplayFileRow = ({
  resource,
  onSelect,
  compact = false,
  selected = false
}: {
  selected?: boolean
  compact?: boolean
  resource: ReplayResource
  onSelect: React.MouseEventHandler<HTMLButtonElement>
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <Button
      variant={selected ? 'secondary' : 'ghost'}
      aria-current={selected ? 'true' : undefined}
      className="h-auto min-h-10 w-full min-w-0 justify-start gap-2 px-2 py-2 text-xs"
      data-replay-material-item={`resource:${resource.id}`}
      onClick={onSelect}
      aria-label={`${resource.name}${resource.versionNumber !== undefined ? ` ${t('Version {{version}}', { version: resource.versionNumber })}` : ''}`}
    >
      <FileTypeIcon name={resource.name} mimeType={resource.mimeType} />
      <span className="min-w-0 flex-1 text-left">
        <ExtensionPreservingFileName name={resource.name} />
        {resource.availability === 'unavailable' ? (
          <span className="block whitespace-normal text-muted-foreground">
            {t('This exact file version is unavailable.')}
          </span>
        ) : null}
      </span>
      <span
        className={
          compact ? 'flex shrink-0 flex-col items-end gap-0.5 text-[10px]' : 'flex shrink-0 gap-2'
        }
      >
        {resource.versionNumber !== undefined ? (
          <span className="shrink-0 text-muted-foreground">
            {t('Version {{version}}', { version: resource.versionNumber })}
          </span>
        ) : null}
        {resource.size !== undefined ? (
          <span className="shrink-0 text-muted-foreground">{formatByteSize(resource.size)}</span>
        ) : null}
      </span>
    </Button>
  )
}
