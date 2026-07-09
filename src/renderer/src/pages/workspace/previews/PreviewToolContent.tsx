import type { PreviewToolItem } from '@/stores/preview-workbench-store'

import { NotebookPreview } from '../NotebookPreview'
import type { NotebookPreviewItem } from '../NotebookPreview'
import { ProjectFilesView } from '../ProjectFilesView'

const isNotebookPreviewItem = (item: PreviewToolItem): item is NotebookPreviewItem =>
  item.toolKind === 'notebook' && Boolean(item.notebook)

export const PreviewToolContent = ({
  item
}: {
  item: PreviewToolItem
}): React.JSX.Element | null => {
  if (item.toolKind === 'files') return <ProjectFilesView />

  if (!isNotebookPreviewItem(item)) return null

  return <NotebookPreview item={item} />
}
