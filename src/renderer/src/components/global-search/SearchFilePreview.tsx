import { useId } from 'react'
import { SearchContentHighlight } from './SearchContentHighlight'
import { PreviewInitialPosition } from '@/pages/workspace/previews/PreviewInitialPosition'
import { TextPreviewRenderer } from '@/pages/workspace/previews/renderers/TextPreview'
import type { ProjectFileItem } from '../../../../shared/project-files'
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
  query,
  contentMatch,
  onOpen
}: {
  item: PreviewFileItem
  query: string
  contentMatch?: ProjectFileItem['contentMatch']
  onOpen: () => void
}): React.JSX.Element => {
  const targetId = useId()
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
            shouldHandlePreviewContextMenu(event.target) ? undefined : null
          }
          asChild
        >
          <div className="search-file-preview relative min-h-64" data-format={item.format}>
            <SearchContentHighlight query={query} className="contents">
              <PreviewInitialPosition value={contentMatch}>
                {contentMatch &&
                (contentMatch.offset > 0 || !['markdown', 'text', 'code'].includes(item.format)) ? (
                  <TextPreviewRenderer item={item} presentation="search" />
                ) : (
                  <PreviewFileContent item={item} presentation="search" />
                )}
              </PreviewInitialPosition>
            </SearchContentHighlight>
          </div>
        </ActionMenuTarget>
      </PreviewActionMenuAdapterProvider>
    </ActionMenuProvider>
  )
}
