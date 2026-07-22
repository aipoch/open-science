import type {
  OfficePreviewErrorCode,
  OfficePreviewRuntimeStart,
  OfficePreviewRuntimeState
} from '../../../shared/office-preview'
import {
  isLegacyExcelFile,
  validateOfficePackage
} from '../pages/workspace/previews/office-package'
import { renderOfficeFile } from '../pages/workspace/previews/office-renderers'

type RunOfficePreviewOptions = {
  start: OfficePreviewRuntimeStart
  container: HTMLDivElement
  fetchFile: typeof fetch
  reportState: (state: OfficePreviewRuntimeState) => void
}

type OfficePreviewRuntimeCleanup = () => void | Promise<void>

class OfficePreviewRuntimeError extends Error {
  constructor(
    readonly code: OfficePreviewErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'OfficePreviewRuntimeError'
  }
}

const OFFICE_PREVIEW_ERROR_CODES = new Set<OfficePreviewErrorCode>([
  'FILE_TOO_LARGE',
  'UNSUPPORTED_FORMAT',
  'INVALID_PACKAGE',
  'RESOURCE_LIMIT_EXCEEDED',
  'FILE_READ_FAILED',
  'PREVIEW_TIMEOUT',
  'PREVIEW_PROCESS_CRASHED',
  'RENDER_FAILED'
])

const getOfficePreviewRuntimeErrorCode = (
  error: unknown,
  fallback: OfficePreviewErrorCode = 'RENDER_FAILED'
): OfficePreviewErrorCode => {
  if (error instanceof OfficePreviewRuntimeError) return error.code
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    OFFICE_PREVIEW_ERROR_CODES.has(error.code as OfficePreviewErrorCode)
  ) {
    return error.code as OfficePreviewErrorCode
  }
  return fallback
}

const asRuntimeError = (
  error: unknown,
  fallback: OfficePreviewErrorCode,
  message: string
): OfficePreviewRuntimeError => {
  if (error instanceof OfficePreviewRuntimeError) return error
  const cause = error instanceof Error ? error : undefined
  return new OfficePreviewRuntimeError(
    getOfficePreviewRuntimeErrorCode(error, fallback),
    cause?.message ?? message,
    cause ? { cause } : undefined
  )
}

const PARSING_TITLES = {
  docx: 'Parsing the Word document',
  xls: 'Parsing the Excel workbook',
  xlsx: 'Parsing the Excel workbook',
  pptx: 'Parsing the PowerPoint presentation'
} as const

const runOfficePreview = async (
  options: RunOfficePreviewOptions
): Promise<OfficePreviewRuntimeCleanup> => {
  const { start, container, fetchFile, reportState } = options
  const controller = new AbortController()
  let disposeRender: OfficePreviewRuntimeCleanup | undefined

  try {
    reportState({ sessionId: start.sessionId, phase: 'reading', title: 'Reading the Office file' })
    let bytes: Uint8Array
    try {
      const response = await fetchFile(start.resource.url, {
        cache: 'no-store',
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`Office preview read failed with status ${response.status}`)
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > start.resource.size) {
        throw new OfficePreviewRuntimeError(
          'RESOURCE_LIMIT_EXCEEDED',
          'Office preview response exceeded the admitted size'
        )
      }

      const buffer = await response.arrayBuffer()
      if (buffer.byteLength !== start.resource.size) {
        throw new Error('Office preview file changed during the read')
      }
      bytes = new Uint8Array(buffer)
    } catch (error) {
      throw asRuntimeError(error, 'FILE_READ_FAILED', 'Office preview file could not be read')
    }

    const extension =
      start.extension === 'spreadsheet'
        ? isLegacyExcelFile(bytes)
          ? 'xls'
          : 'xlsx'
        : start.extension

    reportState({
      sessionId: start.sessionId,
      phase: 'validating',
      title: 'Validating the Office package'
    })
    try {
      await validateOfficePackage(bytes, extension, controller.signal)
    } catch (error) {
      throw asRuntimeError(error, 'INVALID_PACKAGE', 'Office package validation failed')
    }

    reportState({
      sessionId: start.sessionId,
      phase: 'parsing',
      title: PARSING_TITLES[extension]
    })
    try {
      disposeRender = await renderOfficeFile({
        bytes,
        extension,
        name: start.name,
        container,
        scrollContainer: container,
        signal: controller.signal,
        onStatus: (status) =>
          reportState({
            sessionId: start.sessionId,
            phase: status.phase,
            title: status.title,
            description: status.description
          })
      })
    } catch (error) {
      if (
        extension === 'pptx' &&
        error instanceof Error &&
        error.message.includes('PPTX zip limit exceeded')
      ) {
        throw new OfficePreviewRuntimeError('RESOURCE_LIMIT_EXCEEDED', error.message, {
          cause: error
        })
      }
      throw asRuntimeError(error, 'RENDER_FAILED', 'Office preview rendering failed')
    }
    reportState({ sessionId: start.sessionId, phase: 'ready' })
  } catch (error) {
    controller.abort(error)
    throw error
  }

  return () => {
    controller.abort()
    return disposeRender?.()
  }
}

export { OfficePreviewRuntimeError, getOfficePreviewRuntimeErrorCode, runOfficePreview }
export type { OfficePreviewRuntimeCleanup, RunOfficePreviewOptions }
