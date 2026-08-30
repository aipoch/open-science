import '../assets/main.css'
import './reviewer-paged-preview.css'

import type { ManagedPreviewResource } from '../../../shared/preview-resources'
import {
  renderTargetedOfficeFile,
  type TargetedOfficeRenderSession
} from '../pages/workspace/previews/office-renderers'

type ReviewerPreviewFormat = 'docx' | 'pptx'
type ReviewerPreviewRequest = {
  sessionId: string
  resource: ManagedPreviewResource
  format: ReviewerPreviewFormat
  pages: number[]
}
type PreparedPage = {
  pageNumber: number
  text: string
  rect: { x: number; y: number; width: number; height: number }
}
const container = document.getElementById('reviewer-paged-preview-root')
if (!(container instanceof HTMLDivElement)) throw new Error('Reviewer preview root is unavailable.')

let request: ReviewerPreviewRequest | undefined
let officeSession: TargetedOfficeRenderSession | undefined
let officeController: AbortController | undefined

const dispose = async (): Promise<void> => {
  officeController?.abort()
  officeController = undefined
  await officeSession?.dispose()
  officeSession = undefined
  container.replaceChildren()
}

const assertRequestedPage = (pageNumber: number): void => {
  if (!request?.pages.includes(pageNumber)) {
    throw new Error(`Page ${pageNumber} was not admitted for this Reviewer preview.`)
  }
}

const settleRenderedLayout = async (): Promise<void> => {
  await document.fonts?.ready
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

const elementResult = (pageNumber: number, element: HTMLElement): PreparedPage => {
  element.scrollIntoView({ block: 'start', inline: 'center' })
  const rect = element.getBoundingClientRect()
  return {
    pageNumber,
    text: element.textContent?.trim() ?? '',
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }
}

const initialize = async (
  next: ReviewerPreviewRequest
): Promise<{ pageCount: number; pageCountComplete: boolean; availablePages: number[] }> => {
  await dispose()
  const admittedSessionId = new URL(window.location.href).searchParams.get('sessionId')
  if (!admittedSessionId || next.sessionId !== admittedSessionId) {
    throw new Error('Reviewer preview session does not match its isolated runtime.')
  }
  request = next
  const response = await fetch(next.resource.url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Reviewer preview read failed with status ${response.status}.`)
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > next.resource.size) {
    throw new Error('Reviewer preview response exceeded its admitted size.')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== next.resource.size) throw new Error('Reviewer preview file changed.')

  officeController = new AbortController()
  officeSession = await renderTargetedOfficeFile({
    bytes,
    extension: next.format,
    container,
    signal: officeController.signal,
    targetPages: next.pages
  })
  await settleRenderedLayout()
  const pageCount = officeSession.pageCount
  if (pageCount < 1) throw new Error('Rendered document contains no pages.')
  return {
    pageCount,
    pageCountComplete: officeSession.pageCountComplete,
    availablePages: officeSession.availablePages
  }
}

const preparePage = async ({ pageNumber }: { pageNumber: number }): Promise<PreparedPage> => {
  assertRequestedPage(pageNumber)
  const page = await officeSession!.preparePage(pageNumber)
  await settleRenderedLayout()
  return elementResult(pageNumber, page)
}

window.__openScienceReviewerPagedPreview = { initialize, preparePage }
window.addEventListener('beforeunload', () => void dispose())

declare global {
  interface Window {
    __openScienceReviewerPagedPreview: {
      initialize(
        request: ReviewerPreviewRequest
      ): Promise<{ pageCount: number; pageCountComplete: boolean; availablePages: number[] }>
      preparePage(request: { pageNumber: number }): Promise<PreparedPage>
    }
  }
}
