import type { PreviewFileFormat } from '@/stores/preview-workbench-store'

// Single source of truth for which managed-file extensions the preview panel can render inline.
// Add an entry here and a matching file renderer to light up a new previewable format.
const PREVIEW_SUPPORTED_EXTENSIONS: Record<string, PreviewFileFormat> = {
  avif: 'image',
  gif: 'image',
  jpeg: 'image',
  jpg: 'image',
  png: 'image',
  svg: 'image',
  webp: 'image',
  csv: 'csv',
  tsv: 'csv',
  fa: 'fasta',
  faa: 'fasta',
  fasta: 'fasta',
  ffn: 'fasta',
  fna: 'fasta',
  frn: 'fasta',
  htm: 'html',
  html: 'html',
  json: 'json',
  markdown: 'markdown',
  md: 'markdown',
  pdb: 'pdb',
  mol: 'molecule',
  sdf: 'molecule',
  smi: 'molecule',
  smiles: 'molecule',
  rxn: 'molecule',
  pdf: 'pdf',
  docx: 'word',
  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  pptx: 'presentation',
  bash: 'text',
  conf: 'text',
  config: 'text',
  css: 'text',
  ini: 'text',
  iqtree: 'text',
  js: 'text',
  log: 'text',
  nwk: 'text',
  py: 'text',
  sh: 'text',
  state: 'text',
  toml: 'text',
  tree: 'text',
  treefile: 'text',
  ts: 'text',
  tsx: 'text',
  txt: 'text',
  xml: 'text',
  yaml: 'text',
  yml: 'text'
}

// Keeps MIME fallback narrow so unknown binary formats still land in the unsupported state.
const getPreviewFormatForMimeType = (mimeType: string): PreviewFileFormat => {
  const normalizedMimeType = mimeType.toLowerCase().split(';')[0]?.trim() ?? ''

  if (normalizedMimeType.startsWith('image/')) return 'image'
  if (normalizedMimeType === 'application/json' || normalizedMimeType.endsWith('+json')) {
    return 'json'
  }
  if (normalizedMimeType === 'application/xml' || normalizedMimeType.endsWith('+xml')) return 'text'
  if (normalizedMimeType === 'text/html') return 'html'
  if (normalizedMimeType === 'text/csv' || normalizedMimeType === 'text/tab-separated-values') {
    return 'csv'
  }
  if (normalizedMimeType === 'text/markdown') return 'markdown'
  if (
    normalizedMimeType === 'chemical/x-pdb' ||
    normalizedMimeType === 'chemical/pdb' ||
    normalizedMimeType === 'application/x-pdb'
  ) {
    return 'pdb'
  }
  if (
    normalizedMimeType === 'chemical/x-mdl-molfile' ||
    normalizedMimeType === 'chemical/x-mdl-sdfile' ||
    normalizedMimeType === 'chemical/x-mdl-rxnfile' ||
    normalizedMimeType === 'chemical/x-daylight-smiles'
  ) {
    return 'molecule'
  }
  if (normalizedMimeType === 'application/pdf') return 'pdf'
  // Office MIME fallback covers extensionless uploads while preserving explicit format routing.
  if (
    normalizedMimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'word'
  }
  if (
    normalizedMimeType === 'application/vnd.ms-excel' ||
    normalizedMimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return 'spreadsheet'
  }
  if (
    normalizedMimeType ===
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return 'presentation'
  }
  if (normalizedMimeType.startsWith('text/')) return 'text'

  return 'unknown'
}

// Looks up the render format for one file, defaulting to the unsupported fallback state.
export const getPreviewFormat = (extension: string, mimeType?: string): PreviewFileFormat => {
  const normalizedExtension = extension.toLowerCase()
  const extensionFormat = PREVIEW_SUPPORTED_EXTENSIONS[normalizedExtension]

  if (extensionFormat) return extensionFormat
  // Legacy Office formats must not enter OOXML renderers through misleading MIME metadata.
  if (normalizedExtension === 'doc' || normalizedExtension === 'ppt') return 'unknown'

  return getPreviewFormatForMimeType(mimeType ?? '')
}

// Extracts a lowercase extension from a filename, or an empty string when there isn't one.
export const getFileExtension = (name: string): string => {
  const extension = name.includes('.') ? name.split('.').pop() : ''

  return extension ? extension.toLowerCase() : ''
}

// Resolves preview capability from file metadata without considering where the file came from.
export const getPreviewFormatForFile = ({
  name,
  mimeType
}: {
  name: string
  mimeType?: string
}): PreviewFileFormat => getPreviewFormat(getFileExtension(name), mimeType)

// Selects the reader encoding used for lightweight thumbnails in file lists.
export const getPreviewThumbnailReadEncoding = (format: PreviewFileFormat): 'utf8' | undefined => {
  // Binary document formats use dedicated full-byte readers and must not use truncated thumbnails.
  if (
    format === 'markdown' ||
    format === 'text' ||
    format === 'json' ||
    format === 'csv' ||
    format === 'fasta' ||
    format === 'html' ||
    format === 'pdb' ||
    format === 'molecule'
  ) {
    return 'utf8'
  }

  return undefined
}

// Shared with artifact-preview.tsx thumbnails so both surfaces infer the same mime type from a name.
export const getImageMimeTypeForExtension = (extension: string): string => {
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'png') return 'image/png'
  if (extension === 'svg') return 'image/svg+xml'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'avif') return 'image/avif'

  return ''
}
