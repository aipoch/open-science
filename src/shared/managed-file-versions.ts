const MANAGED_TEXT_EDIT_MAX_BYTES = 2 * 1024 * 1024
const MANAGED_DIFF_MAX_INPUT_BYTES = 2 * 1024 * 1024
const MANAGED_DIFF_MAX_OUTPUT_LINES = 20_000
const MANAGED_DIFF_MAX_OUTPUT_BYTES = 500 * 1024
const MANAGED_VERSION_STORAGE_TAG_PATTERN = /^v[a-z0-9]{8}$/
const MAX_PORTABLE_FILENAME_COMPONENT_BYTES = 255
const MANAGED_VERSION_FILENAME_PREFIX_BYTES = 10
const MAX_MANAGED_FILE_BASENAME_BYTES =
  MAX_PORTABLE_FILENAME_COMPONENT_BYTES - MANAGED_VERSION_FILENAME_PREFIX_BYTES
const WINDOWS_INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*]/u
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

const MANAGED_TEXT_EDIT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'xml',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'r',
  'sql',
  'css',
  'sh',
  'bash',
  'zsh'
])

type ManagedFileSource = 'artifact' | 'upload'

type ManagedFileIdentity = {
  source: ManagedFileSource
  projectId: string
  fileId: string
}

type ManagedFileVersionOriginKind = 'agent_generated' | 'user_upload' | 'user_edit' | 'legacy'

type ManagedFileVersionDescriptor = {
  id: string
  source: ManagedFileSource
  fileId: string
  versionNumber: number
  displayName: string
  originKind: ManagedFileVersionOriginKind
  basedOnVersionId: string | null
  contentType: string | null
  sizeBytes: number
  checksum: string
  createdAt: string
}

type ManagedFileVersionInspectResult = {
  source: ManagedFileSource
  projectId: string
  fileId: string
  sessionId: string
  displayName: string
  headVersionId: string
  selectedVersionId: string
  versions: ManagedFileVersionDescriptor[]
  nextCursor?: string
  selectedVersion?: ManagedFileVersionDescriptor
  headVersion?: ManagedFileVersionDescriptor
  previousVersion?: ManagedFileVersionDescriptor
  nextVersion?: ManagedFileVersionDescriptor
  canEdit: boolean
  canDiff: boolean
  unavailableReason?: ManagedTextEditUnavailableReason | 'PROJECT_NOT_WRITABLE' | 'FILE_DELETED'
  text?: string
  textFormat?: ManagedTextFormat
}

type ManagedFileVersionErrorCode =
  | ManagedTextEditUnavailableReason
  | 'VERSION_NOT_FOUND'
  | 'VERSION_NOT_IN_FILE'
  | 'FILE_DELETED'
  | 'FILE_NOT_FOUND'
  | 'PROJECT_NOT_WRITABLE'
  | 'CONTENT_INTEGRITY_FAILED'
  | 'STORAGE_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'OUT_OF_SPACE'
  | 'INTEGRITY_FAILED'
  | 'VERSION_CONFLICT'
  | 'INVALID_REQUEST'
  | 'OPERATION_REUSED'
  | 'STORAGE_COLLISION'
  | 'DIFF_BASE_NOT_FOUND'
  | 'DIFF_INPUT_LIMIT_EXCEEDED'
  | 'DIFF_OUTPUT_LIMIT_EXCEEDED'
  | 'DIFF_CONCURRENCY_LIMIT'
  | 'DIFF_CANCELLED'
  | 'DIFF_TIMEOUT'

type ManagedFileVersionErrorShape = {
  code: ManagedFileVersionErrorCode
  message: string
}

type ManagedFileVersionIpcResult<Value> =
  { ok: true; value: Value } | { ok: false; error: ManagedFileVersionErrorShape }

type ManagedFileVersionInspectRequest = ManagedFileIdentity & {
  versionId?: string
  cursor?: string
}
type ManagedFileVersionDiffRequest = ManagedFileIdentity & { versionId: string; requestId: string }
type ManagedFileVersionCancelDiffRequest = { requestId: string }

type ManagedFileVersionDiffSegment = {
  kind: 'context' | 'added' | 'removed'
  text: string
}

type ManagedFileVersionDiffLine = {
  kind: 'context' | 'added' | 'removed'
  oldLineNumber?: number
  newLineNumber?: number
  segments: ManagedFileVersionDiffSegment[]
}

type ManagedFileVersionDiffResult = {
  baseVersionId: string
  selectedVersionId: string
  lines: ManagedFileVersionDiffLine[]
}

type ManagedFileVersionSaveTextEditRequest = ManagedFileIdentity & {
  basedOnVersionId: string
  expectedHeadVersionId: string
  content: string
  operationId: string
}

type SaveTextEditResult =
  | {
      kind: 'created'
      version: ManagedFileVersionDescriptor
      headVersionId: string
      replayed: boolean
    }
  | { kind: 'noop'; version: ManagedFileVersionDescriptor; headVersionId: string }
  | {
      kind: 'conflict'
      expectedHeadVersionId: string
      actualHead: ManagedFileVersionDescriptor
    }

type ManagedTextFormat = {
  hasUtf8Bom: boolean
  newline: 'lf' | 'crlf'
  hasTrailingNewline: boolean
}

type ManagedTextEditUnavailableReason =
  | 'NOT_EDITABLE_EXTENSION'
  | 'UNSAFE_FILENAME'
  | 'INVALID_UTF8'
  | 'CONTAINS_NUL'
  | 'EDIT_LIMIT_EXCEEDED'

type ManagedTextEditEligibility =
  | {
      editable: true
      byteLength: number
      text: string
      format: ManagedTextFormat
    }
  | { editable: false; reason: ManagedTextEditUnavailableReason }

const extensionOf = (filename: string): string | undefined => {
  const index = filename.lastIndexOf('.')
  if (index <= 0 || index === filename.length - 1) return undefined
  return filename.slice(index + 1).toLowerCase()
}

const inspectManagedTextEditEligibility = (
  filename: string,
  bytes: Uint8Array
): ManagedTextEditEligibility => {
  const extension = extensionOf(filename)
  if (!extension || !MANAGED_TEXT_EDIT_EXTENSIONS.has(extension)) {
    return { editable: false, reason: 'NOT_EDITABLE_EXTENSION' }
  }
  if (!isSafeManagedFileBasename(filename)) {
    return { editable: false, reason: 'UNSAFE_FILENAME' }
  }
  if (bytes.byteLength > MANAGED_TEXT_EDIT_MAX_BYTES) {
    return { editable: false, reason: 'EDIT_LIMIT_EXCEEDED' }
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { editable: false, reason: 'INVALID_UTF8' }
  }
  if (text.includes('\0')) return { editable: false, reason: 'CONTAINS_NUL' }

  const crlfCount = text.match(/\r\n/g)?.length ?? 0
  const lfCount = text.match(/(?<!\r)\n/g)?.length ?? 0
  return {
    editable: true,
    byteLength: bytes.byteLength,
    text,
    format: {
      hasUtf8Bom:
        bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      newline: crlfCount > lfCount ? 'crlf' : 'lf',
      hasTrailingNewline: /(?:\r\n|\n)$/.test(text)
    }
  }
}

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })

const isSafeManagedFileBasename = (filename: string): boolean =>
  filename.length > 0 &&
  filename !== '.' &&
  filename !== '..' &&
  !WINDOWS_INVALID_FILENAME_CHARACTERS.test(filename) &&
  !hasControlCharacter(filename) &&
  !WINDOWS_RESERVED_BASENAME.test(filename) &&
  !/[. ]$/u.test(filename) &&
  utf8ByteLength(filename) <= MAX_MANAGED_FILE_BASENAME_BYTES

const buildManagedVersionStoredFilename = (filename: string, storageTag: string): string => {
  if (!MANAGED_VERSION_STORAGE_TAG_PATTERN.test(storageTag)) {
    throw new Error('Managed version storage tag must match v[a-z0-9]{8}.')
  }
  if (!isSafeManagedFileBasename(filename)) {
    throw new Error('Managed version display name must be a safe basename.')
  }
  return `${storageTag}_${filename}`
}

export {
  MANAGED_DIFF_MAX_INPUT_BYTES,
  MANAGED_DIFF_MAX_OUTPUT_BYTES,
  MANAGED_DIFF_MAX_OUTPUT_LINES,
  MANAGED_TEXT_EDIT_EXTENSIONS,
  MANAGED_TEXT_EDIT_MAX_BYTES,
  MANAGED_VERSION_STORAGE_TAG_PATTERN,
  buildManagedVersionStoredFilename,
  inspectManagedTextEditEligibility,
  isSafeManagedFileBasename,
  type ManagedFileIdentity,
  type ManagedFileSource,
  type ManagedFileVersionDescriptor,
  type ManagedFileVersionErrorCode,
  type ManagedFileVersionErrorShape,
  type ManagedFileVersionInspectResult,
  type ManagedFileVersionIpcResult,
  type ManagedFileVersionDiffRequest,
  type ManagedFileVersionCancelDiffRequest,
  type ManagedFileVersionDiffLine,
  type ManagedFileVersionDiffResult,
  type ManagedFileVersionDiffSegment,
  type ManagedFileVersionInspectRequest,
  type ManagedFileVersionOriginKind,
  type ManagedFileVersionSaveTextEditRequest,
  type ManagedTextEditEligibility,
  type ManagedTextEditUnavailableReason,
  type ManagedTextFormat,
  type SaveTextEditResult
}
