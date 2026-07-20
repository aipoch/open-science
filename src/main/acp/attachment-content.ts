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

// Generic/opaque MIME values that carry no real format signal, so the extension is the better guide.
// (Browsers/OSes emit application/octet-stream for unrecognized types, including plain-text data files.)
const GENERIC_MIME_TYPES = new Set(['application/octet-stream', 'binary/octet-stream'])

// The lower-cased MIME essence (type/subtype) with any parameters and casing stripped, or undefined when
// none was given. A real MIME arrives as `Text/CSV` or `application/json; charset=utf-8`, so every
// comparison must run against this — not the raw string — or a valid text MIME reads as a concrete binary.
const mimeEssence = (mimeType?: string): string | undefined => {
  const essence = mimeType?.split(';', 1)[0]?.trim().toLowerCase()

  return essence ? essence : undefined
}

// True when the MIME essence names a text-bearing format directly. Covers text/*, JSON/XML and their
// structured suffixes (RFC 6839 `+json`/`+xml`, e.g. application/geo+json, application/atom+xml), and the
// `chemical/*` family, which the scientific formats we handle (PDB, MDL/SDF, MOL, SMILES) are all text.
const isTextBearingMime = (essence: string): boolean =>
  essence.startsWith('text/') ||
  essence.startsWith('chemical/') ||
  essence.endsWith('+json') ||
  essence.endsWith('+xml') ||
  essence === 'application/json' ||
  essence === 'application/xml' ||
  essence === 'application/x-ndjson'

// True when the file can be read as UTF-8 text. A text-bearing MIME wins; an explicit *non-text*,
// non-generic MIME (e.g. application/gzip, image/png) loses outright so a gzipped `.fastq` is never
// treated as text. Only a missing or generic MIME defers to the known-text extension list.
export const isTextLikeAttachment = (name: string, mimeType?: string): boolean => {
  const essence = mimeEssence(mimeType)

  if (essence && isTextBearingMime(essence)) return true

  // A concrete non-text MIME is authoritative — do not second-guess it from the extension.
  if (essence && !GENERIC_MIME_TYPES.has(essence)) return false

  return TEXT_LIKE_EXTENSIONS.has(fileExtension(name))
}

// True when the file is column-oriented (drives the rows/columns wording in the oversized notice).
export const isTabularAttachment = (name: string, mimeType?: string): boolean => {
  const essence = mimeEssence(mimeType)

  if (essence === 'text/csv' || essence === 'text/tab-separated-values') return true

  return TABULAR_EXTENSIONS.has(fileExtension(name))
}

// Raster image extensions that vision-capable agents can read as pixels, mapped to the MIME type to
// inline them as. SVG is deliberately absent: it is vector/text, not a raster type the providers accept
// as image content. Matches the accepted set in ACP_MESSAGE_IMAGE_MIME_TYPES.
const IMAGE_EXTENSION_MIME = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif']
])

// The image MIME type to inline a file as, or undefined when it is not a supported raster image. A
// concrete image/* MIME wins; a missing or generic MIME (browsers omit it for some drag/drop and paste
// sources) falls back to the file extension — so a `.png` upload is still sent as pixels rather than a
// bare file link the model can only reach by writing code. A concrete non-image MIME is authoritative.
export const imageAttachmentMimeType = (name: string, mimeType?: string): string | undefined => {
  const essence = mimeEssence(mimeType)

  if (essence && essence.startsWith('image/')) {
    return essence === 'image/svg+xml' ? undefined : essence
  }

  if (essence && !GENERIC_MIME_TYPES.has(essence)) return undefined

  return IMAGE_EXTENSION_MIME.get(fileExtension(name))
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
