import type { PreviewFileRendererProps } from './preview-types'
import { CsvPreviewRenderer } from './renderers/CsvPreview'
import { FastaPreviewRenderer } from './renderers/FastaPreview'
import { HtmlPreviewRenderer } from './renderers/HtmlPreview'
import { ImagePreviewRenderer } from './renderers/ImagePreview'
import { JsonPreviewRenderer } from './renderers/JsonPreview'
import { MarkdownPreviewRenderer } from './renderers/MarkdownPreview'
import { MoleculePreviewRenderer } from './renderers/MoleculePreview'
import { PdbPreviewRenderer } from './renderers/PdbPreview'
import { PdfPreviewRenderer } from './renderers/PdfPreview'
import { TextPreviewRenderer } from './renderers/TextPreview'

// Keeps the registry as the single routing point while avoiding dynamic component creation in render.
export const renderPreviewFile = ({
  item
}: PreviewFileRendererProps): React.JSX.Element | undefined => {
  switch (item.format) {
    case 'csv':
      return <CsvPreviewRenderer item={item} />
    case 'fasta':
      return <FastaPreviewRenderer item={item} />
    case 'html':
      return <HtmlPreviewRenderer item={item} />
    case 'image':
      return <ImagePreviewRenderer item={item} />
    case 'json':
      return <JsonPreviewRenderer item={item} />
    case 'markdown':
      return <MarkdownPreviewRenderer item={item} />
    case 'pdb':
      return <PdbPreviewRenderer item={item} />
    case 'molecule':
      return <MoleculePreviewRenderer item={item} />
    case 'text':
      return <TextPreviewRenderer item={item} />
    case 'pdf':
      return <PdfPreviewRenderer item={item} />
    case 'unknown':
      return undefined
  }
}
