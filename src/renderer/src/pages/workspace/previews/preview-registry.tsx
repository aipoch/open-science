import type { PreviewFileRendererProps } from './preview-types'
import { CodePreviewRenderer } from './renderers/CodePreview'
import { CsvPreviewRenderer } from './renderers/CsvPreview'
import { FastaPreviewRenderer } from './renderers/FastaPreview'
import { HtmlPreviewRenderer } from './renderers/HtmlPreview'
import { ImagePreviewRenderer } from './renderers/ImagePreview'
import { MarkdownPreviewRenderer } from './renderers/MarkdownPreview'
import { MoleculePreviewRenderer } from './renderers/MoleculePreview'
import { OfficePreviewRenderer } from './renderers/OfficePreview'
import { PdbPreviewRenderer } from './renderers/PdbPreview'
import { PlanJsonPreview } from './renderers/PlanJsonPreview'
import { PdfPreviewRenderer } from './renderers/PdfPreview'
import { TextPreviewRenderer } from './renderers/TextPreview'
import { TiffPreviewRenderer } from './renderers/TiffPreview'

// Keeps the registry as the single routing point while avoiding dynamic component creation in render.
export const renderPreviewFile = ({
  item,
  activeAnnotations,
  onAddAnnotation,
  onUpdateAnnotationNote,
  onRemoveAnnotation,
  onAnnotationError,
  onPdfReadingPositionChange
}: PreviewFileRendererProps): React.JSX.Element | undefined => {
  const props = {
    item,
    activeAnnotations,
    onAddAnnotation,
    onUpdateAnnotationNote,
    onRemoveAnnotation,
    onAnnotationError
  }
  switch (item.format) {
    case 'code':
      return <CodePreviewRenderer {...props} />
    case 'csv':
      return <CsvPreviewRenderer item={item} />
    case 'fasta':
      return <FastaPreviewRenderer {...props} />
    case 'html':
      return <HtmlPreviewRenderer {...props} />
    case 'image':
      return <ImagePreviewRenderer {...props} />
    case 'json':
      return <PlanJsonPreview item={item} />
    case 'markdown':
      return <MarkdownPreviewRenderer {...props} />
    case 'pdb':
      return <PdbPreviewRenderer item={item} />
    case 'molecule':
      return <MoleculePreviewRenderer item={item} />
    case 'text':
      return <TextPreviewRenderer {...props} />
    case 'tiff':
      return <TiffPreviewRenderer item={item} />
    case 'pdf':
      return (
        <PdfPreviewRenderer {...props} onPdfReadingPositionChange={onPdfReadingPositionChange} />
      )
    case 'word':
    case 'spreadsheet':
    case 'presentation':
      return <OfficePreviewRenderer item={item} />
    case 'unknown':
      return undefined
  }
}
