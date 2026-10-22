import { parseHttpsSourceUrl } from '../../../shared/source-preview'
import type { PreviewSourceItem } from '../stores/preview-workbench-contract'

type SourcePreviewInput = {
  href: string
  title?: string
}

const createSourcePreviewItem = ({
  href,
  title
}: SourcePreviewInput): PreviewSourceItem | undefined => {
  const url = parseHttpsSourceUrl(href)
  if (!url) return undefined

  const sourceTitle = title?.trim() || url.hostname
  return {
    id: `source:${url.href}`,
    sessionId: '__sources__',
    title: sourceTitle,
    type: 'source',
    url: url.href
  }
}

export { createSourcePreviewItem }
