import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionMenuProvider, ActionMenuTarget } from '@/components/action-menu'
import { PreviewActionMenuAdapterProvider } from '@/pages/workspace/preview-actions/preview-action-adapter'
import {
  PREVIEW_CAPABILITY_CATALOG,
  shouldHandlePreviewContextMenu,
  type PreviewCapabilityId
} from '@/pages/workspace/preview-actions/preview-action-model'
import { PreviewFileContent } from '@/pages/workspace/previews/PreviewFileContent'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

export const SearchFilePreview = ({
  item,
  onOpen
}: {
  item: PreviewFileItem
  onOpen: () => void
}): React.JSX.Element => {
  const targetId = useId()
  const { t } = useTranslation()
  return (
    <ActionMenuProvider testId="search-preview-context-menu">
      <PreviewActionMenuAdapterProvider targetId={targetId}>
        <ActionMenuTarget<PreviewCapabilityId, undefined>
          targetId={targetId}
          identityKey={JSON.stringify([
            item.id,
            item.path,
            item.managedFileId,
            item.selectedVersionId
          ])}
          catalog={PREVIEW_CAPABILITY_CATALOG}
          recipe={[{ kind: 'action', action: 'open-fullscreen' }]}
          bindings={{ 'open-fullscreen': { execute: onOpen } }}
          invocation={undefined}
          resolveInvocation={(event) =>
            event.target instanceof Element && event.target.closest('.search-file-preview-open')
              ? undefined
              : shouldHandlePreviewContextMenu(event.target)
                ? undefined
                : null
          }
          asChild
        >
          <div className="search-file-preview relative min-h-64" data-format={item.format}>
            <PreviewFileContent item={item} presentation="search" />
            <button
              type="button"
              className="search-file-preview-open absolute inset-0 z-10 cursor-zoom-in focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('Open full screen preview')}
              onClick={onOpen}
            />
          </div>
        </ActionMenuTarget>
      </PreviewActionMenuAdapterProvider>
    </ActionMenuProvider>
  )
}
