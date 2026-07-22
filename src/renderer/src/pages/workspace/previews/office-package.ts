import { SaxesParser } from 'saxes'

import { OFFICE_PREVIEW_MAX_FILE_BYTES } from '../../../../../shared/office-preview'

export type OfficeFileExtension = 'docx' | 'xls' | 'xlsx' | 'pptx'
export type OfficePackageValidationErrorCode = 'INVALID_PACKAGE' | 'RESOURCE_LIMIT_EXCEEDED'

export class OfficePackageValidationError extends Error {
  constructor(
    readonly code: OfficePackageValidationErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'OfficePackageValidationError'
  }
}

export const OFFICE_PREVIEW_MAX_COMPRESSED_BYTES = OFFICE_PREVIEW_MAX_FILE_BYTES
export const DOCX_PREVIEW_MAX_COMPRESSED_BYTES = OFFICE_PREVIEW_MAX_FILE_BYTES

// Bound both ZIP metadata and actual decompression work before any third-party renderer sees input.
const MAX_ZIP_ENTRIES = 4000
const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024
const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_DOCX_TOTAL_BYTES = 128 * 1024 * 1024
const MAX_XLSX_TOTAL_BYTES = 128 * 1024 * 1024
const MAX_PPTX_MEDIA_BYTES = 192 * 1024 * 1024
const MAX_RELATIONSHIPS_XML_BYTES = 4 * 1024 * 1024
const MAX_RELATIONSHIPS = 20_000
const MAX_DOCX_DOCUMENT_XML_BYTES = 8 * 1024 * 1024
const MAX_DOCX_DOCUMENT_ELEMENTS = 100_000
const MAX_DOCX_DOCUMENT_DEPTH = 128
const XML_PARSE_CHUNK_BYTES = 64 * 1024
const MAX_EOCD_TRAILING_WHITESPACE_BYTES = 16
const MAX_EOCD_SEARCH_BYTES = 65_557 + MAX_EOCD_TRAILING_WHITESPACE_BYTES

// Large worksheet XML is permitted under the total budget; every other OOXML part stays at 32 MiB.
const getMaxZipEntryBytes = (extension: OfficeFileExtension, entryName: string): number =>
  extension === 'xlsx' && entryName.toLowerCase().startsWith('xl/worksheets/')
    ? MAX_ZIP_TOTAL_BYTES
    : MAX_ZIP_ENTRY_BYTES

// Declared and measured expansion checks share one format budget so oversized spreadsheets are
// rejected from ZIP metadata before the in-memory workbook parser starts.
const getMaxZipTotalBytes = (extension: Exclude<OfficeFileExtension, 'xls'>): number => {
  if (extension === 'docx') return MAX_DOCX_TOTAL_BYTES
  if (extension === 'xlsx') return MAX_XLSX_TOTAL_BYTES
  return MAX_ZIP_TOTAL_BYTES
}
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50
const LOCAL_ENTRY_SIGNATURE = 0x04034b50
const UNICODE_PATH_EXTRA_FIELD_ID = 0x7075
const OOXML_EXTERNAL_HYPERLINK_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink'
])

type OoxmlPackageEntry = {
  name: string
  compressedSize: number
  compressionMethod: number
  dataStart: number
  declaredUncompressedSize: number
}

type OoxmlPackageIndex = {
  entries: OoxmlPackageEntry[]
  names: Set<string>
}

const XLS_COMPOUND_FILE_SIGNATURE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

const OOXML_MARKERS: Record<Exclude<OfficeFileExtension, 'xls'>, readonly string[]> = {
  docx: ['[Content_Types].xml', 'word/document.xml'],
  xlsx: ['[Content_Types].xml', 'xl/workbook.xml'],
  pptx: ['[Content_Types].xml', 'ppt/presentation.xml']
}

const hasPrefix = (bytes: Uint8Array, prefix: Uint8Array): boolean =>
  bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte)

// Legacy XLS files use the OLE Compound File signature instead of the ZIP-based OOXML container.
export const isLegacyExcelFile = (bytes: Uint8Array): boolean =>
  bytes.length >= 512 && hasPrefix(bytes, XLS_COMPOUND_FILE_SIGNATURE)

const invalidPackage = (
  message = 'This Office file is damaged or unsupported'
): OfficePackageValidationError => new OfficePackageValidationError('INVALID_PACKAGE', message)

const resourceLimit = (message: string): OfficePackageValidationError =>
  new OfficePackageValidationError('RESOURCE_LIMIT_EXCEEDED', message)

// Walks ZIP extra fields as length-delimited records and rejects truncated metadata while scanning.
const hasExtraField = (
  view: DataView,
  start: number,
  length: number,
  expectedId: number
): boolean => {
  const end = start + length
  let offset = start

  while (offset < end) {
    if (offset + 4 > end) throw invalidPackage()

    const id = view.getUint16(offset, true)
    const fieldLength = view.getUint16(offset + 2, true)
    offset += 4
    if (offset + fieldLength > end) throw invalidPackage()
    if (id === expectedId) return true
    offset += fieldLength
  }

  return false
}

// Compares raw names so the validator and downstream ZIP library cannot resolve different entries.
const byteRangesEqual = (
  bytes: Uint8Array,
  leftStart: number,
  rightStart: number,
  length: number
): boolean => {
  for (let index = 0; index < length; index += 1) {
    if (bytes[leftStart + index] !== bytes[rightStart + index]) return false
  }

  return true
}

// Locates the terminal EOCD record while accounting for the maximum legal ZIP comment length.
const findEndOfCentralDirectory = (view: DataView): number => {
  const firstOffset = Math.max(0, view.byteLength - MAX_EOCD_SEARCH_BYTES)

  for (let offset = view.byteLength - 22; offset >= firstOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue

    const commentLength = view.getUint16(offset + 20, true)
    const endOffset = offset + 22 + commentLength
    const trailingBytes = view.byteLength - endOffset
    if (trailingBytes < 0 || trailingBytes > MAX_EOCD_TRAILING_WHITESPACE_BYTES) continue

    let hasOnlyWhitespace = true
    for (let trailingOffset = endOffset; trailingOffset < view.byteLength; trailingOffset += 1) {
      const byte = view.getUint8(trailingOffset)
      if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) {
        hasOnlyWhitespace = false
        break
      }
    }
    if (hasOnlyWhitespace) return offset
  }

  throw invalidPackage()
}

// Builds a bounded OOXML index from ZIP metadata before any entry is decompressed. Local and central
// names must agree, and Unicode Path overrides are rejected to prevent parser name confusion.
const inspectOoxmlPackage = (
  bytes: Uint8Array,
  extension: Exclude<OfficeFileExtension, 'xls'>
): OoxmlPackageIndex => {
  if (bytes.length < 22) throw invalidPackage()

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocdOffset = findEndOfCentralDirectory(view)
  const diskNumber = view.getUint16(eocdOffset + 4, true)
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true)
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true)
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true)
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)

  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw invalidPackage('ZIP64 Office packages are not supported for preview')
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw resourceLimit('This Office package has too many entries to preview safely')
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw invalidPackage('Multi-disk Office packages are not supported for preview')
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize
  if (centralDirectoryEnd > eocdOffset || centralDirectoryOffset > bytes.length) {
    throw invalidPackage()
  }

  const decoder = new TextDecoder()
  const entries: OoxmlPackageEntry[] = []
  const names = new Set<string>()
  const maxTotalBytes = getMaxZipTotalBytes(extension)
  let offset = centralDirectoryOffset
  let totalUncompressedBytes = 0
  let totalPptxMediaBytes = 0

  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > centralDirectoryEnd ||
      view.getUint32(offset, true) !== CENTRAL_ENTRY_SIGNATURE
    ) {
      throw invalidPackage()
    }

    const flags = view.getUint16(offset + 8, true)
    const compressionMethod = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localEntryOffset = view.getUint32(offset + 42, true)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    const centralNameStart = offset + 46

    if ((flags & 0x0001) !== 0) {
      throw invalidPackage('Encrypted Office packages cannot be previewed')
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localEntryOffset === 0xffffffff
    ) {
      throw invalidPackage('ZIP64 Office packages are not supported for preview')
    }
    if (nextOffset > centralDirectoryEnd) throw invalidPackage()
    const name = decoder.decode(bytes.subarray(centralNameStart, centralNameStart + nameLength))
    const maxEntryBytes = getMaxZipEntryBytes(extension, name)
    if (uncompressedSize > maxEntryBytes) {
      throw resourceLimit('An Office package entry is too large to preview safely')
    }

    totalUncompressedBytes += uncompressedSize
    if (totalUncompressedBytes > maxTotalBytes) {
      throw resourceLimit('This Office package expands too large to preview safely')
    }
    if (
      localEntryOffset + 30 > centralDirectoryOffset ||
      view.getUint32(localEntryOffset, true) !== LOCAL_ENTRY_SIGNATURE
    ) {
      throw invalidPackage()
    }

    const localFlags = view.getUint16(localEntryOffset + 6, true)
    const localCompressionMethod = view.getUint16(localEntryOffset + 8, true)
    const localNameLength = view.getUint16(localEntryOffset + 26, true)
    const localExtraLength = view.getUint16(localEntryOffset + 28, true)
    const centralExtraStart = centralNameStart + nameLength
    const localNameStart = localEntryOffset + 30
    const localExtraStart = localNameStart + localNameLength
    const dataStart = localEntryOffset + 30 + localNameLength + localExtraLength

    // Reject any metadata combination that could make a ZIP library read a different named entry.
    if (
      (localFlags & 0x0001) !== 0 ||
      localCompressionMethod !== compressionMethod ||
      localNameLength !== nameLength ||
      dataStart + compressedSize > centralDirectoryOffset ||
      !byteRangesEqual(bytes, centralNameStart, localNameStart, nameLength) ||
      hasExtraField(view, centralExtraStart, extraLength, UNICODE_PATH_EXTRA_FIELD_ID) ||
      hasExtraField(view, localExtraStart, localExtraLength, UNICODE_PATH_EXTRA_FIELD_ID)
    ) {
      throw invalidPackage()
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw invalidPackage('This Office package uses an unsupported compression method')
    }

    if (extension === 'pptx' && name.toLowerCase().startsWith('ppt/media/')) {
      totalPptxMediaBytes += uncompressedSize
      if (totalPptxMediaBytes > MAX_PPTX_MEDIA_BYTES) {
        throw resourceLimit(
          'This PowerPoint presentation contains too much media to preview safely'
        )
      }
    }
    names.add(name)
    entries.push({
      name,
      compressedSize,
      compressionMethod,
      dataStart,
      declaredUncompressedSize: uncompressedSize
    })
    offset = nextOffset
  }

  if (offset !== centralDirectoryEnd) throw invalidPackage()

  return { entries, names }
}

// Converts cooperative cancellation into the same exception path used by asynchronous validation.
const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return
  throw signal.reason ?? new DOMException('Office preview aborted', 'AbortError')
}

const hasEntryExtension = (entryName: string, extension: string): boolean =>
  entryName.toLowerCase().endsWith(extension)

type InflatedEntry = {
  data?: Uint8Array
  size: number
}

type EntryCapture = {
  maxBytes: number
  tooLargeError: () => Error
}

// Streams one entry to count real output bytes, stopping ZIP bombs even when metadata understates
// expansion. Only entries needed for XML security checks are retained in memory.
const measureInflatedEntry = async (
  bytes: Uint8Array,
  entry: OoxmlPackageEntry,
  totalBeforeEntry: number,
  maxTotalBytes: number,
  maxEntryBytes: number,
  capture: EntryCapture | undefined,
  signal?: AbortSignal
): Promise<InflatedEntry> => {
  throwIfAborted(signal)

  if (entry.compressionMethod === 0) {
    if (entry.compressedSize > maxEntryBytes) {
      throw resourceLimit('An Office package entry is too large to preview safely')
    }
    if (totalBeforeEntry + entry.compressedSize > maxTotalBytes) {
      throw resourceLimit('This Office package expands too large to preview safely')
    }
    if (capture && entry.compressedSize > capture.maxBytes) throw capture.tooLargeError()

    return {
      size: entry.compressedSize,
      data: capture
        ? Uint8Array.from(bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize))
        : undefined
    }
  }

  // DecompressionStream exposes incremental output so limits are checked before full allocation.
  const compressed = Uint8Array.from(
    bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize)
  )
  const stream = new Blob([compressed.buffer])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let inflatedSize = 0

  try {
    while (true) {
      throwIfAborted(signal)
      const { done, value } = await reader.read()
      if (done) break

      inflatedSize += value.byteLength
      if (inflatedSize > maxEntryBytes) {
        await reader.cancel()
        throw resourceLimit('An Office package entry is too large to preview safely')
      }
      if (totalBeforeEntry + inflatedSize > maxTotalBytes) {
        await reader.cancel()
        throw resourceLimit('This Office package expands too large to preview safely')
      }
      if (capture && inflatedSize > capture.maxBytes) {
        await reader.cancel()
        throw capture.tooLargeError()
      }
      if (capture) chunks.push(Uint8Array.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  if (!capture) return { size: inflatedSize }

  const data = new Uint8Array(inflatedSize)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }

  return { data, size: inflatedSize }
}

// Parses UTF-8 XML incrementally, rejects DTDs, and lets callers attach narrowly scoped SAX checks.
const parsePackageXml = (
  data: Uint8Array,
  configure: (parser: SaxesParser<{ xmlns: true }>) => void
): void => {
  const parser = new SaxesParser({ xmlns: true })
  const decoder = new TextDecoder('utf-8', { fatal: true })

  parser.on('error', () => {
    throw invalidPackage()
  })
  parser.on('doctype', () => {
    throw invalidPackage()
  })
  configure(parser)

  for (let offset = 0; offset < data.byteLength; offset += XML_PARSE_CHUNK_BYTES) {
    let text: string
    try {
      text = decoder.decode(data.subarray(offset, offset + XML_PARSE_CHUNK_BYTES), {
        stream: true
      })
    } catch {
      throw invalidPackage()
    }
    parser.write(text)
  }

  try {
    parser.write(decoder.decode()).close()
  } catch (error) {
    if (error instanceof OfficePackageValidationError) throw error
    throw invalidPackage()
  }
}

// Allows inert OOXML hyperlinks while blocking relationships that could fetch external resources.
const assertNoExternalResources = (data: Uint8Array): void => {
  if (data.byteLength > MAX_RELATIONSHIPS_XML_BYTES) {
    throw resourceLimit('This Office relationship file is too large to preview safely')
  }

  let relationshipCount = 0
  parsePackageXml(data, (parser) => {
    parser.on('opentag', (tag) => {
      if (tag.local !== 'Relationship') return

      relationshipCount += 1
      if (relationshipCount > MAX_RELATIONSHIPS) {
        throw resourceLimit('This Office package has too many relationships to preview safely')
      }

      const targetMode = Object.values(tag.attributes)
        .find((attribute) => attribute.local === 'TargetMode' && attribute.prefix === '')
        ?.value.trim()
        .toLowerCase()
      if (targetMode === 'external') {
        const relationshipType = Object.values(tag.attributes)
          .find((attribute) => attribute.local === 'Type' && attribute.prefix === '')
          ?.value.trim()
        if (relationshipType && OOXML_EXTERNAL_HYPERLINK_TYPES.has(relationshipType)) {
          return
        }
        throw invalidPackage('Office files with external resources cannot be previewed')
      }
    })
  })
}

// Caps every DOCX XML part before docx-preview converts attacker-controlled trees into browser DOM.
const assertDocxXmlComplexity = (data: Uint8Array): void => {
  if (data.byteLength > MAX_DOCX_DOCUMENT_XML_BYTES) {
    throw resourceLimit('This Word document is too complex to preview safely')
  }

  let depth = 0
  let elementCount = 0
  parsePackageXml(data, (parser) => {
    parser.on('opentag', () => {
      depth += 1
      elementCount += 1
      if (elementCount > MAX_DOCX_DOCUMENT_ELEMENTS || depth > MAX_DOCX_DOCUMENT_DEPTH) {
        throw resourceLimit('This Word document is too complex to preview safely')
      }
    })
    parser.on('closetag', () => {
      depth -= 1
    })
  })
}

// Verifies declared sizes against streamed output and captures only relationship/DOCX XML entries
// for the additional SAX security checks.
const verifyActualInflatedSizes = async (
  bytes: Uint8Array,
  entries: OoxmlPackageEntry[],
  maxTotalBytes: number,
  extension: OfficeFileExtension,
  signal?: AbortSignal
): Promise<void> => {
  let totalInflatedBytes = 0
  let totalPptxMediaBytes = 0

  for (const entry of entries) {
    const capture = hasEntryExtension(entry.name, '.rels')
      ? {
          maxBytes: MAX_RELATIONSHIPS_XML_BYTES,
          tooLargeError: () =>
            resourceLimit('This Office relationship file is too large to preview safely')
        }
      : extension === 'docx' && hasEntryExtension(entry.name, '.xml')
        ? {
            maxBytes: MAX_DOCX_DOCUMENT_XML_BYTES,
            tooLargeError: () =>
              resourceLimit('This Word document is too complex to preview safely')
          }
        : undefined
    const maxEntryBytes = getMaxZipEntryBytes(extension, entry.name)
    const inflated = await measureInflatedEntry(
      bytes,
      entry,
      totalInflatedBytes,
      maxTotalBytes,
      maxEntryBytes,
      capture,
      signal
    )
    if (inflated.size !== entry.declaredUncompressedSize) throw invalidPackage()
    if (extension === 'pptx' && entry.name.toLowerCase().startsWith('ppt/media/')) {
      totalPptxMediaBytes += inflated.size
      if (totalPptxMediaBytes > MAX_PPTX_MEDIA_BYTES) {
        throw resourceLimit(
          'This PowerPoint presentation contains too much media to preview safely'
        )
      }
    }

    if (inflated.data && hasEntryExtension(entry.name, '.rels')) {
      assertNoExternalResources(inflated.data)
    }
    if (inflated.data && extension === 'docx' && hasEntryExtension(entry.name, '.xml')) {
      assertDocxXmlComplexity(inflated.data)
    }

    totalInflatedBytes += inflated.size
  }
}

// Performs format, resource, relationship, and XML-complexity preflight before renderer dispatch.
export const validateOfficePackage = async (
  bytes: Uint8Array,
  extension: OfficeFileExtension,
  signal?: AbortSignal
): Promise<void> => {
  throwIfAborted(signal)

  if (bytes.length > OFFICE_PREVIEW_MAX_COMPRESSED_BYTES) {
    throw resourceLimit('This Office file is too large to preview safely')
  }
  if (extension === 'docx' && bytes.length > DOCX_PREVIEW_MAX_COMPRESSED_BYTES) {
    throw resourceLimit('This Word file is too large to preview safely')
  }

  if (extension === 'xls') {
    if (!isLegacyExcelFile(bytes)) {
      throw invalidPackage("This isn't a valid legacy Excel file")
    }
    return
  }

  const { entries, names } = inspectOoxmlPackage(bytes, extension)
  const hasExpectedMarkers = OOXML_MARKERS[extension].every((name) => names.has(name))

  if (!hasExpectedMarkers) {
    throw invalidPackage(`This isn't a valid ${extension.toUpperCase()} package`)
  }

  await verifyActualInflatedSizes(bytes, entries, getMaxZipTotalBytes(extension), extension, signal)
}
