// Pure helpers for turning an uploaded/referenced file into ACP prompt content. Kept free of fs/runtime
// deps so the size/type decisions and the oversized-file notice text are unit-testable. The runtime
// (runtime.ts) reads bytes and assembles the actual ContentBlock(s) around these decisions.

// Text-like files at or under this size are embedded in full; anything larger is sent as a link plus a
// bounded preview so a single big data file can never overflow the provider request. Lowered from 1 MB:
// even a sub-1 MB wide table bloats the replayed history, and a large read is the real overflow source.
export const MAX_EMBEDDED_TEXT_UPLOAD_BYTES = 512 * 1024

// How much of an oversized text file to show as a preview. Enough for a header plus many sample rows so
// the agent can plan targeted reads, while staying negligible against the request-size limit.
export const ATTACHMENT_PREVIEW_BYTES = 16 * 1024

// Clearly-text file extensions, including the common bioinformatics text formats, so a file whose MIME
// type is missing or generic is still classified correctly (the renderer does not always send a MIME).
const TEXT_LIKE_EXTENSIONS = new Set([
  'txt',
  'text',
  'log',
  'md',
  'markdown',
  'rst',
  'csv',
  'tsv',
  'tab',
  'psv',
  'json',
  'jsonl',
  'ndjson',
  'geojson',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'tex',
  'bib',
  'fasta',
  'fa',
  'faa',
  'fna',
  'fastq',
  'fq',
  'vcf',
  'bed',
  'bedgraph',
  'gff',
  'gff3',
  'gtf',
  'sam',
  'wig',
  'nwk',
  'newick',
  'phy',
  'aln',
  'sto',
  'clustal',
  'pdb',
  'sdf',
  'mol',
  'mol2',
  'smi',
  'smiles',
  'gb',
  'gbk',
  'genbank',
  'embl',
  'maf'
])

// Column-oriented formats, so the reading hint can name rows/columns rather than generic ranges.
const TABULAR_EXTENSIONS = new Set(['csv', 'tsv', 'tab', 'psv'])

// Lower-cased extension after the final dot, or '' when the name has none.
const fileExtension = (name: string): string => {
  const dot = name.lastIndexOf('.')

  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

// True when the file can be read as UTF-8 text — by MIME (text/*, JSON) or by a known text extension.
export const isTextLikeAttachment = (name: string, mimeType?: string): boolean => {
  if (mimeType?.startsWith('text/') || mimeType === 'application/json') return true
  if (mimeType === 'application/xml' || mimeType === 'application/x-ndjson') return true

  return TEXT_LIKE_EXTENSIONS.has(fileExtension(name))
}

// True when the file is column-oriented (drives the rows/columns wording in the oversized notice).
export const isTabularAttachment = (name: string, mimeType?: string): boolean => {
  if (mimeType === 'text/csv' || mimeType === 'text/tab-separated-values') return true

  return TABULAR_EXTENSIONS.has(fileExtension(name))
}

// Human-readable byte size for the notice (binary units, one decimal past KB).
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value.toFixed(1)} ${units[unit]}`
}

// Builds the text block that accompanies an oversized file's resource_link: it states why the file is
// not inlined, tells the agent to read only what it needs, and shows a bounded preview of the start.
export const buildOversizedAttachmentNotice = (input: {
  name: string
  size: number
  preview: string
  truncated: boolean
  tabular: boolean
}): string => {
  const { name, size, preview, truncated, tabular } = input
  const readHint = tabular
    ? 'the header row and only the specific rows or columns you need'
    : 'only the specific line ranges or sections you need'
  const trailer = truncated ? '\n\n… file continues beyond this preview.' : ''

  return [
    `[Attached file "${name}" (${formatBytes(size)}) is too large to include in full and is available on disk via the linked resource below.`,
    `Do not load the whole file — read ${readHint}. For analysis over the full file, compute in the notebook rather than reading it into the conversation.`,
    'Preview of the start of the file:',
    '',
    preview,
    trailer
  ].join('\n')
}
