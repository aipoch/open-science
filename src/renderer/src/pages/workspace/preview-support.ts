import type { PreviewFileFormat, PreviewFileSource } from '@/stores/preview-workbench-contract'

// Single source of truth for which managed-file extensions the preview panel can render inline.
// Add an entry here and a matching file renderer to light up a new previewable format.
const PREVIEW_SUPPORTED_EXTENSIONS: Record<string, PreviewFileFormat> = {
  avif: 'image',
  gif: 'image',
  jpeg: 'image',
  jpg: 'image',
  png: 'image',
  svg: 'image',
  tif: 'tiff',
  tiff: 'tiff',
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
  ipynb: 'json',
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
  conf: 'text',
  config: 'text',
  ini: 'text',
  iqtree: 'text',
  log: 'text',
  nwk: 'text',
  state: 'text',
  toml: 'text',
  tree: 'text',
  treefile: 'text',
  txt: 'text',
  xml: 'text',
  yaml: 'text',
  yml: 'text'
}

export const PREVIEW_CODE_LANGUAGES: Record<string, string> = {
  bash: 'bash',
  bib: 'bibtex',
  bibtex: 'bibtex',
  css: 'css',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  r: 'r',
  sh: 'bash',
  tex: 'latex',
  ts: 'typescript',
  tsx: 'tsx'
}

type MoleculeFormat = 'smiles' | 'mol' | 'sdf' | 'rxn'

const MOLECULE_EXTENSIONS: Record<string, MoleculeFormat> = {
  smi: 'smiles',
  smiles: 'smiles',
  mol: 'mol',
  sdf: 'sdf',
  rxn: 'rxn'
}
const MOLECULE_MIME_TYPES: Record<string, MoleculeFormat> = {
  'chemical/x-daylight-smiles': 'smiles',
  'chemical/x-mdl-molfile': 'mol',
  'chemical/x-mdl-sdfile': 'sdf',
  'chemical/x-mdl-rxnfile': 'rxn'
}

// Explicit extensions win; extensionless/unknown names use the same MIME fallback as routing.
export const getMoleculeFormat = (extension: string, mimeType = ''): MoleculeFormat | undefined =>
  MOLECULE_EXTENSIONS[extension.toLowerCase()] ??
  MOLECULE_MIME_TYPES[mimeType.toLowerCase().split(';')[0].trim()]

// Keeps MIME fallback narrow so unknown binary formats still land in the unsupported state.
const getPreviewFormatForMimeType = (mimeType: string): PreviewFileFormat => {
  const normalizedMimeType = mimeType.toLowerCase().split(';')[0]?.trim() ?? ''

  if (normalizedMimeType === 'image/tiff' || normalizedMimeType === 'image/x-tiff') return 'tiff'
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
  if (getMoleculeFormat('', normalizedMimeType)) return 'molecule'
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
  if (PREVIEW_CODE_LANGUAGES[normalizedExtension]) return 'code'
  // Legacy Office formats must not enter OOXML renderers through misleading MIME metadata.
  if (normalizedExtension === 'doc' || normalizedExtension === 'ppt') return 'unknown'

  return getPreviewFormatForMimeType(mimeType ?? '')
}

// Extracts a lowercase extension from a filename, or an empty string when there isn't one.
export const getFileExtension = (name: string): string => {
  const extension = name.includes('.') ? name.split('.').pop() : ''

  return extension ? extension.toLowerCase() : ''
}

// Keep the working folder's existing format scope. HTML and SVG remain inert source text.
const PROJECT_FOLDER_PREVIEW_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'txt',
  'csv',
  'tsv',
  'md',
  'json',
  'yaml',
  'yml',
  'xml',
  'svg',
  'html',
  'css',
  'js',
  'ts',
  'py',
  'r',
  'sh',
  'log',
  'sql',
  'toml',
  'ini',
  'fasta',
  'fa',
  'fastq',
  'bed',
  'vcf'
])

// Resolves preview capability from file metadata and the source's supported formats.
export const getPreviewFormatForFile = ({
  name,
  mimeType,
  source
}: {
  name: string
  mimeType?: string
  source?: PreviewFileSource
}): PreviewFileFormat => {
  const extension = getFileExtension(name)
  if (source !== 'project-folder') return getPreviewFormat(extension, mimeType)
  if (!PROJECT_FOLDER_PREVIEW_EXTENSIONS.has(extension)) return 'unknown'
  if (extension === 'bmp') return 'image'
  if (extension === 'html' || extension === 'svg') return 'text'
  const format = getPreviewFormat(extension)
  return format === 'unknown' ? 'text' : format
}

// Selects the reader encoding used for lightweight thumbnails in file lists.
export const getPreviewThumbnailReadEncoding = (format: PreviewFileFormat): 'utf8' | undefined => {
  // Binary document formats use dedicated full-byte readers and must not use truncated thumbnails.
  if (
    format === 'markdown' ||
    format === 'code' ||
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
