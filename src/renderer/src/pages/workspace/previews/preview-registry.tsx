import type { PreviewFileRendererProps } from './preview-types'
import { lazy } from 'react'
import { CodePreviewRenderer } from './renderers/CodePreview'
import { CsvPreviewRenderer } from './renderers/CsvPreview'
import { FastaPreviewRenderer } from './renderers/FastaPreview'
import { HtmlPreviewRenderer } from './renderers/HtmlPreview'
import { ImagePreviewRenderer } from './renderers/ImagePreview'
import { MarkdownPreviewRenderer } from './renderers/MarkdownPreview'
import { PlanJsonPreview } from './renderers/PlanJsonPreview'
import { TextPreviewRenderer } from './renderers/TextPreview'
import { getFileExtension } from '../preview-support'

const OfficePreviewRenderer = lazy(() =>
  import('./renderers/OfficePreview').then(({ OfficePreviewRenderer }) => ({
    default: OfficePreviewRenderer
  }))
)
const PdfPreviewRenderer = lazy(() =>
  import('./renderers/PdfPreview').then(({ PdfPreviewRenderer }) => ({
    default: PdfPreviewRenderer
  }))
)
const MoleculePreviewRenderer = lazy(() =>
  import('./renderers/MoleculePreview').then(({ MoleculePreviewRenderer }) => ({
    default: MoleculePreviewRenderer
  }))
)
const PdbPreviewRenderer = lazy(() =>
  import('./renderers/PdbPreview').then(({ PdbPreviewRenderer }) => ({
    default: PdbPreviewRenderer
  }))
)
const TiffPreviewRenderer = lazy(() =>
  import('./renderers/TiffPreview').then(({ TiffPreviewRenderer }) => ({
    default: TiffPreviewRenderer
  }))
)
const NotebookFilePreview = lazy(() =>
  import('./renderers/NotebookFilePreview').then(({ NotebookFilePreview }) => ({
    default: NotebookFilePreview
  }))
)

// Keeps the registry as the single routing point while avoiding dynamic component creation in render.
export const renderPreviewFile = ({
  item,
  presentation,
  annotationVersionId,
  annotationBlockedByHistoricalVersion,
  annotationVersionPending,
  activeAnnotations,
  onAddAnnotation,
  onUpdateAnnotationNote,
  onRemoveAnnotation,
  onAnnotationError,
  onPdfReadingPositionChange
}: PreviewFileRendererProps): React.JSX.Element | undefined => {
  const props = {
    item,
    presentation,
    annotationVersionId,
    annotationBlockedByHistoricalVersion,
    annotationVersionPending,
    activeAnnotations,
    onAddAnnotation,
    onUpdateAnnotationNote,
    onRemoveAnnotation,
    onAnnotationError
  }
  if (
    getFileExtension(item.name) === 'ipynb' ||
    item.mimeType?.split(';')[0] === 'application/x-ipynb+json'
  )
    return <NotebookFilePreview {...props} />
  switch (item.format) {
    case 'code':
      return <CodePreviewRenderer {...props} />
    case 'csv':
      return <CsvPreviewRenderer {...props} />
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
      return <MoleculePreviewRenderer {...props} />
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
