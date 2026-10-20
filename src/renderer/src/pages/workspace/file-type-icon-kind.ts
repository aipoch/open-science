import { getFileExtension, getPreviewFormatForFile } from './preview-support'

export type FileIconKind =
  | 'archive'
  | 'code'
  | 'config'
  | 'data'
  | 'document'
  | 'image'
  | 'molecule'
  | 'notebook'
  | 'pdf'
  | 'python'
  | 'presentation'
  | 'r'
  | 'sequence'
  | 'spreadsheet'
  | 'text'
  | 'unknown'
  | 'vector'

const ARCHIVE_EXTENSIONS = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'zip'])
const CODE_EXTENSIONS = new Set([
  'bash',
  'c',
  'cc',
  'cpp',
  'css',
  'fasta',
  'faa',
  'fa',
  'ffn',
  'fna',
  'frn',
  'go',
  'h',
  'hpp',
  'html',
  'java',
  'js',
  'jsx',
  'kt',
  'mjs',
  'pdb',
  'py',
  'r',
  'rb',
  'rs',
  'sh',
  'sdf',
  'smi',
  'smiles',
  'sql',
  'swift',
  'tex',
  'ts',
  'tsx',
  'xml',
  'rxn',
  'mol',
  'bib',
  'bibtex'
])
const IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'tif', 'tiff', 'webp'])
const MOLECULE_EXTENSIONS = new Set(['mol', 'pdb', 'rxn', 'sdf', 'smi', 'smiles'])
const PYTHON_EXTENSIONS = new Set(['py', 'pyw'])
const R_EXTENSIONS = new Set(['r', 'rmd'])
const SEQUENCE_EXTENSIONS = new Set(['fa', 'faa', 'fasta', 'ffn', 'fna', 'frn'])
const TEXT_EXTENSIONS = new Set([
  'iqtree',
  'log',
  'markdown',
  'md',
  'nwk',
  'state',
  'toml',
  'tree',
  'treefile',
  'txt',
  'yaml',
  'yml'
])
const CONFIG_EXTENSIONS = new Set(['conf', 'config', 'ini', 'toml', 'yaml', 'yml'])

const MIME_KIND: Record<string, FileIconKind> = {
  'application/pdf': 'pdf',
  'application/zip': 'archive',
  'application/x-7z-compressed': 'archive',
  'application/x-bzip2': 'archive',
  'application/x-gzip': 'archive',
  'application/x-rar-compressed': 'archive',
  'application/x-tar': 'archive',
  'application/vnd.ms-excel': 'spreadsheet',
  'application/vnd.ms-powerpoint': 'presentation',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'presentation'
}

const normalizeMimeType = (mimeType?: string): string =>
  mimeType?.toLowerCase().split(';')[0]?.trim() ?? ''

export const getFileIconKind = (name: string, mimeType?: string): FileIconKind => {
  const extension = getFileExtension(name)
  const normalizedMimeType = normalizeMimeType(mimeType)
  const previewFormat = getPreviewFormatForFile({ name, mimeType })

  if (extension) {
    if (extension === 'svg') return 'vector'
    if (IMAGE_EXTENSIONS.has(extension)) return 'image'
    if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive'
    if (extension === 'pdf') return 'pdf'
    if (extension === 'doc' || extension === 'docx') return 'document'
    if (['csv', 'tsv', 'xls', 'xlsx'].includes(extension)) return 'spreadsheet'
    if (['ppt', 'pptx'].includes(extension)) return 'presentation'
    if (extension === 'ipynb') return 'notebook'
    if (CONFIG_EXTENSIONS.has(extension)) return 'config'
    if (previewFormat === 'json') return 'data'
    if (['molecule', 'pdb'].includes(previewFormat) || MOLECULE_EXTENSIONS.has(extension)) {
      return 'molecule'
    }
    if (previewFormat === 'fasta' || SEQUENCE_EXTENSIONS.has(extension)) return 'sequence'
    if (PYTHON_EXTENSIONS.has(extension)) return 'python'
    if (R_EXTENSIONS.has(extension)) return 'r'
    if (['code', 'fasta', 'html', 'molecule', 'pdb'].includes(previewFormat)) return 'code'
    if (CODE_EXTENSIONS.has(extension)) return 'code'
    if (['markdown', 'text'].includes(previewFormat)) return 'text'
    if (TEXT_EXTENSIONS.has(extension)) return 'text'
  }

  if (normalizedMimeType === 'image/svg+xml') return 'vector'
  if (normalizedMimeType.startsWith('image/')) return 'image'
  if (normalizedMimeType === 'application/x-ipynb+json') return 'notebook'
  if (Object.hasOwn(MIME_KIND, normalizedMimeType)) return MIME_KIND[normalizedMimeType]
  if (previewFormat === 'json') return 'data'
  if (['molecule', 'pdb'].includes(previewFormat)) return 'molecule'
  if (previewFormat === 'fasta') return 'sequence'
  if (['code', 'html'].includes(previewFormat)) return 'code'
  if (['csv', 'spreadsheet'].includes(previewFormat)) return 'spreadsheet'
  if (previewFormat === 'presentation') return 'presentation'
  if (previewFormat === 'word') return 'document'
  if (previewFormat === 'pdf') return 'pdf'
  if (['markdown', 'text'].includes(previewFormat) || normalizedMimeType.startsWith('text/')) {
    return 'text'
  }

  return 'unknown'
}
