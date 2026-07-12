import type { PreviewFileFormat } from '@/stores/preview-workbench-store'

// Single source of truth for which generated-file extensions the preview panel can render inline.
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
  pdf: 'pdf',
  bash: 'text',
  conf: 'text',
  config: 'text',
  css: 'text',
  ini: 'text',
  js: 'text',
  log: 'text',
  py: 'text',
  sh: 'text',
  toml: 'text',
  ts: 'text',
  tsx: 'text',
  txt: 'text',
  xml: 'text',
  yaml: 'text',
  yml: 'text'
}

export const PREVIEW_PANEL_IMAGE_MAX_BYTES = 10 * 1024 * 1024

// Keeps MIME fallback narrow so unknown binary formats still land in the unsupported state.
const getPreviewFormatForMimeType = (mimeType: string): PreviewFileFormat => {
  const normalizedMimeType = mimeType.toLowerCase().split(';')[0]?.trim() ?? ''

  if (normalizedMimeType.startsWith('image/')) return 'image'
  if (normalizedMimeType === 'application/json' || normalizedMimeType.endsWith('+json')) {
    return 'json'
  }
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
  if (normalizedMimeType === 'application/pdf') return 'pdf'
  if (normalizedMimeType.startsWith('text/')) return 'text'

  return 'unknown'
}

// Looks up the render format for one file, defaulting to the unsupported fallback state.
export const getPreviewFormat = (extension: string, mimeType?: string): PreviewFileFormat => {
  const extensionFormat = PREVIEW_SUPPORTED_EXTENSIONS[extension.toLowerCase()]

  if (extensionFormat) return extensionFormat

  return getPreviewFormatForMimeType(mimeType ?? '')
}

// Extracts a lowercase extension from a filename, or an empty string when there isn't one.
export const getFileExtension = (name: string): string => {
  const extension = name.includes('.') ? name.split('.').pop() : ''

  return extension ? extension.toLowerCase() : ''
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
