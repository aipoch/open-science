import type { PreviewToolItem } from '@/stores/preview-workbench-store'

import { KetcherTile } from '../KetcherTile'
import type { KetcherPreviewItem } from '../KetcherTile'
import { NotebookPreview } from '../NotebookPreview'
import type { NotebookPreviewItem } from '../NotebookPreview'
import { ProjectFilesView } from '../ProjectFilesView'

const isNotebookPreviewItem = (item: PreviewToolItem): item is NotebookPreviewItem =>
  item.toolKind === 'notebook' && Boolean(item.notebook)

const isKetcherPreviewItem = (item: PreviewToolItem): item is KetcherPreviewItem =>
  item.toolKind === 'ketcher' && Boolean(item.ketcher)

export const PreviewToolContent = ({
  item
}: {
  item: PreviewToolItem
}): React.JSX.Element | null => {
  if (item.toolKind === 'files') return <ProjectFilesView />

  if (isKetcherPreviewItem(item)) return <KetcherTile item={item} />

  if (!isNotebookPreviewItem(item)) return null

  return <NotebookPreview item={item} />
}
