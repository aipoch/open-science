// @vitest-environment jsdom
import { act, Component, type ReactNode } from 'react'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WEB_EVENT_CONNECTION_STATE_EVENT,
  WEB_EVENT_SURFACE_ATTRIBUTE
} from '../../../../../../shared/web-event-connection'
import { pdfjsLib } from '../pdfjs'
import { createManagedPdfLoadingTask } from '../managed-pdf-document'
import { PdfPreviewContent, PdfPreviewRenderer } from './PdfPreview'
import * as nearViewport from '../useNearViewport'
import { PdfOutlineSidebar } from './PdfOutlineSidebar'
import {
  requestAnnotationReveal,
  requestPdfAnnotationReveal
} from '../../annotations/annotation-reveal'
import type {
  PdfAnnotation as SavedPdfAnnotation,
  PdfAnnotationListResult,
  PdfNativeAnnotationImportProgress
} from '../../../../../../shared/pdf-annotations'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PdfAnnotationsProvider } from '../../pdf-annotations/PdfAnnotationsProvider'
import { useSessionStore } from '@/stores/session-store'
import { useSettingsStore } from '@/stores/settings-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { createPreviewResourceKey } from '../preview-resource-key'
import { createPdfTranslationSource } from './pdf-translation'
import * as pdfTranslations from './pdf-translation'
import { PdfGenerationError } from '../../../../../../shared/pdf-translation'
import type { PdfTranslationCheckpoint } from '../../../../../../shared/pdf-translation'
import { renderPdfNativeLinks } from './pdf-native-links'
import * as translationJobs from './use-pdf-translation-job'
import type { PdfDocumentSource } from '../../../../../../shared/pdf-bookmarks'

vi.mock('./pdf-native-links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pdf-native-links')>()),
  renderPdfNativeLinks: vi.fn(async () => {})
}))

vi.mock('../managed-pdf-document', () => ({ createManagedPdfLoadingTask: vi.fn() }))
const { cancelTextLayer, renderTextLayer } = vi.hoisted(() => ({
  cancelTextLayer: vi.fn(),
  renderTextLayer: vi.fn()
}))
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  TextLayerBuilder: class {
    readonly div = document.createElement('div')

    constructor(
      private readonly options: {
        pdfPage: {
          getTextContent: () => Promise<{
            items?: Array<{
              str?: string
              transform?: number[]
              width?: number
              height?: number
            }>
          }>
        }
        onAppend?: (div: HTMLDivElement) => void
      }
    ) {
      this.div.className = 'textLayer'
    }

    async render(): Promise<void> {
      const textContent = await this.options.pdfPage.getTextContent()
      renderTextLayer(this.options)
      for (const item of textContent.items ?? []) {
        const span = document.createElement('span')
        span.textContent = item.str ?? ''
        const left = item.transform?.[4] ?? 0
        const top = item.transform?.[5] ?? 0
        const width = item.width ?? 0
        const height = item.height ?? 0
        span.getBoundingClientRect = () =>
          ({
            x: left,
            y: top,
            left,
            top,
            right: left + width,
            bottom: top + height,
            width,
            height,
            toJSON: () => ({})
          }) as DOMRect
        this.div.appendChild(span)
      }
      const end = document.createElement('div')
      end.className = 'endOfContent'
      this.div.appendChild(end)
      this.options.onAppend?.(this.div)
    }

    cancel(): void {
      cancelTextLayer()
    }
  }
}))
vi.mock('../pdfjs', () => ({
  pdfjsLib: {
    getDocument: vi.fn(),
    AnnotationMode: { ENABLE_STORAGE: 3 },
    TextLayer: class {
      constructor(
        private readonly options: {
          textContentSource: { items?: Array<{ str?: string }> }
          container: HTMLElement
        }
      ) {}

      render(): Promise<void> {
        renderTextLayer(this.options)
        for (const item of this.options.textContentSource.items ?? []) {
          const span = document.createElement('span')
          span.textContent = item.str ?? ''
          this.options.container.appendChild(span)
        }
        return Promise.resolve()
      }

      cancel(): void {
        cancelTextLayer()
      }
    }
  }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const dispatchPointer = (target: EventTarget, type: string, init: PointerEventInit): void => {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: init.button,
    clientX: init.clientX,
    clientY: init.clientY
  })
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    isPrimary: { value: init.isPrimary ?? true }
  })
  target.dispatchEvent(event)
}

const openReadingView = async (): Promise<void> => {
  const trigger = await screen.findByRole('button', { name: 'Reading view' })
  if (trigger.getAttribute('aria-expanded') !== 'true')
    await act(async () => fireEvent.click(trigger))
}

const readingRenditionGroup = (): HTMLElement =>
  screen
    .getAllByRole('group', { name: 'PDF rendition' })
    .find((group) => within(group).queryByRole('button', { name: 'Compare' })) as HTMLElement

describe('PdfPreviewContent', () => {
  let container: HTMLDivElement
  let root: Root
  const destroyDocument = vi.fn().mockResolvedValue(undefined)
  const initialSettings = useSettingsStore.getState()
  let getPage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    destroyDocument.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    Element.prototype.scrollIntoView = vi.fn()
    // jsdom implements DOM ranges but has no layout engine.
    vi.stubGlobal(
      'Range',
      class extends Range {
        getBoundingClientRect(): DOMRect {
          return new DOMRect()
        }
      }
    )
    window.api = {
      pdfStructure: {
        readCached: vi.fn().mockResolvedValue(undefined),
        parse: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn().mockResolvedValue(undefined)
      },
      localModels: {
        getSnapshot: vi
          .fn()
          .mockResolvedValue({ availability: 'notInstalled', updateAvailable: false })
      },
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'resource-1',
          url: 'open-science-preview://resource-1/report.pdf',
          size: 80 * 1024 * 1024,
          mimeType: 'application/pdf',
          version: 1
        }),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as Window['api']
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn()
    } as unknown as CanvasRenderingContext2D)
    getPage = vi.fn().mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      getTextContent: vi
        .fn()
        .mockResolvedValue({ items: [{ str: 'Selectable text' }], styles: {} }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useSettingsStore.setState(initialSettings)
    useSessionStore.setState({ sessions: [], selectedSessionId: undefined } as never)
    usePreviewWorkbenchStore.setState({
      activeProjectId: undefined,
      pendingPdfContextByProject: {}
    })
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  it('hides successful native import receipts, while keeping progress and incomplete-import warnings', async () => {
    const cancel = vi.fn()
    const renderProgress = async (
      phase: PdfNativeAnnotationImportProgress['phase'],
      overrides: Partial<PdfNativeAnnotationImportProgress> = {}
    ): Promise<void> => {
      await act(async () => {
        root.render(
          <PdfPreviewContent
            path="/audit/import.pdf"
            name="import.pdf"
            onCancelNativeImport={cancel}
            nativeImportProgress={{
              operationId: 'import-1',
              phase,
              pageCount: 2,
              pagesProcessed: 2,
              importedCount: 3,
              unsupportedCount: 0,
              truncated: false,
              ...overrides
            }}
          />
        )
        await flush()
      })
    }
    await renderProgress('parsing')
    expect(screen.getByRole('status').textContent).toContain('Importing native annotations')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })))
    expect(cancel).toHaveBeenCalledOnce()
    await renderProgress('saving')
    expect(screen.getByRole('status').textContent).toContain('Saving imported annotations')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    for (const importedCount of [0, 3]) {
      await renderProgress('completed', { importedCount })
      expect(screen.queryByRole('status')).toBeNull()
      expect(container.textContent).not.toContain('Imported')
    }
    await renderProgress('failed')
    expect(screen.getByRole('status').textContent).toContain('Native annotation import failed.')
    await renderProgress('cancelled')
    expect(screen.getByRole('status').textContent).toContain('Native annotation import cancelled.')
    await renderProgress('completed', { truncated: true })
    expect(screen.getByRole('status').textContent).toContain(
      'Native annotation import limit reached.'
    )
    await renderProgress('completed', { unsupportedCount: 2 })
    expect(screen.getByRole('status').textContent).toContain('Unsupported native annotations: 2')
  })

  const observe = (): {
    targets: Element[]
    disconnect: ReturnType<typeof vi.fn>
    unobserve: ReturnType<typeof vi.fn>
    notify: (target: Element, near: boolean) => Promise<void>
  } => {
    let callback!: IntersectionObserverCallback
    const targets: Element[] = []
    const disconnect = vi.fn(),
      unobserve = vi.fn()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: IntersectionObserverCallback) {
          callback = cb
        }
        observe(element: Element): void {
          targets.push(element)
        }
        unobserve = unobserve
        disconnect = disconnect
      }
    )
    return {
      targets,
      disconnect,
      unobserve,
      notify: async (target: Element, near: boolean) =>
        act(async () => {
          callback(
            [{ target, isIntersecting: near } as IntersectionObserverEntry],
            {} as IntersectionObserver
          )
          await flush()
        })
    }
  }

  it('keeps the sidebar mounted across edition selection and asynchronous layout verification', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
    const page = await (
      getPage as () => Promise<{
        getViewport: ReturnType<typeof vi.fn>
        getTextContent: ReturnType<typeof vi.fn>
        getAnnotations?: ReturnType<typeof vi.fn>
      }>
    )()
    page.getViewport.mockReturnValue({ width: 600, height: 800 })
    page.getTextContent.mockResolvedValue({
      items: [
        { str: 'Selectable text', width: 80, height: 10, transform: [10, 0, 0, 10, 60, 700] }
      ],
      styles: {}
    })
    page.getAnnotations = vi.fn().mockResolvedValue([])
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        fingerprints: ['fp'],
        getPage,
        getData: async () => new Uint8Array([0]),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    const saved = (key: string, unitId: string, text: string): PdfTranslationCheckpoint => ({
      version: 1,
      key,
      revision: 1,
      attachmentVersionId: 'version-1',
      checksum: 'a'.repeat(64),
      fingerprint: 'fp',
      language: 'Chinese',
      glossary: [],
      targetKey: 'b'.repeat(64),
      model: { frameworkId: 'direct-api', mode: 'api', modelId: unitId },
      sources: ['Selectable text'],
      translations: [text],
      translatedSourceIndices: [0],
      layoutSnapshot: {
        version: 1,
        parserVersion: unitId,
        fingerprint: 'fp',
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            id: unitId,
            source: 'Selectable text',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
                items: [{ index: 0, text: 'Selectable text' }]
              }
            ]
          }
        ],
        coverage: {
          pageCount: 1,
          textItemCount: 1,
          includedItemCount: 1,
          excludedItemCount: 0,
          pagesWithoutText: [],
          exclusions: [],
          warnings: []
        }
      }
    })
    const first = saved('11111111-1111-4111-8111-111111111111', 'first-model', '上一份译文')
    const second = saved('22222222-2222-4222-8222-222222222222', 'second-model', '新译本内容')
    let resolveSelection!: (value: PdfTranslationCheckpoint) => void
    let finishVerification!: () => void
    const verification = new Promise<void>((resolve) => {
      finishVerification = resolve
    })
    const bind = pdfTranslations.createPdfTranslationBinder()
    const delayedBind = vi.fn<typeof bind>(async (...args) => {
      if (args[1].checkpoint?.key === second.key) await verification
      return bind(...args)
    })
    vi.spyOn(pdfTranslations, 'createPdfTranslationBinder').mockReturnValue(delayedBind)
    const editions = [first, second].map((checkpoint, index) => ({
      id: `edition-${index}`,
      key: checkpoint.key,
      language: checkpoint.language,
      glossary: [],
      model: checkpoint.model,
      selected: index === 0,
      updatedAt: 1700000000000 + index
    }))
    const selectEdition = vi.fn(
      () =>
        new Promise<PdfTranslationCheckpoint>((resolve) => {
          resolveSelection = resolve
        })
    )
    Object.assign(window.api, {
      pdfTranslation: {
        readCheckpoint: vi.fn().mockResolvedValue(first),
        listEditions: vi.fn().mockResolvedValue(editions),
        selectEdition,
        generatePdf: vi.fn(() => new Promise(() => {})),
        cancelPdf: vi.fn().mockResolvedValue(undefined)
      }
    })
    const props = {
      path: 'literature-attachment-version:version-1',
      name: 'edition.pdf',
      source: 'literature' as const
    }
    const executor = {
      targets: [{ id: 'api', label: 'Direct API', mode: 'api' as const }],
      translate: vi.fn()
    }
    await act(async () => {
      root.render(<PdfPreviewContent {...props} translationExecutor={executor} />)
      await flush()
    })
    await act(async () => screen.getByRole('button', { name: 'View translation' }).click())
    const selector = await screen.findByRole<HTMLButtonElement>('combobox', {
      name: 'Saved translations'
    })
    const setup = screen.getByRole('button', { name: 'Translation settings' })
    expect(setup.getAttribute('aria-expanded')).toBe('false')
    const progress = screen.getByRole('group', { name: 'Translation progress' })
    const toggle = screen.getByRole('button', { name: /^Translation\s*1$/ })
    await act(async () => toggle.click())
    const oldRow = container.querySelector('[data-translation-row="first-model"]')!
    expect(oldRow).not.toBeNull()
    await act(async () => fireEvent.keyDown(selector, { key: 'ArrowDown' }))
    await act(async () =>
      fireEvent.click(screen.getByRole('option', { name: /Chinese · second-model/ }))
    )
    expect(selectEdition).toHaveBeenCalledWith({ source: 'version-1', translationId: 'edition-1' })
    expect(selector.disabled).toBe(true)
    expect(progress.isConnected).toBe(true)
    await act(async () => {
      resolveSelection(second)
      await flush()
    })
    await waitFor(() =>
      expect(delayedBind.mock.calls.some((args) => args[1].checkpoint?.key === second.key)).toBe(
        true
      )
    )
    expect(selector.isConnected).toBe(true)
    expect(selector.disabled).toBe(true)
    expect(selector.getAttribute('aria-busy')).toBe('true')
    expect(setup.isConnected).toBe(true)
    expect(setup.getAttribute('aria-expanded')).toBe('false')
    expect(progress.isConnected).toBe(true)
    expect(toggle.isConnected).toBe(true)
    expect(oldRow.isConnected).toBe(true)
    expect(container.querySelector('[data-translation-row="second-model"]')).toBeNull()
    await act(async () => {
      finishVerification()
      await flush()
    })
    await waitFor(() =>
      expect(container.querySelector('[data-translation-row="second-model"]')).not.toBeNull()
    )
    expect(selector.disabled).toBe(false)
    expect(progress.isConnected).toBe(true)
    expect(toggle.isConnected).toBe(true)
    expect(setup.getAttribute('aria-expanded')).toBe('false')
    expect(oldRow.isConnected).toBe(false)
    expect(container.querySelector('[data-translation-row="first-model"]')).toBeNull()
    // Another PDF must never inherit the retained edition or its sidebar content.
    await act(async () => {
      root.render(<PdfPreviewContent path="other.pdf" name="other.pdf" />)
      await flush()
    })
    expect(container.querySelector('[data-translation-row="second-model"]')).toBeNull()
  })

  it('prefetches saved translation recovery while the literature PDF opens', async () => {
    const readCheckpoint = vi.fn().mockResolvedValue(null)
    ;(window.api as Window['api']).pdfTranslation = { readCheckpoint } as never
    await act(async () => {
      root.render(
        <PdfPreviewContent
          path="literature-attachment-version:version-1"
          name="paper.pdf"
          source="literature"
        />
      )
      await flush()
    })
    expect(readCheckpoint).toHaveBeenCalledWith('version-1')
  })

  it.each([
    { kind: 'upload', hasSession: true, readOnly: false },
    { kind: 'artifact', hasSession: true, readOnly: false },
    { kind: 'upload', hasSession: false, readOnly: false },
    { kind: 'artifact', hasSession: false, readOnly: false },
    { kind: 'upload', hasSession: true, readOnly: true },
    { kind: 'artifact', hasSession: true, readOnly: true }
  ] as const)(
    'prepares, translates, generates and opens a workspace $kind PDF with active Session $hasSession and read-only Notes $readOnly',
    async ({ kind, hasSession, readOnly }) => {
      useSettingsStore.setState({
        providers: [
          {
            id: 'api-provider',
            name: 'API provider',
            type: 'custom',
            baseUrl: 'https://example.test',
            apiEndpoints: ['openai'],
            models: ['translation-test'],
            hasKey: true,
            needsKey: false,
            supportsImageInput: false
          }
        ]
      })
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
      const documentSource: PdfDocumentSource = {
        kind: kind === 'upload' ? 'upload-version' : 'artifact-version',
        projectId: 'project-1',
        sourceFileId: 'file-1',
        versionId: 'version-1',
        sessionId: 'creator',
        name: 'paper.pdf',
        path: `${kind}-version:version-1`,
        checksum: 'a'.repeat(64)
      }
      const resolvePdfSource = vi
        .fn()
        .mockResolvedValue(
          readOnly
            ? { ok: false, reason: 'source-unavailable' }
            : { ok: true, source: documentSource }
        )
      const inspect = vi.fn().mockResolvedValue({
        ok: true,
        value: {
          projectId: 'project-1',
          source: kind,
          fileId: 'file-1',
          sessionId: 'creator',
          selectedVersion: {
            id: 'version-1',
            source: kind,
            fileId: 'file-1',
            versionNumber: 1,
            displayName: documentSource.name,
            originKind: kind === 'upload' ? 'user_upload' : 'agent_generated',
            basedOnVersionId: null,
            contentType: 'application/pdf',
            sizeBytes: 1024,
            checksum: documentSource.checksum,
            createdAt: '2026-10-02T00:00:00.000Z'
          }
        }
      })
      const readCheckpoint = vi.fn().mockResolvedValue(null)
      const begin = vi.fn().mockResolvedValue({
        operationId: 'translation-1',
        targetKey: 'b'.repeat(64),
        model: { frameworkId: 'direct-api', mode: 'api' }
      })
      const translate = vi.fn().mockResolvedValue('译文')
      const generatePdf = vi.fn().mockResolvedValue(new Uint8Array([4, 5]))
      const close = vi.fn().mockResolvedValue(undefined)
      const viewport = {
        width: 600,
        height: 800,
        rotation: 0,
        transform: [1, 0, 0, -1, 0, 800],
        convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
      }
      const item = {
        str: 'Selectable text',
        fontName: 'f1',
        transform: [12, 0, 0, 12, 60, 700],
        width: 100,
        height: 12,
        dir: 'ltr'
      }
      const page = await (
        getPage as () => Promise<{
          rotate: number
          getViewport: ReturnType<typeof vi.fn>
          getTextContent: ReturnType<typeof vi.fn>
          getAnnotations: ReturnType<typeof vi.fn>
        }>
      )()
      page.rotate = 0
      page.getViewport.mockReturnValue(viewport)
      page.getTextContent.mockResolvedValue({ items: [item], styles: {} })
      page.getAnnotations = vi.fn().mockResolvedValue([])
      vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
        promise: Promise.resolve({
          numPages: 1,
          fingerprints: ['fp'],
          getPage,
          getData: vi.fn().mockResolvedValue(new Uint8Array([1, 2])),
          destroy: destroyDocument
        }),
        destroy: vi.fn().mockResolvedValue(undefined)
      } as never)
      const translatedPage = {
        ...page,
        getTextContent: vi.fn().mockResolvedValue({
          items: [{ ...item, str: '译文', width: 24 }],
          styles: {}
        })
      }
      vi.mocked(pdfjsLib.getDocument).mockReturnValue({
        promise: Promise.resolve({
          numPages: 1,
          fingerprints: ['translated'],
          getPage: vi.fn().mockResolvedValue(translatedPage),
          destroy: vi.fn().mockResolvedValue(undefined)
        }),
        destroy: vi.fn().mockResolvedValue(undefined)
      } as never)
      vi.mocked(window.api.previewResources.acquire).mockResolvedValue({
        id: 'resource-1',
        url: 'open-science-preview://resource-1/paper.pdf',
        size: 1024,
        mimeType: 'application/pdf',
        version: 1,
        sourceChecksum: documentSource.checksum
      })
      window.api = {
        ...window.api,
        bookmarks: { resolvePdfSource },
        managedFileVersions: { inspect },
        pdfTranslation: {
          readCheckpoint,
          begin,
          translate,
          close,
          generatePdf,
          cancelPdf: vi.fn().mockResolvedValue(undefined)
        }
      } as unknown as Window['api']
      useSessionStore.setState({
        selectedSessionId: hasSession ? 'reader' : undefined,
        sessions: hasSession ? [{ id: 'reader', projectId: 'project-1' }] : []
      } as never)
      await act(async () => {
        root.render(
          <TooltipProvider>
            <PdfPreviewRenderer
              item={{
                id: 'file-1',
                projectId: 'project-1',
                sessionId: 'creator',
                title: documentSource.name,
                type: 'file',
                source: kind,
                path: documentSource.path,
                name: documentSource.name,
                format: 'pdf',
                managedFileId: 'file-1',
                selectedVersionId: 'version-1'
              }}
            />
          </TooltipProvider>
        )
        await flush()
      })
      if (hasSession) {
        expect(resolvePdfSource).toHaveBeenCalledWith({
          projectId: 'project-1',
          sessionId: 'reader',
          sourceKind: documentSource.kind,
          sourceFileId: documentSource.sourceFileId,
          versionId: documentSource.versionId
        })
      } else {
        expect(resolvePdfSource).not.toHaveBeenCalled()
        expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
        expect(screen.queryByRole('button', { name: 'Select area for Agent' })).toBeNull()
      }
      expect(inspect).toHaveBeenCalledWith({
        projectId: 'project-1',
        source: kind,
        fileId: 'file-1',
        versionId: 'version-1'
      })
      expect(readCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          kind: documentSource.kind,
          sourceFileId: documentSource.sourceFileId,
          versionId: documentSource.versionId,
          checksum: documentSource.checksum
        })
      )
      await act(async () => screen.getByRole('button', { name: 'Full-text translation' }).click())
      await act(async () => {
        screen.getByRole('button', { name: 'Prepare full text' }).click()
        await flush()
      })
      await waitFor(() => expect(screen.getByText('Full text prepared')).toBeTruthy())
      await act(async () =>
        fireEvent.keyDown(screen.getByRole('combobox', { name: 'Translation method' }), {
          key: 'ArrowDown'
        })
      )
      await act(async () => fireEvent.click(screen.getByRole('option', { name: 'Direct API' })))
      await act(async () =>
        fireEvent.keyDown(screen.getByRole('combobox', { name: 'Model' }), {
          key: 'ArrowDown'
        })
      )
      await act(async () =>
        fireEvent.click(screen.getByRole('option', { name: 'translation-test · API provider' }))
      )
      await act(async () =>
        fireEvent.change(screen.getByLabelText('Target language'), { target: { value: 'Chinese' } })
      )
      await act(async () => {
        screen.getByRole('button', { name: 'Translate document' }).click()
        await flush()
      })
      expect(begin).toHaveBeenCalledWith(
        expect.objectContaining({
          documentSource: expect.objectContaining({
            kind: documentSource.kind,
            projectId: documentSource.projectId,
            sourceFileId: documentSource.sourceFileId,
            versionId: documentSource.versionId,
            checksum: documentSource.checksum
          }),
          targetId: 'api',
          apiModel: { providerId: 'api-provider', modelId: 'translation-test' },
          sources: ['Selectable text']
        })
      )
      expect(begin.mock.calls[0][0]).not.toHaveProperty('attachmentVersionId')
      expect(translate).toHaveBeenCalledWith({
        operationId: 'translation-1',
        sourceIndex: 0,
        source: 'Selectable text'
      })
      await waitFor(() => expect(generatePdf).toHaveBeenCalledOnce())
      expect(generatePdf.mock.calls[0][0]).toMatchObject({
        data: new Uint8Array([1, 2]),
        units: [{ source: 'Selectable text', translation: '译文' }]
      })
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'View translated PDF' }).hasAttribute('disabled')
        ).toBe(false)
      )
      await act(async () => screen.getByRole('button', { name: 'View translated PDF' }).click())
      await waitFor(() =>
        expect(container.querySelector('[data-pdf-translated-page]')?.textContent).toContain('译文')
      )
      expect(close).toHaveBeenCalledWith({ operationId: 'translation-1' })
    }
  )

  it.each([
    { projectId: 'another-project' },
    { kind: 'artifact-version' as const },
    { sourceFileId: 'another-file' },
    { versionId: 'another-version' },
    { checksum: 'b'.repeat(64) }
  ])(
    'does not expose workspace translation for a mismatched fixed Version %j',
    async (difference) => {
      const documentSource: PdfDocumentSource = {
        kind: 'upload-version',
        projectId: 'project-1',
        sourceFileId: 'file-1',
        versionId: 'version-1',
        name: 'paper.pdf',
        path: 'upload-version:version-1',
        checksum: 'a'.repeat(64),
        ...difference
      }
      const resolvePdfSource = vi.fn().mockResolvedValue({ ok: true, source: documentSource })
      const inspect = vi.fn().mockResolvedValue({
        ok: true,
        value: {
          projectId: documentSource.projectId,
          source: documentSource.kind === 'artifact-version' ? 'artifact' : 'upload',
          fileId: documentSource.sourceFileId,
          sessionId: 'creator',
          selectedVersion: {
            id: documentSource.versionId,
            fileId: documentSource.sourceFileId,
            source: documentSource.kind === 'artifact-version' ? 'artifact' : 'upload',
            displayName: documentSource.name,
            checksum: documentSource.checksum,
            contentType: 'application/pdf',
            sizeBytes: 1024
          }
        }
      })
      const readCheckpoint = vi.fn().mockResolvedValue(null)
      window.api = {
        ...window.api,
        bookmarks: { resolvePdfSource },
        managedFileVersions: { inspect },
        pdfTranslation: { readCheckpoint, begin: vi.fn(), translate: vi.fn(), close: vi.fn() }
      } as unknown as Window['api']
      vi.mocked(window.api.previewResources.acquire).mockResolvedValue({
        id: 'resource-1',
        url: 'open-science-preview://resource-1/paper.pdf',
        size: 1024,
        mimeType: 'application/pdf',
        version: 1,
        sourceChecksum: 'a'.repeat(64)
      })
      useSessionStore.setState({
        selectedSessionId: 'reader',
        sessions: [{ id: 'reader', projectId: 'project-1' }]
      } as never)
      await act(async () => {
        root.render(
          <PdfPreviewRenderer
            item={{
              id: 'file-1',
              projectId: 'project-1',
              sessionId: 'creator',
              title: 'paper.pdf',
              type: 'file',
              source: 'upload',
              path: 'upload-version:version-1',
              name: 'paper.pdf',
              format: 'pdf',
              managedFileId: 'file-1',
              selectedVersionId: 'version-1'
            }}
          />
        )
        await flush()
      })
      expect(screen.queryByRole('button', { name: 'Full-text translation' })).toBeNull()
      expect(window.api.pdfTranslation!.begin).not.toHaveBeenCalled()
    }
  )

  it('does not rerender page placeholders when opening the search toolbar', async () => {
    observe()
    const pageRenders = vi.spyOn(nearViewport, 'useNearViewport')
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 400, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    await act(async () => {
      root.render(<PdfPreviewContent path="/audit/long.pdf" name="long.pdf" />)
      await flush()
    })
    pageRenders.mockClear()
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Search"]')!.click()
    )
    expect(container.querySelector('[aria-label="Search document"]')).not.toBeNull()
    expect(pageRenders).not.toHaveBeenCalled()
    expect(getPage).not.toHaveBeenCalled()
  })

  it('bounds layout reads when tracking the current page near the end of a long PDF', async () => {
    observe()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 1000, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    const onReadingPositionChange = vi.fn()
    await act(async () => {
      root.render(
        <PdfPreviewContent
          path="/audit/long.pdf"
          name="long.pdf"
          onReadingPositionChange={onReadingPositionChange}
        />
      )
      await flush()
    })
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    scroll.getBoundingClientRect = () => new DOMRect(0, 0, 400, 600)
    let reads = 0
    for (const [index, page] of [
      ...container.querySelectorAll<HTMLElement>('[data-page-number]')
    ].entries()) {
      page.getBoundingClientRect = () => {
        reads++
        return new DOMRect(0, index * 812 - scroll.scrollTop, 600, 800)
      }
    }
    scroll.scrollTop = 999 * 812
    await act(async () => {
      fireEvent.scroll(scroll)
      await vi.advanceTimersByTimeAsync(110)
    })
    expect(onReadingPositionChange).toHaveBeenLastCalledWith({ pageNumber: 1000, pageCount: 1000 })
    expect(reads).toBeLessThanOrEqual(12)
    expect(getPage).not.toHaveBeenCalled()
  })

  it.each(['ready', 'error'] as const)(
    're-entering a previously %s page displays loading while pending',
    async (firstStatus) => {
      const io = observe()
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const page = await (getPage as ReturnType<typeof vi.fn<() => Promise<unknown>>>)()
      getPage.mockClear()
      if (firstStatus === 'error')
        getPage.mockRejectedValueOnce(new Error('Temporary page read failure'))
      await act(async () => {
        root.render(<PdfPreviewContent path="/audit/reenter.pdf" name="reenter.pdf" />)
        await flush()
      })
      const element = container.querySelector('[data-page-number="1"]')!
      await io.notify(element, true)
      expect(getPage).toHaveBeenCalledTimes(1)
      expect(element.textContent?.includes('could not be rendered')).toBe(firstStatus === 'error')
      await io.notify(element, false)
      let complete!: (value: unknown) => void
      getPage.mockReturnValueOnce(new Promise((resolve) => (complete = resolve)))
      await io.notify(element, true)
      expect(getPage).toHaveBeenCalledTimes(2)
      expect(element.querySelector('canvas')).not.toBeNull()
      expect(element.querySelector('[data-preview-status="compact-loading"]')).not.toBeNull()
      expect(element.textContent).not.toContain('could not be rendered')
      await act(async () => {
        complete(page)
        await flush()
      })
      expect(element.textContent).not.toContain('could not be rendered')
      expect(element.querySelector('canvas')?.width).toBeGreaterThan(0)
      errorLog.mockRestore()
    }
  )

  it('sidebar expands its visible range when its container grows', async () => {
    observe()
    const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        entry: { callback: ResizeObserverCallback; targets: Element[] }
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, targets: [] }
          observers.push(this.entry)
        }
        observe(target: Element): void {
          this.entry.targets.push(target)
        }
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    let height = 224
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
    const sidebar = (pageCount = 100, currentPage = 1): React.JSX.Element => (
      <PdfOutlineSidebar
        document={{ getPage } as never}
        items={[]}
        pageCount={pageCount}
        currentPage={currentPage}
        width={240}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        onWidthChange={vi.fn()}
      />
    )
    await act(async () => {
      root.render(sidebar())
      await flush()
    })
    const list = container.querySelector('[aria-label="Pages"]')!.parentElement!
    const buttons = (): HTMLButtonElement[] =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Page "]'))
    expect(buttons()).toHaveLength(9)
    height = 2400
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      observers.forEach(({ callback, targets }) =>
        callback(
          targets.map((target) => ({ target, contentRect: { height } }) as ResizeObserverEntry),
          {} as ResizeObserver
        )
      )
      root.render(sidebar())
      await flush()
    })
    expect(buttons()).toHaveLength(19)
    await act(async () => {
      list.dispatchEvent(new Event('scroll'))
      await flush()
    })
    expect(buttons()).toHaveLength(19)
    await act(async () => {
      root.render(sidebar(100, 90))
      await flush()
    })
    expect(buttons().some((b) => b.getAttribute('aria-label') === 'Page 90')).toBe(true)
    expect(buttons().length).toBeLessThanOrEqual(24)
    await act(async () => {
      root.render(sidebar(3, 1))
      await flush()
    })
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Page 1',
      'Page 2',
      'Page 3'
    ])
  })

  it.each(['artifact', 'retry', 'retry-sidebar', 'validation', 'validation-unchanged'] as const)(
    'renders two admitted PDFs after %s, retaining text selection and visible generation status',
    async (kind) => {
      const observer = observe()
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
      let invalidTranslation = false
      let translatedText = '细胞'
      const targetPage = {
        cleanup: vi.fn(),
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
          scale,
          rotation: 0,
          convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale]
        }),
        render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
        getTextContent: async () => ({
          items: [
            {
              str: invalidTranslation ? 'wrong' : translatedText,
              width: 20,
              transform: [10, 0, 0, 10, 60, 700]
            }
          ]
        }),
        getAnnotations: async () => []
      }
      const originalPage = {
        ...targetPage,
        getTextContent: async () => ({
          items: [
            { str: 'Selectable text', width: 80, height: 10, transform: [10, 0, 0, 10, 60, 700] }
          ]
        })
      }
      const original = {
        numPages: 1,
        fingerprints: ['fp'],
        getData: async () => new Uint8Array([2]),
        getPage: async () => originalPage,
        destroy: vi.fn(async () => {})
      }
      vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
        promise: Promise.resolve(original),
        destroy: vi.fn(async () => {})
      } as never)
      const destroy = vi.fn(async () => {})
      vi.mocked(pdfjsLib.getDocument).mockReturnValue({
        promise: Promise.resolve({ numPages: 1, getPage: async () => targetPage }),
        destroy
      } as never)
      const props = { path: 'pair.pdf', name: 'pair.pdf', source: 'local' as const }
      const source = createPdfTranslationSource({
        resourceRequestKey: createPreviewResourceKey(props) + ':0',
        fingerprint: 'fp',
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            id: 'p1',
            source: 'Selectable text',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
                items: [{ index: 0, text: 'Selectable text' }]
              }
            ]
          }
        ]
      })
      const results = {
        source,
        units: [{ id: 'p1', translationSource: 'Selectable text', translation: '细胞' }]
      }
      let fail!: (error: Error) => void
      let complete!: (data: Uint8Array) => void
      const generatePdf = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              complete = resolve
              fail = reject
            })
        )
        .mockResolvedValue(new Uint8Array([1]))
      Object.assign(window.api, {
        pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) }
      })
      await act(async () => {
        root.render(
          <PdfPreviewContent
            {...props}
            translationSource={source}
            translation={results}
            translationArtifact={
              kind === 'artifact' ? { results, data: new Uint8Array([1]) } : undefined
            }
          />
        )
        await flush()
      })
      if (kind === 'artifact') {
        await openReadingView()
        await act(async () => {
          fireEvent.click(within(readingRenditionGroup()).getByRole('button', { name: 'Compare' }))
          await flush()
        })
      }
      if (kind !== 'artifact') {
        expect(
          screen.getByRole<HTMLButtonElement>('button', { name: 'Reading view' }).disabled
        ).toBe(true)
        expect(screen.getByRole('status').className).toContain('sr-only')
        expect(
          screen.getByRole('button', { name: 'View translation' }).getAttribute('aria-busy')
        ).toBe('true')
        expect(
          container.querySelector('[data-pdf-translation-sidebar]')?.getAttribute('aria-hidden')
        ).toBe('true')
        await act(async () => screen.getByRole('button', { name: 'View translation' }).click())
        const loadingPanel = screen.getByRole('complementary', { name: 'Translation sidebar' })
        expect(within(loadingPanel).queryByRole('status')).toBeNull()
        // Generating a PDF never hides accepted text behind a full-panel spinner.
        const textReview = within(loadingPanel).getByRole('button', { name: /^Translation\s*1$/ })
        await act(async () => textReview.click())
        expect(within(loadingPanel).getAllByText('细胞').length).toBeGreaterThan(0)
        expect(within(loadingPanel).getByRole('group', { name: 'PDF rendition' })).toBeTruthy()
        await act(async () => textReview.click())
        expect(textReview.getAttribute('aria-pressed')).toBe('false')
        await act(async () => screen.getByRole('button', { name: 'Close translation' }).click())
        await act(async () => {
          if (kind === 'validation' || kind === 'validation-unchanged') {
            invalidTranslation = true
            complete(new Uint8Array([1]))
          } else fail(new Error('worker unavailable'))
          await flush()
        })
        expect(screen.queryByRole('alert')).toBeNull()
        const entry = screen.getByRole('button', { name: 'View translation' })
        expect(entry.getAttribute('aria-expanded')).toBe('false')
        await act(async () => entry.click())
        const error = screen.getByRole('alert')
        expect(error.textContent).toContain('Could not prepare translated PDF')
        if (kind === 'validation' || kind === 'validation-unchanged') {
          expect(error.textContent).toContain('Page 1')
          const details = screen.getByText('Details').closest('details')!
          expect(details.open).toBe(false)
          await act(async () => screen.getByText('Details').click())
          expect(details.open).toBe(true)
          expect(details.textContent).toContain('PDF translation text or placement changed')
          await act(async () => screen.getByRole('button', { name: 'Locate issue' }).click())
          await act(
            async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          )
          expect(container.querySelector('[data-translation-source="p1"]')).not.toBeNull()
          expect(generatePdf).toHaveBeenCalledTimes(1)
          if (kind === 'validation') invalidTranslation = false
        }

        expect(screen.getAllByRole('alert')).toHaveLength(1)
        expect(screen.getByRole('alert').closest('[data-pdf-translation-sidebar]')).not.toBeNull()
        // First generation failure must expose accepted translations immediately,
        // even though no verified PDF exists to enable the rendition controls.
        const failedPanel = screen.getByRole('complementary', { name: 'Translation sidebar' })
        const unavailableTranslation = within(failedPanel).getByRole<HTMLButtonElement>('button', {
          name: 'View translated PDF'
        })
        expect(unavailableTranslation.disabled).toBe(true)
        fireEvent.focus(unavailableTranslation.parentElement!)
        await waitFor(() =>
          expect(screen.getByRole('tooltip').textContent).toBe(
            'The translated PDF could not be prepared. Read the translated text in the sidebar.'
          )
        )
        fireEvent.blur(unavailableTranslation.parentElement!)
        expect(within(failedPanel).getAllByText('细胞').length).toBeGreaterThan(0)
        expect(
          within(failedPanel)
            .getByRole('button', { name: /^Translation\s*1$/ })
            .getAttribute('aria-pressed')
        ).toBe('true')
        if (kind === 'retry') {
          await act(async () => screen.getByRole('button', { name: 'Close translation' }).click())
          expect(screen.queryByRole('alert')).toBeNull()
          expect(screen.queryByText('Could not prepare translated PDF')).toBeNull()
          await act(async () => screen.getByRole('button', { name: 'View translation' }).click())
          expect(screen.getByRole('alert').closest('[data-pdf-translation-sidebar]')).not.toBeNull()
        }
        await act(async () => {
          const retry = screen.getByRole('button', { name: 'Retry PDF generation' })
          retry.focus()
          retry.click()
          await flush()
        })
        await act(
          async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        )
        if (kind === 'validation-unchanged') {
          expect(generatePdf).toHaveBeenCalledTimes(2)
          expect(screen.getByRole('alert').textContent).toContain(
            'Rebuilding encountered the same issue. Your translations are still available.'
          )
          expect(screen.queryByRole('button', { name: 'Retry PDF generation' })).toBeNull()
          expect(screen.getByRole('button', { name: 'Locate issue' })).toBeTruthy()
          return
        }
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Close translation' })
        )
        expect(generatePdf).toHaveBeenCalledTimes(2)
        expect(screen.queryByRole('alert')).toBeNull()
        expect(screen.queryByText('Preparing translated PDF…')).toBeNull()
      }
      if (kind === 'validation') {
        expect(container.querySelector('[data-translation-source="p1"]')).not.toBeNull()
        expect(container.querySelector('[data-pdf-translated-page]')).toBeNull()
        return
      }
      await openReadingView()
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'Compare' }) as HTMLButtonElement).disabled
        ).toBe(false)
      )
      await act(async () => screen.getByRole('button', { name: 'Compare' }).click())
      await waitFor(() =>
        expect(container.querySelector('[data-pdf-translated-page]')).not.toBeNull()
      )
      expect(container.querySelector('[data-pdf-translation-reader]')).toBeNull()
      const row = container.querySelector<HTMLElement>('[data-page-number="1"]')!
      if (
        container
          .querySelector<HTMLElement>('[data-pdf-translation-sidebar]')
          ?.getAttribute('aria-hidden') === 'true'
      ) {
        await act(async () => screen.getByRole('button', { name: 'View translation' }).click())
      }
      const translationSidebar = container.querySelector<HTMLElement>(
        '[data-pdf-translation-sidebar]'
      )!
      expect(
        within(translationSidebar).getByRole('button', { name: 'View translated PDF' })
      ).toBeTruthy()
      expect(within(translationSidebar).getByRole('button', { name: 'Compare PDFs' })).toBeTruthy()
      expect(within(translationSidebar).getByRole('button', { name: 'Original PDF' })).toBeTruthy()
      expect(
        within(translationSidebar)
          .getByRole('button', { name: /^Translation\s*\d+$/ })
          .getAttribute('aria-pressed')
      ).toBe('false')
      await act(async () =>
        within(translationSidebar).getByRole('button', { name: 'View translated PDF' }).click()
      )
      await waitFor(() => expect(row.querySelector('[data-pdf-translated-page]')).not.toBeNull())
      expect(row.style.gridTemplateColumns).toBe('minmax(0, 1fr)')
      expect(row.querySelector('[data-translation-highlight]')).toBeNull()
      await act(async () =>
        within(translationSidebar)
          .getByRole('button', { name: /^Translation\s*\d+$/ })
          .click()
      )
      await act(async () =>
        within(translationSidebar)
          .getByRole('button', { name: /Page 1/ })
          .click()
      )
      const translatedHighlight = row.querySelector<HTMLElement>(
        '[data-pdf-translated-page] [data-translation-highlight]'
      )!
      expect(translatedHighlight).not.toBeNull()
      expect(translatedHighlight.dataset.translationSource).toBe('p1')
      expect(translatedHighlight.style.left).toBe('10%')
      expect(translatedHighlight.style.width).toBe('80%')
      await waitFor(() =>
        expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(
          translatedHighlight
        )
      )
      expect(
        within(translationSidebar)
          .getByRole('button', { name: 'View translated PDF' })
          .getAttribute('aria-pressed')
      ).toBe('true')
      vi.mocked(Element.prototype.scrollIntoView).mockClear()
      await act(async () =>
        within(translationSidebar)
          .getByRole('button', { name: 'Locate paragraph on page 1' })
          .click()
      )
      await waitFor(() =>
        expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(
          translatedHighlight
        )
      )
      await act(async () =>
        within(translationSidebar)
          .getByRole('button', { name: /^Page 1/ })
          .click()
      )
      expect(row.querySelector('[data-translation-highlight]')).toBeNull()
      await act(async () =>
        within(translationSidebar)
          .getByRole('button', { name: /^Translation\s*\d+$/ })
          .click()
      )
      await act(async () =>
        within(translationSidebar).getByRole('button', { name: 'Original PDF' }).click()
      )
      await waitFor(() => expect(row.style.gridTemplateColumns).toBe('minmax(0, 1fr)'))
      await act(async () =>
        within(translationSidebar)
          .getByRole('button', { name: /^Translation\s*\d+$/ })
          .click()
      )
      await act(async () =>
        within(translationSidebar)
          .getByRole('button', { name: /Page 1/ })
          .click()
      )
      expect(row.style.gridTemplateColumns).toBe('minmax(0, 1fr)')
      expect(
        within(translationSidebar)
          .getByRole('button', { name: 'Original PDF' })
          .getAttribute('aria-pressed')
      ).toBe('true')
      await act(async () =>
        within(translationSidebar).getByRole('button', { name: 'Compare PDFs' }).click()
      )
      await waitFor(() => expect(row.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))'))
      expect(row.querySelectorAll('[data-translation-highlight]')).toHaveLength(2)
      if (kind === 'artifact') {
        await openReadingView()
        await act(async () => screen.getByRole('button', { name: 'Paragraph markers' }).click())
        await act(async () => screen.getByRole('button', { name: 'Reading view' }).click())
        await act(
          async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        )
        const marker = screen.getByRole('button', { name: 'Read paragraph 1 translation' })
        await act(async () => {
          marker.focus()
          marker.click()
        })
        await act(
          async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        )
        expect(document.activeElement).toBe(
          screen.getByRole('region', { name: 'pair.pdf scrollable preview' })
        )
      }
      expect(
        container
          .querySelector<HTMLElement>('[data-pdf-translation-sidebar]')
          ?.getAttribute('aria-hidden')
      ).toBe('false')
      expect(row.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
      for (const target of observer.targets) await observer.notify(target, true)
      expect(row.querySelectorAll('canvas')).toHaveLength(2)
      await waitFor(() => {
        const calls = vi.mocked(renderPdfNativeLinks).mock.calls.map(([options]) => options)
        expect(calls.map((options) => options.page)).toContain(originalPage)
        expect(calls.map((options) => options.page)).toContain(targetPage)
      })
      const linkSignals = vi
        .mocked(renderPdfNativeLinks)
        .mock.calls.map(([options]) => options.signal)
      const linkHosts = row.querySelectorAll<HTMLElement>('[data-pdf-native-links]')
      expect([...linkHosts].every((host) => !host.hasAttribute('inert'))).toBe(true)
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Hand' })))
      expect([...linkHosts].every((host) => host.hasAttribute('inert'))).toBe(true)
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Select' })))
      await waitFor(() =>
        expect(
          row.querySelector('[data-pdf-translated-page] [data-pdf-text-layer]')?.textContent
        ).toContain('细胞')
      )
      await openReadingView()
      await act(async () => {
        fireEvent.click(
          within(readingRenditionGroup()).getByRole('button', { name: 'Translation' })
        )
        await flush()
      })
      expect(row.querySelectorAll('canvas')).toHaveLength(1)
      if (kind === 'retry') {
        const canvas = row.querySelector<HTMLCanvasElement>('[data-pdf-translated-page] canvas')!
        await waitFor(() => expect(canvas.width).toBeGreaterThan(0))
        const previousWidth = canvas.width
        const drawImage = vi.mocked(canvas.getContext('2d')!.drawImage)
        const paints = drawImage.mock.calls.length
        let finishPaint!: () => void
        targetPage.render.mockImplementationOnce(() => ({
          promise: new Promise<void>((resolve) => {
            finishPaint = resolve
          }),
          cancel: vi.fn()
        }))
        vi.mocked(pdfjsLib.getDocument).mockReturnValueOnce({
          promise: Promise.resolve({ numPages: 1, getPage: async () => targetPage }),
          destroy
        } as never)
        translatedText = '细胞内容'
        await act(async () => {
          root.render(
            <PdfPreviewContent
              {...props}
              translationSource={source}
              translation={{
                ...results,
                units: [{ ...results.units[0], translation: translatedText }]
              }}
            />
          )
          await flush()
        })
        await waitFor(() => expect(generatePdf).toHaveBeenCalledTimes(3))
        await waitFor(() => expect(finishPaint).toBeDefined())
        expect(canvas.width).toBe(previousWidth)
        expect(drawImage).toHaveBeenCalledTimes(paints)
        expect(row.querySelector('[data-pdf-translated-page] canvas')).toBe(canvas)
        expect(row.style.gridTemplateColumns).toBe('minmax(0, 1fr)')
        await act(async () => {
          finishPaint()
          await flush()
        })
        expect(drawImage).toHaveBeenCalledTimes(paints + 1)
        expect(canvas.width).toBe(previousWidth)
      }
      await act(async () => {
        root.render(null)
        await flush()
      })
      expect(destroy).toHaveBeenCalledTimes(kind === 'retry' ? 2 : 1)
      expect(linkSignals.every((signal) => signal.aborted)).toBe(true)
    }
  )

  it.each([undefined, 'Arabic', 'Korean'])(
    'keeps saved %s paragraph translations readable without unsupported PDF generation',
    async (language) => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
      const generatePdf = vi.fn().mockResolvedValue(new Uint8Array([1]))
      if (language) {
        Object.assign(window.api, {
          pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) }
        })
        vi.spyOn(translationJobs, 'usePdfTranslationJob').mockReturnValue({
          state: {
            status: 'completed',
            done: 2,
            total: 2,
            options: { targetId: 'api', language, glossary: [] }
          },
          start: vi.fn(),
          restart: vi.fn(),
          retryUnit: vi.fn(),
          skipUnit: vi.fn(),
          cancel: vi.fn(),
          reset: vi.fn()
        })
      }
      vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
        promise: Promise.resolve({
          numPages: 2,
          fingerprints: ['fp'],
          ...(language ? { getData: vi.fn().mockResolvedValue(new Uint8Array([2])) } : {}),
          getPage,
          destroy: destroyDocument
        }),
        destroy: vi.fn().mockResolvedValue(undefined)
      } as never)
      const props = { path: 'compare.pdf', name: 'compare.pdf', source: 'local' as const }
      const units = [1, 2].map((pageNumber) => ({
        id: `p${pageNumber}`,
        source: 'Selectable text',
        translationSource: 'Selectable text',
        translation: `${language === 'Arabic' ? 'خلية' : language === 'Korean' ? '세포' : '译文'} ${pageNumber}`,
        fragments: [
          {
            pageNumber,
            rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
            items: [{ index: 0, text: 'Selectable text' }]
          }
        ]
      }))
      const source = createPdfTranslationSource({
        resourceRequestKey: `${createPreviewResourceKey(props)}:0`,
        fingerprint: 'fp',
        pages: [
          { width: 600, height: 800 },
          { width: 600, height: 800 }
        ],
        units
      })
      await act(async () => {
        root.render(<PdfPreviewContent {...props} translationSource={source} />)
        await flush()
      })
      const originalCanvas = container.querySelector('[data-page-number="1"] canvas')
      expect(originalCanvas).not.toBeNull()
      await act(async () => {
        root.render(
          <PdfPreviewContent
            {...props}
            translationSource={source}
            translation={{ source, units: language ? units : units.slice(0, 1) }}
          />
        )
        await flush()
      })
      expect(container.querySelector('[data-page-number="1"] canvas')).toBe(originalCanvas)
      await openReadingView()
      await act(async () => screen.getByRole('button', { name: 'Compare' }).click())
      const original = screen.getByRole('region', { name: 'compare.pdf scrollable preview' })
      expect(original.contains(screen.getByRole('group', { name: 'PDF rendition' }))).toBe(false)
      expect(
        screen
          .getByRole('group', { name: 'PDF view controls' })
          .contains(screen.getByRole('button', { name: 'Reading view' }))
      ).toBe(true)
      expect((screen.getByRole('button', { name: 'Compare' }) as HTMLButtonElement).disabled).toBe(
        true
      )
      expect(
        (screen.getByRole('button', { name: 'Translation' }) as HTMLButtonElement).disabled
      ).toBe(true)
      expect(container.querySelector('[data-pdf-translation-reader]')).toBeNull()
      expect(container.querySelector('[data-pdf-translated-page]')).toBeNull()
      await act(async () => screen.getByRole('button', { name: 'View translation' }).click())
      const sidebar = container.querySelector<HTMLElement>('[data-pdf-translation-sidebar]')!
      const translationToggle = within(sidebar).getByRole('button', { name: /^Translation\s*\d/ })
      expect(translationToggle.getAttribute('aria-pressed')).toBe('false')
      await act(async () => translationToggle.click())
      expect(within(sidebar).getByText(units[0].translation)).toBeTruthy()
      expect(generatePdf).not.toHaveBeenCalled()
      const renditionActions = within(sidebar).getByRole('group', { name: 'PDF rendition' })
      expect(
        (
          within(renditionActions).getByRole('button', {
            name: 'View translated PDF'
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true)
      const unavailableRendition = within(renditionActions).getByRole('button', {
        name: 'View translated PDF'
      })
      fireEvent.focus(unavailableRendition.parentElement!)
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          language
            ? 'PDF generation is unavailable for this language. Saved text translations remain available.'
            : 'Available when the translated PDF is ready.'
        )
      )
      await act(async () =>
        within(sidebar)
          .getByRole('button', { name: /Page 1/ })
          .click()
      )
      await openReadingView()
      expect(screen.getByRole('button', { name: 'Original' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
      expect(container.querySelector('[data-pdf-translation-reader]')).toBeNull()
    }
  )

  it.each([
    ['original', false],
    ['translated', false],
    ['compare', false],
    ['translated', true],
    ['compare', true]
  ] as const)(
    'preserves the translation list toggle and shows the PDF refresh from %s (source mismatch: %s)',
    async (rendition, sourceMismatch) => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
      const job = {
        state: { status: 'running' as const, done: 1, total: 4 },
        start: vi.fn(),
        restart: vi.fn(),
        retryUnit: vi.fn(),
        skipUnit: vi.fn(),
        cancel: vi.fn(),
        reset: vi.fn()
      }
      vi.spyOn(translationJobs, 'usePdfTranslationJob').mockReturnValue(job)
      const props = { path: 'progress.pdf', name: 'progress.pdf', source: 'local' as const }
      const units = [
        'First paragraph',
        'Second paragraph',
        'Third paragraph',
        'Fourth paragraph'
      ].map((text, index) => ({
        id: `p${index + 1}`,
        source: text,
        translationSource: text,
        translation: ['第一段', '第二段', '第三段', '第四段'][index],
        fragments: [
          {
            pageNumber: Math.floor(index / 2) + 1,
            rect: { x: 0.1, y: 0.1 + (index % 2) * 0.125, width: 0.8, height: 0.1 },
            items: [{ index: index % 2, text }]
          }
        ]
      }))
      const source = createPdfTranslationSource({
        resourceRequestKey: `${createPreviewResourceKey(props)}:0`,
        fingerprint: 'fp',
        pages: [
          { width: 600, height: 800 },
          { width: 600, height: 800 }
        ],
        units
      })
      const completedUnits = [[], [0, 1], [0, 1, 3], [0, 1, 2, 3]]
      const pageSnapshots = completedUnits.map((translatedIndices) =>
        [1, 2].map((pageNumber) => ({
          cleanup: vi.fn(),
          getViewport: ({ scale }: { scale: number }) => ({
            width: 600 * scale,
            height: 800 * scale,
            scale,
            rotation: 0,
            convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale]
          }),
          render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
          getTextContent: async () => ({
            items: units.slice((pageNumber - 1) * 2, pageNumber * 2).map((unit, index) => ({
              str: translatedIndices.includes((pageNumber - 1) * 2 + index)
                ? unit.translation
                : unit.source,
              width: 80,
              height: 10,
              transform: [10, 0, 0, 10, 60, 700 - index * 100]
            }))
          }),
          getAnnotations: async () => []
        }))
      )
      const originalPages = pageSnapshots[0]
      vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
        promise: Promise.resolve({
          numPages: 2,
          fingerprints: ['fp'],
          getData: async () => new Uint8Array([0]),
          getPage: async (number: number) => originalPages[number - 1],
          destroy: vi.fn(async () => {})
        }),
        destroy: vi.fn(async () => {})
      } as never)
      for (const pages of pageSnapshots.slice(1, sourceMismatch ? 3 : 4)) {
        vi.mocked(pdfjsLib.getDocument).mockReturnValueOnce({
          promise: Promise.resolve({
            numPages: 2,
            getPage: async (number: number) => pages[number - 1]
          }),
          destroy: vi.fn(async () => {})
        } as never)
      }
      let finishPdf!: () => void
      let failPdf!: (error: Error) => void
      const generatePdf = vi.fn(
        () =>
          new Promise<Uint8Array>((resolve, reject) => {
            finishPdf = () => resolve(new Uint8Array([generatePdf.mock.calls.length]))
            failPdf = reject
          })
      )
      Object.assign(window.api, {
        pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) }
      })
      const progress = async (count: number): Promise<void> => {
        await act(async () => {
          root.render(
            <PdfPreviewContent
              {...props}
              translationSource={source}
              translation={{
                source,
                units: count === 3 ? [units[0], units[1], units[3]] : units.slice(0, count)
              }}
            />
          )
          await flush()
        })
      }
      await progress(1)
      await act(async () => screen.getByRole('button', { name: 'Translating… 1/4' }).click())
      const sidebar = container.querySelector<HTMLElement>('[data-pdf-translation-sidebar]')!
      const translationToggle = (): HTMLElement =>
        within(sidebar).getByRole('button', { name: /^Translation\s*\d+$/ })
      expect(translationToggle().getAttribute('aria-pressed')).toBe('false')
      await act(async () => translationToggle().click())
      expect(within(sidebar).getByText('第一段')).toBeTruthy()
      await progress(2)
      expect(generatePdf).toHaveBeenCalledTimes(1)
      expect(within(sidebar).queryByText('Preparing translated PDF…')).toBeNull()
      expect(within(sidebar).queryByText('Checking translated PDF…')).toBeNull()
      expect(translationToggle().getAttribute('aria-pressed')).toBe('true')
      expect(within(sidebar).getByText('第一段')).toBeTruthy()
      await act(async () => {
        finishPdf()
        await flush()
      })
      await waitFor(() =>
        expect(
          (
            within(sidebar).getByRole('button', {
              name: 'View translated PDF'
            }) as HTMLButtonElement
          ).disabled
        ).toBe(false)
      )
      expect(translationToggle().getAttribute('aria-pressed')).toBe('true')
      expect(within(sidebar).getByText('第二段')).toBeTruthy()
      if (rendition !== 'original') {
        await act(async () =>
          within(sidebar)
            .getByRole('button', {
              name: rendition === 'compare' ? 'Compare PDFs' : 'View translated PDF'
            })
            .click()
        )
      }
      await progress(3)
      expect(translationToggle().getAttribute('aria-pressed')).toBe('true')
      expect(within(sidebar).getByText('Page 2 · #4')).toBeTruthy()
      expect(within(sidebar).queryByText('Page 2 · #3')).toBeNull()
      expect(generatePdf).toHaveBeenCalledTimes(1)
      if (rendition === 'original') {
        await act(async () => screen.getByRole('button', { name: 'Close translation' }).click())
      }
      await act(async () => screen.getByRole('button', { name: 'Update PDF preview' }).click())
      expect(generatePdf).toHaveBeenCalledTimes(2)
      const row = container.querySelector<HTMLElement>('[data-page-number="1"]')!
      expect(row.querySelector('[data-pdf-translated-page]')).not.toBeNull()
      expect(row.style.gridTemplateColumns).toBe(
        rendition === 'compare' ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)'
      )
      expect(
        screen.getByRole('button', { name: 'Update PDF preview' }).getAttribute('aria-busy')
      ).toBe('true')
      await act(async () => screen.getByRole('button', { name: 'Update PDF preview' }).click())
      expect(generatePdf).toHaveBeenCalledTimes(2)
      await act(async () => {
        finishPdf()
        await flush()
      })
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Update PDF preview' })).toBeNull()
      )
      if (rendition === 'original') {
        await act(async () => screen.getByRole('button', { name: 'Translating… 1/4' }).click())
      }
      expect(
        within(sidebar)
          .getByRole('button', {
            name: rendition === 'compare' ? 'Compare PDFs' : 'View translated PDF'
          })
          .getAttribute('aria-pressed')
      ).toBe('true')
      expect(translationToggle().getAttribute('aria-pressed')).toBe('true')
      expect(within(sidebar).getByText('第四段')).toBeTruthy()
      await act(async () => translationToggle().click())
      const displayedPage = row.querySelector('[data-pdf-translated-page]')
      expect(displayedPage).not.toBeNull()
      // A slower parallel result fills an earlier gap. Keep the current PDF and
      // rendition visible throughout the resulting automatic page refresh.
      await progress(4)
      await waitFor(() => expect(generatePdf).toHaveBeenCalledTimes(3))
      expect(row.querySelector('[data-pdf-translated-page]')).toBe(displayedPage)
      expect(displayedPage?.isConnected).toBe(true)
      expect(
        within(sidebar)
          .getByRole('button', {
            name: rendition === 'compare' ? 'Compare PDFs' : 'View translated PDF'
          })
          .getAttribute('aria-pressed')
      ).toBe('true')
      expect(
        within(sidebar).getByRole('button', { name: 'Original PDF' }).getAttribute('aria-pressed')
      ).toBe('false')
      if (sourceMismatch) {
        await act(async () => {
          failPdf(new PdfGenerationError({ code: 'source-mismatch', pageNumber: 2 }))
          await flush()
        })
        await waitFor(() =>
          expect(within(sidebar).getByText('Could not prepare translated PDF')).toBeTruthy()
        )
        expect(row.querySelector('[data-pdf-translated-page]')).toBe(displayedPage)
        for (const name of ['Original PDF', 'View translated PDF', 'Compare PDFs']) {
          const button = within(sidebar).getByRole<HTMLButtonElement>('button', { name })
          expect(button.disabled).toBe(false)
          await act(async () => button.click())
          expect(button.getAttribute('aria-pressed')).toBe('true')
        }
        expect(row.querySelector('[data-pdf-translated-page]')).not.toBeNull()
        expect(row.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
        expect(generatePdf).toHaveBeenCalledTimes(3)
        expect(translationToggle().getAttribute('aria-pressed')).toBe('false')
        await act(async () => translationToggle().click())
        expect(within(sidebar).getByText('第三段')).toBeTruthy()
        return
      }
      await act(async () => {
        finishPdf()
        await flush()
      })
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Update PDF preview' })).toBeNull()
      )
      expect(translationToggle().getAttribute('aria-pressed')).toBe('false')
    }
  )

  it('keeps source coverage accessible after a prepared document is translated', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
    const page = await (
      getPage as () => Promise<{
        getViewport: ReturnType<typeof vi.fn>
        getTextContent: ReturnType<typeof vi.fn>
        rotate: number
      }>
    )()
    page.getViewport.mockReturnValue({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] })
    page.rotate = 0
    page.getTextContent.mockResolvedValue({
      items: [
        {
          str: 'Selectable text',
          transform: [12, 0, 0, 12, 60, 700],
          width: 100,
          height: 12,
          dir: 'ltr'
        }
      ],
      styles: {}
    })
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        fingerprints: ['fp'],
        getPage,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    const executor = {
      targets: [{ id: 'test', label: 'Test model', mode: 'agent' as const }],
      translate: vi.fn(async () => 'Translated paragraph')
    }
    await act(async () => {
      root.render(
        <PdfPreviewContent path="coverage.pdf" name="coverage.pdf" translationExecutor={executor} />
      )
      await flush()
    })
    await act(async () => screen.getByRole('button', { name: 'Full-text translation' }).click())
    await act(async () => {
      screen.getByRole('button', { name: 'Prepare full text' }).click()
      await flush()
    })
    await waitFor(() => expect(screen.getByText('Full text prepared')).toBeTruthy())
    await act(async () =>
      fireEvent.keyDown(screen.getByRole('combobox', { name: 'Translation method' }), {
        key: 'ArrowDown'
      })
    )
    await act(async () => fireEvent.click(screen.getByRole('option', { name: 'Test model' })))
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Target language'), { target: { value: 'French' } })
    )
    await act(async () => {
      screen.getByRole('button', { name: 'Translate document' }).click()
      await flush()
    })
    await openReadingView()
    expect(screen.queryByText('Full text prepared')).toBeNull()
    await act(async () => screen.getByRole('button', { name: 'Close translation' }).click())
    await act(async () => screen.getByRole('button', { name: 'View translation' }).click())
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(screen.queryByRole('textbox', { name: 'Search translation' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View translation' }))
    expect(screen.queryByText('Full-text preparation')).toBeNull()
    const setupToggle = screen.getByRole('button', { name: 'Translation settings' })
    expect(setupToggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => setupToggle.click())
    expect(setupToggle.getAttribute('aria-expanded')).toBe('true')
    await act(async () => screen.getByText('Full-text preparation').closest('button')?.click())
    const preparationInfo = screen.getByRole('button', { name: 'More information' })
    await act(async () => fireEvent.focus(preparationInfo))
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        'This report checks source coverage, not translation completeness or accuracy.'
      )
    )
    const translationToggle = screen
      .getAllByRole('button', { name: /^Translation/ })
      .find((button) => button.hasAttribute('aria-pressed'))
    expect(translationToggle).toBeTruthy()
    await act(async () => fireEvent.click(translationToggle!))

    await act(async () => screen.getByRole('button', { name: 'Search translation' }).click())
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Search translation'), {
        target: { value: 'Translated paragraph' }
      })
    )
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    const paragraph = screen.getByRole('button', { name: /Page 1 · #1\s*Translated paragraph/ })
    await act(async () => {
      paragraph.focus()
      paragraph.click()
    })
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(paragraph.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(paragraph)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    await act(async () => paragraph.click())
    expect(paragraph.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(paragraph)
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Search translation'), {
        target: { value: 'previous translation only' }
      })
    )
    expect(screen.getByText('No translation matches')).toBeTruthy()
    await act(async () => screen.getByRole('button', { name: 'New translation' }).click())
    expect(screen.getByRole('dialog').textContent).toContain('Target language')
    expect((screen.getByRole('dialog').querySelector('input') as HTMLInputElement).value).toBe(
      'French'
    )
    expect(executor.translate).toHaveBeenCalledTimes(1)
    await act(async () => screen.getByRole('button', { name: 'Cancel' }).click())
    expect(screen.getByText('No translation matches')).toBeTruthy()
    expect(executor.translate).toHaveBeenCalledTimes(1)
    await act(async () => screen.getByRole('button', { name: 'New translation' }).click())
    await act(async () => {
      screen.getByRole('button', { name: 'Translate document' }).click()
      await flush()
    })
    expect(executor.translate).toHaveBeenCalledTimes(2)
    await act(async () => screen.getByRole('button', { name: 'Search translation' }).click())
    await waitFor(() => expect(screen.getByLabelText('Search translation')).toBeTruthy())
    expect((screen.getByLabelText('Search translation') as HTMLInputElement).value).toBe('')
    const restoredTranslationToggle = screen
      .getAllByRole('button', { name: /^Translation/ })
      .find((button) => button.hasAttribute('aria-pressed'))
    expect(restoredTranslationToggle).toBeTruthy()
    if (restoredTranslationToggle!.getAttribute('aria-pressed') === 'false') {
      await act(async () => fireEvent.click(restoredTranslationToggle!))
    }
    expect(
      screen
        .getByRole('button', { name: /Page 1 · #1\s*Translated paragraph/ })
        .getAttribute('aria-pressed')
    ).toBe('false')
    await openReadingView()
    expect(screen.getByRole('button', { name: 'Original' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(executor.translate).toHaveBeenCalledTimes(2)
  })

  it('separates translation from navigation, retains draft settings, and shares the notes space', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
    const executor = {
      targets: [{ id: 'agent', label: 'Agent', mode: 'agent' as const }],
      translate: vi.fn()
    }
    await act(async () => {
      root.render(
        <PdfPreviewContent
          path="literature-attachment-version:version-1"
          name="paper.pdf"
          source="literature"
          translationExecutor={executor}
        />
      )
      await flush()
    })
    const entry = screen.getByRole('button', { name: 'Full-text translation' })
    const panel = container.querySelector<HTMLElement>('[data-pdf-translation-sidebar]')!
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    expect(panel.dataset.state).toBe('closed')
    await act(async () => screen.getByRole('button', { name: 'Show navigation' }).click())
    const navigation = container.querySelector('#pdf-navigation-sidebar')!
    expect(navigation.textContent).not.toContain('Translation')
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    await act(async () => entry.click())
    expect(panel.getAttribute('aria-hidden')).toBe('false')
    expect(panel.dataset.state).toBe('open')
    expect(panel.className).toContain('transition-[opacity,transform]')
    expect(panel.hasAttribute('data-preview-escape-boundary')).toBe(true)
    expect(navigation).toBe(container.querySelector('#pdf-navigation-sidebar'))
    expect(container.querySelector<HTMLElement>('[data-pdf-original-view]')!.style.right).toBe(
      '320px'
    )
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Target language'), { target: { value: 'Chinese' } })
    )
    await act(async () =>
      fireEvent.click(screen.getByText('Translation glossary', { selector: 'button' }))
    )
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add term' })))
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Source term 1'), { target: { value: 'cell' } })
    )
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Preferred translation 1'), {
        target: { value: '细胞' }
      })
    )
    await act(async () =>
      fireEvent.keyDown(screen.getByLabelText('Source term 1'), { key: 'Escape' })
    )
    expect(document.activeElement).toBe(entry)
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    await act(async () => entry.click())
    expect((screen.getByLabelText('Target language') as HTMLInputElement).value).toBe('Chinese')
    expect((screen.getByLabelText('Source term 1') as HTMLInputElement).value).toBe('cell')
    expect((screen.getByLabelText('Preferred translation 1') as HTMLInputElement).value).toBe(
      '细胞'
    )
    await act(async () => screen.getByRole('button', { name: 'Show notes sidebar' }).click())
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    const notesPanel = container.querySelector<HTMLElement>('[data-pdf-notes-sidebar]')!
    expect(notesPanel.style.width).toBe(panel.style.width)
    await act(async () =>
      fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize notes sidebar' }), {
        key: 'ArrowLeft'
      })
    )
    expect(notesPanel.style.width).toBe('336px')
    await act(async () => entry.click())
    expect(panel.style.width).toBe('336px')
    expect(container.querySelector<HTMLElement>('[data-pdf-original-view]')!.style.right).toBe(
      panel.style.width
    )
    expect(panel.getAttribute('aria-hidden')).toBe('false')
    expect(container.querySelector('[data-pdf-notes-sidebar]')).toBeNull()
    await act(async () => screen.getByRole('button', { name: 'Translation settings' }).click())
    await act(async () => screen.getByRole('button', { name: 'Close translation' }).click())
    await act(async () => entry.click())
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(document.activeElement).toBe(entry)
    expect(screen.queryByRole('textbox', { name: 'Search translation' })).toBeNull()
    expect(executor.translate).not.toHaveBeenCalled()
    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
  })

  it.each([320, 375, 414, 768])(
    'shows only one contextual sidebar at reader width %s',
    async (width) => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
      await act(async () => {
        root.render(
          <PdfPreviewContent
            path="literature-attachment-version:version-1"
            name="paper.pdf"
            source="literature"
          />
        )
        await flush()
      })
      await act(async () => screen.getByRole('button', { name: 'Show navigation' }).click())
      expect(container.querySelector('#pdf-navigation-sidebar')).not.toBeNull()
      await act(async () => screen.getByRole('button', { name: 'Full-text translation' }).click())
      expect(container.querySelector('#pdf-navigation-sidebar')).toBeNull()
      const panel = container.querySelector('[data-pdf-translation-sidebar]')!
      expect(panel.getAttribute('aria-hidden')).toBe('false')
      expect(container.querySelector<HTMLElement>('[data-pdf-original-view]')!.style.right).toBe('')
      await act(async () => screen.getByRole('button', { name: 'Show navigation' }).click())
      expect(panel.getAttribute('aria-hidden')).toBe('true')
      expect(container.querySelector('#pdf-navigation-sidebar')).not.toBeNull()
      expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
    }
  )

  it('floats notes in narrow readers and preserves the notebook and docked width across resizing', async () => {
    let width = 1200
    const callbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback)
        }
        observe = vi.fn()
        disconnect = vi.fn()
        unobserve = vi.fn()
      }
    )
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
    await act(async () => {
      root.render(
        <PdfPreviewContent
          path="literature-attachment-version:version-1"
          name="paper.pdf"
          source="literature"
        />
      )
      await flush()
    })
    const button = await vi.waitFor(() => {
      const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Show notes sidebar"]')
      expect(toggle).not.toBeNull()
      return toggle!
    })
    const notebook = container.querySelector('[data-pdf-notebook-view]')!
    const loadCount = vi.mocked(createManagedPdfLoadingTask).mock.calls.length
    await act(async () => button.click())
    const navigationToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Show navigation"]'
    )!
    expect(navigationToggle.closest('[role="tablist"]')).not.toBeNull()
    expect(navigationToggle.closest('[data-pdf-controls="interaction"]')).toBeNull()
    expect(notebook.getAttribute('data-pdf-notes-sidebar')).toBe('true')
    expect(notebook.getAttribute('tabindex')).toBe('-1')
    expect(notebook.getAttribute('aria-hidden')).toBe('false')
    expect(container.querySelector<HTMLElement>('[data-pdf-original-view]')!.style.right).toBe(
      '320px'
    )
    const separator = container.querySelector<HTMLElement>('[aria-label="Resize notes sidebar"]')!
    await act(async () =>
      separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    )
    expect(separator.getAttribute('aria-valuenow')).toBe('336')
    const resize = async (next: number): Promise<void> => {
      width = next
      await act(async () => {
        callbacks.forEach((callback) => callback([], {} as ResizeObserver))
        await flush()
      })
    }
    await resize(1119)
    expect(notebook.hasAttribute('inert')).toBe(false)
    expect(container.querySelector<HTMLElement>('[data-pdf-original-view]')!.style.right).toBe('')
    expect((notebook as HTMLElement).style.width).toBe('320px')
    expect(container.querySelector('[aria-label="Resize notes sidebar"]')).toBeNull()
    await resize(280)
    expect((notebook as HTMLElement).style.width).toBe('264px')
    const narrowToggle = container.querySelector<HTMLButtonElement>(
      '[role="tablist"] [aria-label="Hide notes sidebar"]'
    )!
    await act(async () => narrowToggle.click())
    expect(notebook.hasAttribute('inert')).toBe(true)
    await act(async () => narrowToggle.click())
    expect(notebook.hasAttribute('inert')).toBe(false)
    expect(container.querySelector('[data-preview-escape-boundary]')).not.toBeNull()
    await act(async () =>
      notebook.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(notebook.hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe(narrowToggle)
    expect(container.querySelector('[data-preview-escape-boundary]')).toBeNull()
    await act(async () => narrowToggle.click())
    await resize(1120)
    expect(container.querySelector('[aria-label="Resize notes sidebar"]')).not.toBeNull()
    expect((notebook as HTMLElement).style.width).toBe('336px')
    expect(container.querySelector<HTMLElement>('[data-pdf-original-view]')!.style.right).toBe(
      '336px'
    )
    expect(notebook.getAttribute('data-pdf-notes-sidebar')).toBe('true')
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')!.click()
    )
    expect(notebook.getAttribute('data-pdf-notes-sidebar')).toBe('true')
    expect(notebook.hasAttribute('inert')).toBe(false)
    const toggleWithNavigation = container.querySelector<HTMLButtonElement>(
      '[role="tablist"] [aria-label="Hide notes sidebar"]'
    )!
    expect(toggleWithNavigation.getAttribute('aria-disabled')).not.toBe('true')
    await act(async () => toggleWithNavigation.click())
    expect(notebook.hasAttribute('inert')).toBe(true)
    await act(async () => toggleWithNavigation.click())
    expect(notebook.getAttribute('data-pdf-notes-sidebar')).toBe('true')
    await resize(1480)
    expect(notebook.getAttribute('data-pdf-notes-sidebar')).toBe('true')
    expect(container.querySelectorAll('[data-pdf-notebook-view]')).toHaveLength(1)
    expect(container.querySelector('[data-pdf-notebook-view]')).toBe(notebook)
    expect(createManagedPdfLoadingTask).toHaveBeenCalledTimes(loadCount)
    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
    expect(destroyDocument).not.toHaveBeenCalled()
  })

  it('keeps notes docked at the default application modal width', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1150)
    await act(async () => {
      root.render(
        <div data-slot="file-preview-dialog">
          <PdfPreviewContent
            path="literature-attachment-version:version-1"
            name="paper.pdf"
            source="literature"
          />
        </div>
      )
      await flush()
    })
    await act(async () => screen.getByRole('button', { name: 'Show notes sidebar' }).click())
    const notes = container.querySelector<HTMLElement>('[data-pdf-notes-sidebar]')!
    expect(notes.style.width).toBe('320px')
    expect(container.querySelector<HTMLElement>('[data-pdf-original-view]')!.style.right).toBe(
      '320px'
    )
    expect(screen.getByRole('separator', { name: 'Resize notes sidebar' })).not.toBeNull()
    expect(container.querySelector('[data-preview-escape-boundary]')).toBeNull()
  })

  it('switches Literature reading modes without releasing or resetting the original PDF', async () => {
    window.api.pdfStructure = {
      readCached: vi.fn().mockResolvedValue(undefined),
      parse: vi.fn(() => new Promise(() => {})),
      cancel: vi.fn().mockResolvedValue(undefined)
    } as unknown as Window['api']['pdfStructure']
    window.api.localModels = {
      getSnapshot: vi.fn().mockResolvedValue({
        availability: 'ready',
        installedRevision: 'v1',
        updateAvailable: false
      })
    } as unknown as Window['api']['localModels']
    await act(async () =>
      root.render(
        <PdfPreviewContent
          path="literature-attachment-version:version-1"
          name="paper.pdf"
          source="literature"
          annotationProps={{
            item: {
              id: 'literature:version-1',
              sessionId: 'literature-library',
              type: 'file',
              format: 'pdf',
              source: 'literature',
              path: 'literature-attachment-version:version-1',
              name: 'paper.pdf',
              title: 'paper.pdf'
            }
          }}
        />
      )
    )
    const original = container.querySelector<HTMLElement>('[data-pdf-original-view]')!
    const scroller = original.querySelector<HTMLElement>('[role="region"]')!
    // Only the real PDF scroller is a keyboard stop, not its structural tab wrapper.
    expect(original.tabIndex).toBe(-1)
    expect(scroller.tabIndex).toBe(0)
    scroller.scrollTop = 275
    const clickMode = async (label: string): Promise<void> => {
      const button = [...container.querySelectorAll('button')].find(
        (node) => node.textContent === label
      )!
      await act(async () =>
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      )
    }
    await clickMode('Figures & Tables')
    const activeTab = container.querySelector('[role="tab"][aria-selected="true"]')!
    expect(activeTab.textContent).toBe('Figures & Tables')
    expect(container.querySelector('[data-pdf-figures-view]')?.id).toBe(
      activeTab.getAttribute('aria-controls')
    )
    expect(original.getAttribute('aria-hidden')).toBe('true')
    expect(original.hasAttribute('inert')).toBe(true)
    expect(container.querySelector('[data-pdf-figures-view]')?.getAttribute('tabindex')).toBe('-1')
    const figures = container.querySelector('[data-pdf-figures-content]')
    expect(figures).not.toBeNull()
    await act(async () => {
      ;[...container.querySelectorAll('button')]
        .find((node) => node.textContent === 'Analyze PDF')!
        .click()
    })
    expect(activeTab.querySelector('[role="status"]')).not.toBeNull()
    await clickMode('Original PDF')
    expect(activeTab.querySelector('[role="status"]')).not.toBeNull()
    expect(window.api.pdfStructure.cancel).not.toHaveBeenCalled()
    expect(container.querySelector('[data-pdf-original-view]')).toBe(original)
    expect(scroller.scrollTop).toBe(275)
    expect(original.hasAttribute('inert')).toBe(false)
    await clickMode('Figures & Tables')
    expect(container.querySelector('[data-pdf-figures-content]')).toBe(figures)
    await act(async () => {
      ;[...container.querySelectorAll('button')]
        .find((node) => node.textContent === 'Cancel')!
        .click()
    })
    expect(activeTab.querySelector('[role="status"]')).toBeNull()
    await act(async () =>
      document.dispatchEvent(
        new CustomEvent('pdf-reading-reveal', {
          detail: { path: 'literature-attachment-version:version-1', pageNumber: 1 }
        })
      )
    )
    expect(original.getAttribute('aria-hidden')).toBe('false')
    await clickMode('Figures & Tables')
    await act(async () =>
      document.dispatchEvent(
        new CustomEvent('annotation-reveal-prepare', {
          detail: {
            kind: 'pdf',
            source: { path: 'literature-attachment-version:version-1' },
            selector: { pageNumber: 1 }
          }
        })
      )
    )
    expect(original.getAttribute('aria-hidden')).toBe('false')
    await clickMode('Figures & Tables')
    expect(window.api.previewResources.acquire).toHaveBeenCalledOnce()
    expect(window.api.previewResources.release).not.toHaveBeenCalled()
    await act(async () =>
      root.render(<PdfPreviewContent path="/workspace/other.pdf" name="other.pdf" source="local" />)
    )
    expect(container.querySelector('[data-pdf-figures-content]')).toBeNull()
    expect(container.querySelector('[data-pdf-original-view]')?.getAttribute('aria-hidden')).toBe(
      'false'
    )
  })

  it('renders through the managed range resource and releases it on unmount', async () => {
    await act(async () => {
      root.render(
        <PdfPreviewContent
          path="artifact-version:version-1"
          name="report.pdf"
          source="artifact"
          projectId="project-1"
          sessionId="session-1"
          managedFileId="artifact-1"
        />
      )
    })
    await act(async () => {
      await vi.waitFor(() => expect(createManagedPdfLoadingTask).toHaveBeenCalled())
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1'
    })
    expect(createManagedPdfLoadingTask).toHaveBeenCalledWith(
      expect.objectContaining({ size: 80 * 1024 * 1024 })
    )
    expect(container.querySelector('canvas')).not.toBeNull()
    await vi.waitFor(() => expect(renderTextLayer).toHaveBeenCalled())
    expect(container.querySelector('[data-pdf-text-layer]')?.textContent).toBe('Selectable text')
    const textLayer = container.querySelector('[data-pdf-text-layer]')
    expect(textLayer?.classList.contains('textLayer')).toBe(true)
    expect(textLayer?.classList.contains('pdf-text-layer')).toBe(true)
    expect(container.querySelector('[data-pdf-text-layer] .endOfContent')).not.toBeNull()

    await act(async () => root.unmount())
    expect(window.api.previewResources.release).toHaveBeenCalledWith({ resourceId: 'resource-1' })
    expect(destroyDocument).toHaveBeenCalled()
    expect(destroyDocument.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(window.api.previewResources.release).mock.invocationCallOrder[0] as number
    )
  })

  it('W01 reloads revoked PDF ranges while retaining zoom, position and the selected version', async () => {
    document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    const freshAcquire =
      Promise.withResolvers<Awaited<ReturnType<Window['api']['previewResources']['acquire']>>>()
    const resource = {
      id: 'resource-1',
      url: '/preview/resource-1',
      size: 3,
      mimeType: 'application/pdf',
      version: 1
    }
    vi.mocked(window.api.previewResources.acquire)
      .mockReset()
      .mockResolvedValueOnce(resource)
      .mockReturnValueOnce(freshAcquire.promise)
    const active = new Set(['resource-1'])
    vi.mocked(window.api.previewResources.readRange).mockImplementation(async ({ resourceId }) => {
      if (!active.has(resourceId)) throw new Error('Revoked PDF resource')
      return { begin: 0, end: 3, total: 3, data: new Uint8Array([1, 2, 3]) }
    })
    vi.mocked(createManagedPdfLoadingTask).mockImplementation(
      (capability) =>
        ({
          promise: Promise.resolve({
            numPages: 3,
            destroy: destroyDocument,
            getOutline: async () =>
              capability.id === 'resource-1'
                ? [
                    { title: 'Old section', dest: [0], items: [] },
                    { title: 'Old later section', dest: [0], items: [] }
                  ]
                : [
                    { title: 'New section', dest: [0], items: [] },
                    { title: 'New later section', dest: [2], items: [] }
                  ],
            getPage: async () => {
              await window.api.previewResources.readRange({
                resourceId: capability.id,
                begin: 0,
                end: 3
              })
              return {
                getViewport: ({ scale }: { scale: number }) => ({
                  width: 400 * scale,
                  height: 560 * scale
                }),
                getTextContent: async () => ({
                  items: [{ str: `Text from ${capability.id}` }],
                  styles: {}
                }),
                render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
                cleanup: vi.fn()
              }
            }
          }),
          destroy: vi.fn().mockResolvedValue(undefined)
        }) as never
    )
    const phase = (value: string): void => {
      window.dispatchEvent(
        new CustomEvent(WEB_EVENT_CONNECTION_STATE_EVENT, { detail: { phase: value } })
      )
    }
    try {
      await act(async () =>
        root.render(
          <PdfPreviewContent
            path="/report.pdf"
            name="report.pdf"
            source="artifact"
            projectId="project-1"
            managedFileId="file-1"
            selectedVersionId="version-1"
          />
        )
      )
      await act(async () => phase('live'))
      await act(async () => {
        const navigation = await vi.waitFor(() =>
          container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')
        )
        navigation?.click()
      })
      await act(async () => screen.getByRole('treeitem', { name: 'Old later section' }).click())
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      )
      expect(container.textContent).toContain('125%')
      const scroll = container.querySelector<HTMLElement>('[role="region"]')!
      scroll.scrollTop = 700
      scroll.scrollLeft = 50
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        if (this === scroll)
          return { left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600 } as DOMRect
        if (this.dataset.pageNumber) {
          const width = Number.parseFloat(this.style.width)
          const height = width * 1.4
          const top = 16 + (Number(this.dataset.pageNumber) - 1) * (height + 12) - scroll.scrollTop
          return {
            left: 16 - scroll.scrollLeft,
            top,
            right: 16 - scroll.scrollLeft + width,
            bottom: top + height,
            width,
            height
          } as DOMRect
        }
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect
      })
      active.clear()
      await act(async () => phase('reconnecting'))
      await act(async () => phase('replaying'))
      await act(async () => phase('live'))
      expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(2)
      expect(container.querySelector('canvas')).toBeNull()
      // Browsers clamp the scroller when old pages disappear during the new acquisition.
      scroll.scrollTop = 0
      scroll.scrollLeft = 0
      active.add('resource-2')
      await act(async () => freshAcquire.resolve({ ...resource, id: 'resource-2' }))
      expect(container.querySelector('[data-pdf-text-layer]')?.textContent).toContain(
        'Text from resource-2'
      )
      expect(
        screen.getByRole('treeitem', { name: 'New section' }).getAttribute('aria-selected')
      ).toBe('true')
      expect(
        screen.getByRole('treeitem', { name: 'New later section' }).getAttribute('aria-selected')
      ).toBe('false')
      expect(window.api.previewResources.acquire).toHaveBeenLastCalledWith({
        source: 'artifact',
        projectId: 'project-1',
        fileId: 'file-1',
        versionId: 'version-1'
      })
      expect(container.textContent).toContain('125%')
      expect(scroll.scrollTop).toBe(700)
      expect(scroll.scrollLeft).toBe(50)
      expect(destroyDocument).toHaveBeenCalled()
      expect(window.api.previewResources.release).toHaveBeenCalledWith({ resourceId: 'resource-1' })
    } finally {
      document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
      freshAcquire.resolve({ ...resource, id: 'resource-2' })
    }
  })

  it('keeps the PDF resource and zoom while the conversation Session binds', async () => {
    window.api.pdfAnnotations = {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 })
    } as unknown as Window['api']['pdfAnnotations']
    const render = async (sessionId?: string): Promise<void> => {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <PdfAnnotationsProvider
              projectId={sessionId ? 'project-1' : undefined}
              sessionId={sessionId}
              loadAnnotations={false}
            >
              <PdfPreviewRenderer
                item={{
                  id: 'upload-1',
                  projectId: 'project-1',
                  sessionId: 'creator',
                  title: 'paper.pdf',
                  type: 'file',
                  source: 'upload',
                  path: 'upload-version:version-1',
                  name: 'paper.pdf',
                  format: 'pdf',
                  managedFileId: 'upload-1',
                  selectedVersionId: 'version-1'
                }}
              />
            </PdfAnnotationsProvider>
          </TooltipProvider>
        )
        await flush()
      })
    }
    await render()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Zoom in' })))
    expect(container.textContent).toContain('125%')
    const scroll = screen.getByLabelText('paper.pdf scrollable preview')
    const loads = vi.mocked(createManagedPdfLoadingTask).mock.calls.length
    await render('pending-session')
    await render('bound-session')
    expect(container.textContent).toContain('125%')
    expect(screen.getByLabelText('paper.pdf scrollable preview')).toBe(scroll)
    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
    expect(createManagedPdfLoadingTask).toHaveBeenCalledTimes(loads)
    expect(destroyDocument).not.toHaveBeenCalled()
    expect(window.api.previewResources.release).not.toHaveBeenCalled()
  })

  it.each([
    ['upload', false],
    ['artifact', false],
    ['upload', true],
    ['artifact', true]
  ] as const)(
    'shows package %s PDF snapshots without live notes or mutation controls (receipt only: %s)',
    async (sourceKind, receiptOnly) => {
      const setValue = vi.fn()
      vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
        promise: Promise.resolve({
          numPages: 1,
          getPage,
          destroy: destroyDocument,
          annotationStorage: { setValue }
        }),
        destroy: vi.fn().mockResolvedValue(undefined)
      } as never)
      const annotation: SavedPdfAnnotation = {
        id: 'package-note',
        projectId: 'project-1',
        version: 1,
        origin: 'user',
        kind: 'page-note',
        tagIds: [],
        note: 'Packaged evidence',
        createdAt: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z',
        target: {
          source: {
            kind: sourceKind === 'upload' ? 'upload-version' : 'artifact-version',
            projectId: 'project-1',
            sessionId: 'package-session',
            sourceFileId: 'file-1',
            versionId: 'version-1',
            name: 'paper.pdf',
            path: `${sourceKind}-version:version-1`,
            checksum: 'a'.repeat(64)
          },
          selector: { kind: 'page-note', pageNumber: 1, pageRotation: 0, coordinateVersion: 1 }
        }
      }
      let resolveNotes!: (value: PdfAnnotationListResult) => void
      const list = vi.fn<Window['api']['pdfAnnotations']['list']>(
        () =>
          new Promise((resolve) => {
            resolveNotes = resolve
          })
      )
      const resolvePdfSource = vi.fn()
      window.api = {
        ...window.api,
        pdfAnnotations: { list },
        bookmarks: { resolvePdfSource },
        tags: { snapshot: vi.fn().mockResolvedValue({ revision: 0, tags: [], assignments: [] }) }
      } as unknown as Window['api']
      useSessionStore.setState({
        selectedSessionId: 'package-session',
        sessions: [{ id: 'package-session', projectId: 'project-1', packageOrigin: {} }] as never
      })
      await act(async () => {
        root.render(
          <TooltipProvider>
            <PdfAnnotationsProvider writable={false} loadAnnotations={false}>
              <PdfPreviewRenderer
                item={{
                  id: 'file-1',
                  projectId: 'project-1',
                  sessionId: 'package-session',
                  title: 'paper.pdf',
                  name: 'paper.pdf',
                  type: 'file',
                  format: 'pdf',
                  source: sourceKind,
                  path: annotation.target.source.path,
                  managedFileId: 'file-1',
                  selectedVersionId: 'version-1'
                }}
              />
            </PdfAnnotationsProvider>
          </TooltipProvider>
        )
        await flush()
      })
      expect(list).toHaveBeenCalledTimes(1)
      expect(list).toHaveBeenCalledWith({
        projectId: 'project-1',
        sessionId: 'package-session',
        sourceFileId: 'file-1',
        versionId: 'version-1',
        limit: 100,
        cursor: undefined
      })
      const expectReadOnly = (): void => {
        expect(
          screen
            .getByRole('button', { name: 'Annotate selected text' })
            .getAttribute('aria-disabled')
        ).toBe('true')
        expect(screen.queryByRole('button', { name: 'Select area to annotate' })).toBeNull()
      }
      expectReadOnly()
      await act(async () => {
        const result: PdfAnnotationListResult = {
          items: receiptOnly ? [] : [annotation],
          total: receiptOnly ? 0 : 1,
          readOnly: true,
          readonlyIds: receiptOnly ? [] : [annotation.id],
          source: annotation.target.source,
          nativeImport: {
            nativeRefs: [{ id: '12R', pageNumber: 1 }],
            pageCount: 1,
            unsupportedCount: 0,
            truncated: false
          }
        }
        list.mockResolvedValue(result)
        resolveNotes(result)
        await flush()
      })
      expectReadOnly()
      await act(async () =>
        fireEvent.mouseDown(screen.getByRole('tab', { name: 'Notes & Annotations' }), {
          button: 0,
          ctrlKey: false
        })
      )
      expect(setValue).toHaveBeenCalledWith('12R', { noView: true })
      if (!receiptOnly) {
        expect(container.querySelector('[data-pdf-notebook-view]')?.textContent).toContain(
          'Packaged evidence'
        )
        expect(
          screen.getByRole('button', { name: 'Edit annotation note' }).hasAttribute('disabled')
        ).toBe(true)
        expect(
          screen.getByRole('button', { name: 'Delete annotation' }).hasAttribute('disabled')
        ).toBe(true)
      } else {
        expect(screen.queryByRole('button', { name: 'Edit annotation note' })).toBeNull()
      }
      expect(container.textContent).not.toContain(
        'PDF annotations are unavailable for this source.'
      )
      expect(resolvePdfSource).not.toHaveBeenCalled()
      for (const [request] of list.mock.calls)
        expect(request).toMatchObject({
          projectId: 'project-1',
          sessionId: 'package-session',
          sourceFileId: 'file-1',
          versionId: 'version-1'
        })
    }
  )

  it.each([undefined, 'artifact'] as const)(
    'opens read-only replay PDF versions without writable annotation/bookmark access (source: %s)',
    async (source) => {
      const list = vi.fn()
      const resolveSource = vi.fn()
      window.api.pdfAnnotations = { list } as never
      window.api.bookmarks = { resolveSource } as never
      useSessionStore.setState({
        selectedSessionId: 'discussion',
        sessions: [{ id: 'discussion', projectId: 'project-1' }] as never
      })
      await act(async () => {
        root.render(
          <PdfPreviewRenderer
            readOnly
            item={{
              id: 'recorded-pdf',
              projectId: 'project-1',
              sessionId: 'creator',
              title: 'report.pdf',
              name: 'report.pdf',
              type: 'file',
              format: 'pdf',
              source,
              path: 'artifact-version:historical',
              managedFileId: 'artifact-1',
              selectedVersionId: 'historical'
            }}
          />
        )
        await flush()
      })
      await vi.waitFor(() =>
        expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
          source: 'artifact',
          projectId: 'project-1',
          fileId: 'artifact-1',
          versionId: 'historical'
        })
      )
      expect(list).not.toHaveBeenCalled()
      expect(resolveSource).not.toHaveBeenCalled()
      await act(async () => root.render(null))
      expect(window.api.previewResources.release).toHaveBeenCalled()
    }
  )

  it('acquires the exact managed Artifact version selected by the preview item', async () => {
    await act(async () => {
      root.render(
        <PdfPreviewRenderer
          item={{
            id: 'artifact-1',
            projectId: 'project-1',
            sessionId: 'session-1',
            title: 'report.pdf',
            type: 'file',
            source: 'artifact',
            path: 'artifact-version:stale-projection',
            name: 'report.pdf',
            format: 'pdf',
            managedFileId: 'artifact-1',
            selectedVersionId: 'artifact-v2'
          }}
        />
      )
    })

    await vi.waitFor(() =>
      expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
        source: 'artifact',
        projectId: 'project-1',
        fileId: 'artifact-1',
        versionId: 'artifact-v2'
      })
    )
  })

  it.each([undefined, 'another-project'])(
    'reveals a project annotation from its document provider with selected project %s',
    async (selectedProject) => {
      useSessionStore.setState({
        selectedSessionId: selectedProject ? 'other-session' : undefined,
        sessions: selectedProject ? [{ id: 'other-session', projectId: selectedProject }] : []
      } as never)
      const annotation: SavedPdfAnnotation = {
        id: 'note-1',
        projectId: 'project-1',
        version: 1,
        origin: 'user',
        kind: 'page-note',
        tagIds: [],
        note: 'Saved evidence',
        createdAt: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z',
        target: {
          source: {
            kind: 'upload-version',
            projectId: 'project-1',
            sessionId: 'creator',
            sourceFileId: 'upload-1',
            versionId: 'version-1',
            name: 'paper.pdf',
            path: 'upload-version:version-1',
            checksum: 'a'.repeat(64)
          },
          selector: { kind: 'page-note', pageNumber: 1, pageRotation: 0, coordinateVersion: 1 }
        }
      }
      const resolvePdfSource = vi.fn()
      window.api = {
        ...window.api,
        bookmarks: { resolvePdfSource },
        pdfAnnotations: {
          list: vi
            .fn()
            .mockResolvedValue({ items: [annotation], total: 1, nativeImport: { nativeRefs: [] } })
        },
        tags: { snapshot: vi.fn().mockResolvedValue({ revision: 0, tags: [], assignments: [] }) }
      } as unknown as Window['api']
      await act(async () =>
        root.render(
          <TooltipProvider>
            <PdfAnnotationsProvider
              projectId="project-1"
              sourceFileId="upload-1"
              versionId="version-1"
            >
              <PdfPreviewRenderer
                item={{
                  id: 'upload-1',
                  projectId: 'project-1',
                  sessionId: 'creator',
                  title: 'paper.pdf',
                  type: 'file',
                  source: 'upload',
                  path: annotation.target.source.path,
                  name: 'paper.pdf',
                  format: 'pdf',
                  managedFileId: 'upload-1',
                  selectedVersionId: 'version-1'
                }}
              />
            </PdfAnnotationsProvider>
          </TooltipProvider>
        )
      )
      await vi.waitFor(() =>
        expect(
          container.querySelector<HTMLButtonElement>('[aria-label="Annotate selected text"]')
            ?.disabled
        ).toBe(false)
      )
      let outcome: string | undefined
      await act(async () => {
        outcome = await requestPdfAnnotationReveal(annotation, { activatePreview: false })
      })
      expect(outcome).toBe('revealed')
      expect(resolvePdfSource).not.toHaveBeenCalled()
      expect(useSessionStore.getState().selectedSessionId).toBe(
        selectedProject ? 'other-session' : undefined
      )
    }
  )

  it.each([undefined, 'project-1'])(
    'enables annotations from Literature with project context %s and shows the empty Notes page',
    async (projectId) => {
      const source = {
        kind: 'literature-attachment-version' as const,
        sourceFileId: 'attachment-1',
        versionId: 'version-1',
        name: 'paper.pdf',
        path: 'literature-attachment-version:version-1',
        checksum: 'a'.repeat(64)
      }
      window.api = {
        ...window.api,
        pdfAnnotations: { list: vi.fn().mockResolvedValue({ items: [], total: 0, source }) },
        tags: { snapshot: vi.fn().mockResolvedValue({ revision: 0, tags: [], assignments: [] }) }
      } as unknown as Window['api']
      await act(async () =>
        root.render(
          <PdfPreviewRenderer
            item={{
              id: 'library-pdf',
              projectId,
              sessionId: 'literature-preview',
              title: 'paper.pdf',
              name: 'paper.pdf',
              path: source.path,
              type: 'file',
              format: 'pdf',
              source: 'literature',
              managedFileId: 'attachment-1'
            }}
          />
        )
      )
      await vi.waitFor(() =>
        expect(
          container.querySelector<HTMLButtonElement>('[aria-label="Annotate selected text"]')
            ?.disabled
        ).toBe(false)
      )
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="Select area to annotate"]')
          ?.disabled
      ).toBe(false)
      expect(window.api.pdfAnnotations.list).toHaveBeenCalledWith({
        literatureVersionId: 'version-1',
        sourceFileId: 'attachment-1',
        versionId: 'version-1',
        limit: 100,
        cursor: undefined
      })
      const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      expect(tabs).toHaveLength(3)
      for (const tab of tabs) {
        expect(tab.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
      }
      await act(async () =>
        fireEvent.mouseDown(
          tabs.find((tab) => tab.textContent === 'Notes & Annotations')!,
          { button: 0, ctrlKey: false }
        )
      )
      expect(container.querySelector('[data-pdf-notebook-view]')?.textContent).toContain(
        'No annotations yet.'
      )
      const back = [
        ...container.querySelectorAll<HTMLButtonElement>('[data-pdf-notebook-view] button')
      ].find((button) => button.textContent === 'Original PDF')!
      await act(async () => back.click())
      expect(tabs[0].getAttribute('data-state')).toBe('active')
      await act(async () =>
        fireEvent.keyDown(container.querySelector('[aria-label="Area selection actions"]')!, {
          key: 'Enter'
        })
      )
      const unavailable = screen.getByRole('menuitem', { name: 'Select area for Agent' })
      expect(unavailable.getAttribute('aria-disabled')).toBe('true')
      await act(async () => {
        unavailable.focus()
      })
      await vi.waitFor(() =>
        expect(screen.getByRole('tooltip').textContent).toBe(
          'Open this PDF in a conversation to send an area to Agent.'
        )
      )
      await act(async () => fireEvent.click(unavailable))
      expect(
        container.querySelector('[data-pdf-cursor-mode]')?.getAttribute('data-pdf-cursor-mode')
      ).toBe('select')
      expect(screen.getByRole('menuitem', { name: 'Select area to annotate' })).not.toBeNull()
    }
  )

  it('adds a Library PDF region to a new conversation draft and disables selection after unlink', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      drawImage: vi.fn()
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID')
    const source = {
      kind: 'literature-attachment-version' as const,
      sourceFileId: 'attachment-1',
      versionId: 'version-1',
      name: 'paper.pdf',
      path: 'literature-attachment-version:version-1',
      checksum: 'a'.repeat(64)
    }
    const onAddAnnotation = vi.fn()
    const createSession = vi.fn()
    window.api = {
      ...window.api,
      sessions: { create: createSession },
      pdfAnnotations: { list: vi.fn().mockResolvedValue({ items: [], total: 0, source }) },
      tags: { snapshot: vi.fn().mockResolvedValue({ revision: 0, tags: [], assignments: [] }) }
    } as unknown as Window['api']
    usePreviewWorkbenchStore.setState({
      activeProjectId: 'project-1',
      pendingPdfContextByProject: {
        'project-1': {
          kind: 'version',
          sourceKind: source.kind,
          sourceVersionId: source.versionId,
          previewItemId: 'library-pdf'
        }
      }
    })
    await act(async () => {
      root.render(
        <PdfPreviewRenderer
          item={{
            id: 'library-pdf',
            projectId: 'project-1',
            sessionId: '__literature__',
            title: source.name,
            name: source.name,
            path: source.path,
            type: 'file',
            format: 'pdf',
            source: 'literature',
            managedFileId: source.sourceFileId
          }}
          onAddAnnotation={onAddAnnotation}
        />
      )
      await flush()
    })
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Select area for Agent"]')!.click()
    )
    const overlay = container.querySelector<HTMLElement>('[data-pdf-region-selection]')!
    expect(overlay).not.toBeNull()
    overlay.setPointerCapture = vi.fn()
    overlay.hasPointerCapture = vi.fn(() => true)
    overlay.releasePointerCapture = vi.fn()
    overlay.getBoundingClientRect = () => new DOMRect(0, 0, 400, 560)
    await act(async () =>
      dispatchPointer(overlay, 'pointerdown', { clientX: 40, clientY: 56, button: 0 })
    )
    await act(async () =>
      dispatchPointer(overlay, 'pointerup', { clientX: 200, clientY: 280, button: 0 })
    )
    expect(onAddAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'pdf',
        target: 'agent',
        source: { ...source, projectId: 'project-1' },
        selector: expect.objectContaining({ kind: 'region', pageNumber: 1 })
      })
    )
    expect(createSession).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions).toHaveLength(0)
    await act(async () => {
      usePreviewWorkbenchStore.getState().setPendingPdfContext('project-1', undefined)
    })
    await act(async () =>
      fireEvent.keyDown(container.querySelector('[aria-label="Area selection actions"]')!, {
        key: 'Enter'
      })
    )
    expect(
      screen.getByRole('menuitem', { name: 'Select area for Agent' }).getAttribute('aria-disabled')
    ).toBe('true')
  })

  it.each(['artifact', 'upload'] as const)(
    'resolves a draft %s PDF from its exact managed Version',
    async (source) => {
      const inspect = vi.fn().mockResolvedValue({
        ok: true,
        value: {
          projectId: 'project-1',
          fileId: 'file-1',
          source,
          sessionId: 'source-session',
          selectedVersion: {
            id: 'version-1',
            fileId: 'file-1',
            source,
            displayName: 'paper.pdf',
            checksum: 'b'.repeat(64),
            sizeBytes: 10
          }
        }
      })
      window.api = {
        ...window.api,
        managedFileVersions: { inspect },
        pdfAnnotations: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }) },
        tags: { snapshot: vi.fn().mockResolvedValue({ revision: 0, tags: [], assignments: [] }) }
      } as unknown as Window['api']
      usePreviewWorkbenchStore.setState({
        activeProjectId: 'project-1',
        pendingPdfContextByProject: {
          'project-1': {
            kind: 'version',
            sourceKind: source === 'artifact' ? 'artifact-version' : 'upload-version',
            sourceFileId: 'file-1',
            sourceVersionId: 'version-1',
            previewItemId: 'file-1'
          }
        }
      })
      await act(async () => {
        root.render(
          <PdfPreviewRenderer
            item={{
              id: 'file-1',
              projectId: 'project-1',
              sessionId: 'source-session',
              title: 'paper.pdf',
              name: 'paper.pdf',
              path:
                source === 'upload'
                  ? 'upload-version:project-1/source-session/file-1/version-1'
                  : 'unused-path',
              type: 'file',
              format: 'pdf',
              source,
              managedFileId: 'file-1',
              selectedVersionId: 'version-1'
            }}
            onAddAnnotation={vi.fn()}
          />
        )
        await flush()
      })
      expect(inspect).toHaveBeenCalledWith({
        projectId: 'project-1',
        source,
        fileId: 'file-1',
        versionId: 'version-1'
      })
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Select area for Agent"]')!.click()
      )
      expect(
        container.querySelector('[data-pdf-cursor-mode]')?.getAttribute('data-pdf-cursor-mode')
      ).toBe('area')
      await act(async () => usePreviewWorkbenchStore.setState({ activeProjectId: 'other-project' }))
      expect(
        container.querySelector('[data-pdf-cursor-mode]')?.getAttribute('data-pdf-cursor-mode')
      ).toBe('select')
    }
  )

  it.each([false, true])(
    'keeps unavailable annotations quiet only for imported history (imported: %s)',
    async (imported) => {
      const resolvePdfSource = vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'source-unavailable' })
      window.api = {
        ...window.api,
        bookmarks: { resolvePdfSource }
      } as unknown as Window['api']
      useSessionStore.setState({
        selectedSessionId: 'session-owner',
        sessions: [
          {
            id: 'session-owner',
            projectId: 'project-1',
            ...(imported
              ? {
                  packageOrigin: {
                    importId: 'import-1',
                    sourceProjectId: 'source-project',
                    sourceSessionId: 'source-session',
                    importedAt: 1,
                    manifestChecksum: 'a'.repeat(64)
                  }
                }
              : {})
          }
        ]
      } as never)

      await act(async () => {
        root.render(
          <PdfPreviewRenderer
            item={{
              id: 'artifact-1',
              projectId: 'project-1',
              sessionId: 'source-session',
              title: 'report.pdf',
              type: 'file',
              source: 'artifact',
              path: 'artifact-version:stale-projection',
              name: 'report.pdf',
              format: 'pdf',
              managedFileId: 'artifact-1',
              selectedVersionId: 'artifact-v2'
            }}
          />
        )
      })

      await vi.waitFor(() =>
        expect(resolvePdfSource).toHaveBeenCalledWith({
          projectId: 'project-1',
          sessionId: 'session-owner',
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-1',
          versionId: 'artifact-v2'
        })
      )
      await vi.waitFor(() =>
        expect(
          container.textContent?.includes('PDF annotations are unavailable for this source.')
        ).toBe(!imported)
      )
      expect(container.querySelector('[aria-label="report.pdf scrollable preview"]')).not.toBeNull()
    }
  )

  it.each(['upload', 'artifact'] as const)(
    'opens Figures & Tables for a finalized %s without Agent context',
    async (kind) => {
      const source = {
        kind: kind === 'upload' ? ('upload-version' as const) : ('artifact-version' as const),
        projectId: 'project-1',
        sessionId: 'source-session',
        sourceFileId: 'file-1',
        versionId: 'version-1',
        checksum: 'a'.repeat(64),
        name: 'paper.pdf',
        path:
          kind === 'upload'
            ? 'upload-version:project-1/source-session/file-1/version-1'
            : 'artifact-version:version-1'
      }
      window.api = {
        ...window.api,
        bookmarks: { resolvePdfSource: vi.fn().mockResolvedValue({ ok: true, source }) },
        pdfAnnotations: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }) },
        tags: { snapshot: vi.fn().mockResolvedValue({ revision: 0, tags: [], assignments: [] }) },
        localModels: {
          getSnapshot: vi.fn().mockResolvedValue({
            installedRevision: 'v1',
            availability: 'ready',
            updateAvailable: false
          })
        }
      } as unknown as Window['api']
      useSessionStore.setState({
        selectedSessionId: 'session-owner',
        sessions: [{ id: 'session-owner', projectId: 'project-1' }]
      } as never)
      await act(async () => {
        root.render(
          <PdfPreviewRenderer
            item={{
              id: 'file-1',
              type: 'file',
              format: 'pdf',
              source: kind,
              projectId: 'project-1',
              sessionId: 'source-session',
              managedFileId: 'file-1',
              selectedVersionId: 'version-1',
              title: 'paper.pdf',
              name: 'paper.pdf',
              path: source.path
            }}
          />
        )
        await flush()
      })
      expect(window.api.pdfStructure.parse).not.toHaveBeenCalled()
      const figures = screen.getByRole('tab', { name: /Figures & Tables/ })
      await act(async () => fireEvent.mouseDown(figures, { button: 0 }))
      expect(figures.getAttribute('aria-selected')).toBe('true')
      expect(window.api.pdfStructure.parse).not.toHaveBeenCalled()
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Analyze PDF' })))
      expect(window.api.pdfStructure.parse).toHaveBeenCalledWith({
        source: {
          kind: 'managed',
          projectId: 'project-1',
          sourceKind: source.kind,
          sourceFileId: 'file-1',
          sourceVersionId: 'version-1'
        },
        page: 1,
        requestId: expect.any(String)
      })
      expect(useSessionStore.getState().sessions[0].runtimeContext).toBeUndefined()
      expect(screen.getByRole('tab', { name: 'Notes & Annotations' })).not.toBeNull()
      await act(async () => root.render(<div />))
      expect(window.api.pdfStructure.cancel).toHaveBeenCalledOnce()
    }
  )

  it('shows a native outline, expands nested sections, and navigates to their PDF pages', async () => {
    const getDestination = vi.fn().mockResolvedValue([{ num: 20, gen: 0 }])
    const getPageIndex = vi.fn(({ num }: { num: number }) => Promise.resolve(num / 10 - 1))
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        getOutline: vi.fn().mockResolvedValue([
          {
            title: 'Introduction',
            dest: [{ num: 10, gen: 0 }],
            items: [{ title: 'Method', dest: 'method', items: [] }]
          },
          { title: 'Results', dest: [{ num: 30, gen: 0 }], items: [] }
        ]),
        getDestination,
        getPageIndex,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/outline.pdf" name="outline.pdf" source="local" />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    const outlineToggle = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')
      expect(button).not.toBeNull()
      return button!
    })
    expect(outlineToggle.hasAttribute('title')).toBe(false)

    await act(async () => outlineToggle.click())
    const outline = container.querySelector<HTMLElement>('#pdf-navigation-sidebar')!
    expect(outline.style.width).toBe('240px')
    expect(container.querySelector<HTMLButtonElement>('[title="Introduction"]')).not.toBeNull()
    expect(container.querySelector<HTMLButtonElement>('[title="Method"]')).not.toBeNull()
    expect(getDestination).toHaveBeenCalledWith('method')

    const introduction = container.querySelector<HTMLButtonElement>('[title="Introduction"]')!
    introduction.focus()
    await act(async () =>
      introduction.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    )
    await vi.waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.title).toBe('Method')
    )

    const pageTwo = container.querySelector<HTMLElement>('[data-page-number="2"]')!
    const scrollIntoView = vi.spyOn(pageTwo, 'scrollIntoView')
    await act(async () => container.querySelector<HTMLButtonElement>('[title="Method"]')!.click())

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' })
    expect(container.querySelector('[title="Method"]')?.getAttribute('aria-selected')).toBe('true')
    expect(outlineToggle.getAttribute('aria-expanded')).toBe('true')

    const resizeHandle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Resize navigation"]'
    )!
    resizeHandle.setPointerCapture = vi.fn()
    resizeHandle.hasPointerCapture = vi.fn(() => true)
    resizeHandle.releasePointerCapture = vi.fn()
    await act(async () =>
      dispatchPointer(resizeHandle, 'pointerdown', { pointerId: 7, clientX: 240, clientY: 0 })
    )
    await act(async () =>
      dispatchPointer(resizeHandle, 'pointermove', { pointerId: 7, clientX: 120, clientY: 0 })
    )
    expect(outline.style.width).toBe('160px')
    await act(async () =>
      dispatchPointer(resizeHandle, 'pointerup', { pointerId: 7, clientX: 120, clientY: 0 })
    )
    expect(container.querySelector('#pdf-navigation-sidebar')).toBeNull()
    expect(outlineToggle.getAttribute('aria-label')).toBe('Show navigation')

    await act(async () => outlineToggle.click())
    const reopenedOutline = container.querySelector<HTMLElement>('#pdf-navigation-sidebar')!
    const reopenedResizeHandle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Resize navigation"]'
    )!
    await act(async () =>
      reopenedResizeHandle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
      )
    )
    expect(reopenedOutline.style.width).toBe('176px')

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Hide navigation"]')!.click()
    )
    expect(container.querySelector('#pdf-navigation-sidebar')).toBeNull()
    expect(outlineToggle.getAttribute('aria-label')).toBe('Show navigation')
  })

  it('navigates and tracks distinct same-page outline destinations without changing zoom', async () => {
    vi.useFakeTimers()
    const page = await (
      getPage as ReturnType<
        typeof vi.fn<() => Promise<{ view?: number[]; getViewport: ReturnType<typeof vi.fn> }>>
      >
    )()
    page.view = [0, 0, 600, 1200]
    page.getViewport.mockImplementation(() => ({
      width: 600,
      height: 1200,
      convertToViewportPoint: (x: number, y: number) => [x, 1200 - y]
    }))
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage,
        getDestination: vi.fn().mockResolvedValue([0, { name: 'XYZ' }, 40, 600, 2]),
        getOutline: vi.fn().mockResolvedValue([
          { title: 'First heading', dest: [0, { name: 'XYZ' }, 40, 1100, null], items: [] },
          { title: 'Second heading', dest: 'second', items: [] },
          { title: 'Same destination alias', dest: [0, { name: 'FitH' }, 600], items: [] }
        ]),
        destroy: destroyDocument
      }),
      destroy: vi.fn()
    } as never)
    await act(async () => {
      root.render(<PdfPreviewContent path="/outline.pdf" name="outline.pdf" />)
      await flush()
    })
    await act(async () => screen.getByRole('button', { name: 'Show navigation' }).click())
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      height: 400,
      bottom: 400
    } as DOMRect)
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'))
    pages.forEach((element, index) =>
      vi.spyOn(element, 'getBoundingClientRect').mockImplementation(
        () =>
          ({
            top: index * 1212 - scroll.scrollTop,
            bottom: index * 1212 + 1200 - scroll.scrollTop,
            left: 0,
            width: 600,
            height: 1200
          }) as DOMRect
      )
    )
    const first = screen.getByRole('treeitem', { name: 'First heading' })
    const second = screen.getByRole('treeitem', { name: 'Second heading' })
    const alias = screen.getByRole('treeitem', { name: 'Same destination alias' })
    await act(async () => second.click())
    expect(scroll.scrollTop).toBe(536)
    expect(second.getAttribute('aria-selected')).toBe('true')
    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'))
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(second.getAttribute('aria-selected')).toBe('true')
    await act(async () => alias.click())
    expect(alias.getAttribute('aria-selected')).toBe('true')
    await act(async () => first.click())
    expect(scroll.scrollTop).toBe(36)
    expect(first.getAttribute('aria-selected')).toBe('true')
    await act(async () => {
      scroll.scrollTop = 650
      scroll.dispatchEvent(new Event('scroll'))
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(second.getAttribute('aria-selected')).toBe('true')
    expect(Element.prototype.scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
    await act(async () => {
      scroll.scrollTop = 200
      scroll.dispatchEvent(new Event('scroll'))
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(first.getAttribute('aria-selected')).toBe('true')
    expect(container.textContent).toContain('100%')
  })

  it.each([
    ['XYZ', [40, 600, null], 600],
    ['FitH', [600], 600],
    ['FitBH', [600], 600],
    ['FitR', [40, 400, 200, 600], 600],
    ['FitV', [40], 0],
    ['FitBV', [40], 0],
    ['XYZ', [null, null, null], 0],
    ['Fit', [], 0],
    ['FitB', [], 0]
  ])(
    'resolves %s outline coordinates on a single-page document',
    async (type, coordinates, expectedTop) => {
      const convertToViewportPoint = vi.fn((x: number, y: number) => [x - 10, 1220 - y])
      const pdfPage = {
        view: [10, 20, 610, 1220],
        getViewport: () => ({ width: 600, height: 1200, convertToViewportPoint }),
        getTextContent: async () => ({ items: [] }),
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
        cleanup: vi.fn()
      }
      getPage.mockResolvedValue(pdfPage)
      vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
        promise: Promise.resolve({
          numPages: 1,
          getPage,
          getOutline: async () => [
            {
              title: 'Destination',
              dest: [0, { name: type }, ...(coordinates as unknown[])],
              items: []
            }
          ],
          destroy: destroyDocument
        }),
        destroy: vi.fn()
      } as never)
      await act(async () => {
        root.render(<PdfPreviewContent path="/single.pdf" name="single.pdf" />)
        await flush()
      })
      await act(async () => screen.getByRole('button', { name: 'Show navigation' }).click())
      const scroll = container.querySelector<HTMLElement>('[role="region"]')!
      const page = container.querySelector<HTMLElement>('[data-page-number="1"]')!
      vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0 } as DOMRect)
      vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        left: 0,
        width: 600,
        height: 1200
      } as DOMRect)
      await act(async () => screen.getByRole('treeitem', { name: 'Destination' }).click())
      // The crop box starts at y=20; numeric destinations are absolute PDF coordinates.
      expect(scroll.scrollTop).toBeCloseTo(
        Number(expectedTop) > 0 ? Number(expectedTop) + 20 - 64 : 0
      )
      expect(
        screen.getByRole('treeitem', { name: 'Destination' }).getAttribute('aria-selected')
      ).toBe('true')
    }
  )

  it('discards outline coordinates resolved after the PDF is replaced', async () => {
    let finish!: (value: unknown) => void
    const delayed = new Promise((resolve) => {
      finish = resolve
    })
    const initialPage = await (getPage as ReturnType<typeof vi.fn<() => Promise<unknown>>>)()
    getPage.mockReturnValue(delayed)
    vi.mocked(createManagedPdfLoadingTask).mockReturnValueOnce({
      promise: Promise.resolve({
        numPages: 2,
        getPage,
        getOutline: async () => [
          { title: 'Old destination', dest: [0, { name: 'XYZ' }, 0, 100, null], items: [] }
        ],
        destroy: destroyDocument
      }),
      destroy: vi.fn()
    } as never)
    await act(async () => {
      root.render(<PdfPreviewContent path="/old.pdf" name="old.pdf" />)
      await flush()
    })
    getPage.mockResolvedValue(initialPage)
    await act(async () => {
      root.render(<PdfPreviewContent path="/new.pdf" name="new.pdf" />)
      await flush()
      finish(initialPage)
      await flush()
    })
    expect(container.querySelector('[aria-label="Show navigation"]')).toBeNull()
    expect(container.textContent).not.toContain('Old destination')
  })

  it('omits redundant PDF page labels and preserves distinct labels', async () => {
    await act(async () =>
      root.render(
        <PdfOutlineSidebar
          document={{ getPage } as never}
          items={[]}
          pageCount={3}
          pageLabels={['1', 'ii', '1']}
          currentPage={1}
          width={240}
          onNavigate={vi.fn()}
          onClose={vi.fn()}
          onWidthChange={vi.fn()}
        />
      )
    )
    expect(screen.getByRole('button', { name: 'Page 1' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Page 2 · ii' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Page 3 · 1' })).not.toBeNull()
  })

  it.each(['missing', 'rejected', 'unresolvable'])(
    'explains an unavailable %s outline and keeps Pages selected',
    async (reason) => {
      vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
        promise: Promise.resolve({
          numPages: 2,
          getPage,
          getOutline: () =>
            reason === 'rejected'
              ? Promise.reject(new Error('Invalid outline'))
              : Promise.resolve(
                  reason === 'missing'
                    ? null
                    : [{ title: 'Broken destination', dest: 'missing', items: [] }]
                ),
          getDestination: () => Promise.reject(new Error('Invalid destination')),
          destroy: destroyDocument
        }),
        destroy: vi.fn().mockResolvedValue(undefined)
      } as never)
      await act(async () => {
        root.render(<PdfPreviewContent path="/workspace/unavailable.pdf" name="paper.pdf" />)
        await flush()
      })
      await act(async () => screen.getByRole('button', { name: 'Show navigation' }).click())
      const outline = screen.getByRole('button', { name: 'Outline' })
      expect(outline.getAttribute('aria-disabled')).toBe('true')
      expect(outline.classList.contains('opacity-50')).toBe(true)
      await act(async () => outline.focus())
      expect(screen.getByRole('tooltip').textContent).toBe(
        'No readable outline is available for this PDF'
      )
      await act(async () => outline.click())
      expect(outline.getAttribute('aria-pressed')).toBe('false')
      expect(screen.getByRole('button', { name: 'Pages' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    }
  )

  it('floats navigation below 1120px and preserves its mode, document and docked width', async () => {
    let width = 1150
    const callbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback)
        }
        observe = vi.fn()
        disconnect = vi.fn()
        unobserve = vi.fn()
      }
    )
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage,
        getOutline: async () => [{ title: 'Introduction', dest: [0], items: [] }],
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    await act(async () => {
      root.render(
        <div data-slot="file-preview-dialog">
          <PdfPreviewContent path="/workspace/responsive.pdf" name="paper.pdf" />
        </div>
      )
      await flush()
    })
    await act(async () => screen.getByRole('button', { name: 'Show navigation' }).click())
    const loadCount = vi.mocked(createManagedPdfLoadingTask).mock.calls.length
    const sidebar = screen.getByRole('complementary', { name: 'PDF navigation' })
    expect(sidebar.classList.contains('absolute')).toBe(false)
    await act(async () =>
      fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize navigation' }), {
        key: 'ArrowRight'
      })
    )
    expect(sidebar.style.width).toBe('256px')
    await act(async () => screen.getByRole('button', { name: 'Pages' }).click())
    const resize = async (next: number): Promise<void> => {
      width = next
      await act(async () => {
        callbacks.forEach((callback) => callback([], {} as ResizeObserver))
        await flush()
      })
    }
    await resize(1119)
    expect(sidebar.classList.contains('absolute')).toBe(true)
    expect(screen.queryByRole('separator', { name: 'Resize navigation' })).toBeNull()
    await resize(240)
    expect(sidebar.style.width).toBe('224px')
    await resize(1120)
    expect(screen.getByRole('complementary', { name: 'PDF navigation' })).toBe(sidebar)
    expect(sidebar.classList.contains('absolute')).toBe(false)
    expect(sidebar.style.width).toBe('256px')
    expect(screen.getByRole('button', { name: 'Pages' }).getAttribute('aria-pressed')).toBe('true')
    expect(createManagedPdfLoadingTask).toHaveBeenCalledTimes(loadCount)
    expect(destroyDocument).not.toHaveBeenCalled()
    await resize(800)
    expect(container.querySelector('[data-preview-escape-boundary]')).not.toBeNull()
    await act(async () => fireEvent.keyDown(sidebar, { key: 'Escape' }))
    expect(screen.queryByRole('complementary', { name: 'PDF navigation' })).toBeNull()
    expect(container.querySelector('[data-preview-escape-boundary]')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[data-pdf-cursor-mode]'))
  })

  it('keeps the outline control hidden when the PDF has no native outline', async () => {
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage,
        getOutline: vi.fn().mockResolvedValue(null),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/plain.pdf" name="plain.pdf" source="local" />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Show navigation"]')).toBeNull()
    expect(container.querySelector('#pdf-navigation-sidebar')).toBeNull()
  })

  it('offers lazy page thumbnails when a multi-page PDF has no outline', async () => {
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage,
        getOutline: vi.fn().mockResolvedValue(null),
        getPageLabels: vi.fn().mockResolvedValue(['i', '1']),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/plain.pdf" name="plain.pdf" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const navigation = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')
      expect(button).not.toBeNull()
      return button!
    })
    await act(async () => navigation.click())
    expect(
      container.querySelector('[data-pdf-controls="interaction"] [aria-label="Back"]')
    ).toBeNull()
    expect(
      container.querySelector('[data-pdf-controls="interaction"] [aria-label="Forward"]')
    ).toBeNull()

    const pageTwo = container.querySelector<HTMLElement>('[data-page-number="2"]')!
    const scrollIntoView = vi.spyOn(pageTwo, 'scrollIntoView')
    const thumbnail = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Page 2 · 1"]')
      expect(button).not.toBeNull()
      return button!
    })
    await act(async () => thumbnail.click())
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' })
    expect(thumbnail.getAttribute('aria-current')).toBe('page')
  })

  it('contains a damaged page rejection while rendering navigation thumbnails', async () => {
    const damagedPage = new Error('Damaged PDF page')
    let pageOneLoads = 0
    const page = {
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      getTextContent: vi.fn().mockResolvedValue({ items: [], styles: {} }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    }
    const getDamagedPage = vi.fn((pageNumber: number) => {
      if (pageNumber === 1 && ++pageOneLoads === 2) return Promise.reject(damagedPage)
      return Promise.resolve(page)
    })
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage: getDamagedPage,
        getOutline: vi.fn().mockResolvedValue(null),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    try {
      await act(async () => {
        root.render(<PdfPreviewContent path="/workspace/damaged.pdf" name="damaged.pdf" />)
        await Promise.resolve()
        await Promise.resolve()
      })
      const navigation = await vi.waitFor(() => {
        const button = container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')
        expect(button).not.toBeNull()
        return button!
      })
      await act(async () => navigation.click())
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(unhandled).not.toHaveBeenCalled()
      expect(container.querySelector('#pdf-navigation-sidebar')).not.toBeNull()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('keeps the page thumbnail DOM bounded for thousand-page PDFs', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 1_000,
        getPage,
        getOutline: vi.fn().mockResolvedValue(null),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/thousand-pages.pdf" name="large.pdf" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const navigation = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')
      expect(button).not.toBeNull()
      return button!
    })
    await act(async () => navigation.click())

    const thumbnails = container.querySelectorAll(
      '#pdf-navigation-sidebar button[aria-label^="Page "]'
    )
    expect(thumbnails.length).toBeGreaterThan(0)
    expect(thumbnails.length).toBeLessThanOrEqual(24)
  })

  it('keeps search presentation in document flow without reader controls or intercepted shortcuts', async () => {
    await act(async () => {
      root.render(
        <PdfPreviewContent
          path="literature-attachment-version:version-1"
          name="paper.pdf"
          source="literature"
          presentation="search"
        />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    const original = container.querySelector<HTMLElement>('[data-pdf-original-view]')!
    const scroll = original.querySelector<HTMLElement>('[role="region"]')!
    expect(original.classList.contains('absolute')).toBe(false)
    expect(scroll.classList.contains('overflow-auto')).toBe(false)
    expect(container.querySelector('[aria-label="PDF reading mode"]')).toBeNull()
    expect(container.querySelector('[aria-label="Zoom in"]')).toBeNull()
    const shortcut = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    await act(async () => scroll.dispatchEvent(shortcut))
    expect(shortcut.defaultPrevented).toBe(false)
    expect(container.querySelector('[aria-label="Search document"]')).toBeNull()
  })

  it('scopes Cmd+F to the PDF and searches every page without opening a global search', async () => {
    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/search.pdf" name="search.pdf" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const shortcut = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    await act(async () => scroll.dispatchEvent(shortcut))
    expect(shortcut.defaultPrevented).toBe(true)

    const input = container.querySelector<HTMLInputElement>('[aria-label="Search document"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'selectable'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await vi.waitFor(() => expect(input.parentElement?.textContent).toContain('1/1'))

    const outsideShortcut = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    document.body.dispatchEvent(outsideShortcut)
    expect(outsideShortcut.defaultPrevented).toBe(false)
  })

  it('preserves word gaps and line endings while searching PDF text items', async () => {
    const highlights = { delete: vi.fn(), set: vi.fn() }
    const constructedHighlights: Range[][] = []
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal(
      'Highlight',
      class {
        constructor(...ranges: Range[]) {
          constructedHighlights.push(ranges)
        }
      }
    )
    getPage.mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      getTextContent: vi.fn().mockResolvedValue({
        items: [
          {
            str: 'The method',
            transform: [10, 0, 0, 10, 0, 20],
            width: 50,
            height: 10
          },
          {
            str: 'uses retrieval',
            transform: [10, 0, 0, 10, 55, 20],
            width: 60,
            height: 10,
            hasEOL: true
          }
        ],
        styles: {}
      }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/search-spacing.pdf" name="search.pdf" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    await act(async () =>
      scroll.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f',
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search document"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'method uses retrieval'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await vi.waitFor(() => expect(input.parentElement?.textContent).toContain('1/1'))
    await vi.waitFor(() => expect(highlights.set).toHaveBeenCalledWith('pdf-search-results', {}))
    expect(constructedHighlights.some((ranges) => ranges.length > 0)).toBe(true)
  })

  const openSearch = async (query: string): Promise<HTMLInputElement> => {
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    await act(async () =>
      scroll.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f',
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search document"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => vi.advanceTimersByTimeAsync(180))
    return input
  }

  describe.each([true, false])('Intl.Segmenter available: %s', (available) => {
    it.each([
      { text: ['İA'], query: 'a', expected: ['A'] },
      { text: ['İA', 'B'], query: 'ab', expected: ['AB'] },
      { text: ['AA'], query: 'a', expected: ['A', 'A'] },
      { text: ['A', 'B'], query: 'ab', expected: ['AB'] },
      { text: ['İ'], query: 'i', expected: ['İ'] },
      { text: ['İΟΣ'], query: 'ος', expected: ['ΟΣ'] },
      { text: ['😀İA'], query: 'a', expected: ['A'] },
      { text: ['I\u0307A'], query: 'a', expected: ['A'], locale: 'tr' },
      { text: ['I\u0301A'], query: 'a', expected: ['A'], locale: 'lt' }
    ])(
      'highlights original DOM characters for $text searching $query',
      async ({ text, query, expected, locale = 'en' }) => {
        vi.useFakeTimers()
        if (!available)
          vi.stubGlobal('Intl', Object.create(Intl, { Segmenter: { value: undefined } }))
        const lower = String.prototype.toLocaleLowerCase
        vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
          return lower.call(this, locale)
        })
        const highlights = new Map<string, Set<Range>>()
        vi.stubGlobal('CSS', { highlights })
        vi.stubGlobal(
          'Highlight',
          class extends Set<Range> {
            constructor(...ranges: Range[]) {
              super(ranges)
            }
          }
        )
        const errors: Error[] = []
        class SearchBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
          state = { failed: false }
          static getDerivedStateFromError(): { failed: boolean } {
            return { failed: true }
          }
          componentDidCatch(error: Error): void {
            errors.push(error)
          }
          render(): ReactNode {
            return this.state.failed ? null : this.props.children
          }
        }
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        getPage.mockResolvedValue({
          getViewport: () => ({ width: 600, height: 800 }),
          getTextContent: async () => ({ items: text.map((str) => ({ str })), styles: {} }),
          render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
          cleanup: vi.fn()
        })
        await act(async () =>
          root.render(
            <SearchBoundary>
              <PdfPreviewContent path="/workspace/unicode.pdf" name="unicode.pdf" />
            </SearchBoundary>
          )
        )
        expect(container.querySelector('[data-pdf-text-layer]')?.textContent).toBe(text.join(''))
        const input = await openSearch(query)
        expect(errors.map((error) => error.name)).toEqual([])
        expect(input.parentElement?.textContent).toContain(`1/${expected.length}`)
        expect(
          Array.from(highlights.get('pdf-search-results') ?? [], (range) => range.toString())
        ).toEqual(expected)
      }
    )
  })

  it.each(['first', 'next'])('reveals the %s match inside a tall PDF page', async (target) => {
    vi.useFakeTimers()
    const highlights = new Map<string, Set<Range>>()
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal(
      'Highlight',
      class extends Set<Range> {
        constructor(...ranges: Range[]) {
          super(ranges)
        }
      }
    )
    getPage.mockResolvedValue({
      getViewport: () => ({ width: 600, height: 1800 }),
      getTextContent: async () => ({
        items: [{ str: target === 'next' ? 'needle needle' : 'needle' }],
        styles: {}
      }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      cleanup: vi.fn()
    })
    await act(async () =>
      root.render(<PdfPreviewContent path="/workspace/tall.pdf" name="tall.pdf" />)
    )
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
    vi.spyOn(scroll, 'clientHeight', 'get').mockReturnValue(600)
    vi.spyOn(scroll, 'clientWidth', 'get').mockReturnValue(800)
    vi.stubGlobal(
      'Range',
      class extends Range {
        getBoundingClientRect(): DOMRect {
          const top = target === 'first' || this.startOffset > 0 ? 1800 : 100
          return new DOMRect(40, top - scroll.scrollTop, 60, 20)
        }
        getClientRects(): DOMRectList {
          return [this.getBoundingClientRect()] as unknown as DOMRectList
        }
      }
    )
    const input = await openSearch('needle')
    expect(input.parentElement?.textContent).toContain(target === 'next' ? '1/2' : '1/1')
    if (target === 'next') {
      expect(scroll.scrollTop).toBe(0)
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click()
      )
      expect(input.parentElement?.textContent).toContain('2/2')
    }
    const current = Array.from(highlights.get('pdf-search-current') ?? [])[0]
    expect(current?.toString()).toBe('needle')
    const bounds = current.getBoundingClientRect()
    expect(bounds.top).toBeGreaterThanOrEqual(0)
    expect(bounds.bottom).toBeLessThanOrEqual(600)
  })

  it.each(['ready', 'query cleared', 'document replaced'])(
    'finishes a deferred match reveal only while its request is current: %s',
    async (outcome) => {
      vi.useFakeTimers()
      let intersectionCallback: IntersectionObserverCallback | undefined
      const observed: Element[] = []
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          observe = (element: Element): void => {
            observed.push(element)
          }
          unobserve = vi.fn()
          disconnect = vi.fn()
          constructor(callback: IntersectionObserverCallback) {
            intersectionCallback = callback
          }
        }
      )
      getPage.mockImplementation(async () => ({
        getViewport: () => ({ width: 600, height: 1800 }),
        getTextContent: async () => ({ items: [{ str: 'needle needle' }], styles: {} }),
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
        cleanup: vi.fn()
      }))
      await act(async () =>
        root.render(<PdfPreviewContent path="/workspace/deferred.pdf" name="deferred.pdf" />)
      )
      const scroll = container.querySelector<HTMLElement>('[role="region"]')!
      vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
      vi.spyOn(scroll, 'clientHeight', 'get').mockReturnValue(600)
      vi.spyOn(scroll, 'clientWidth', 'get').mockReturnValue(800)
      vi.stubGlobal(
        'Range',
        class extends Range {
          getBoundingClientRect(): DOMRect {
            return new DOMRect(40, 1800 - scroll.scrollTop, 60, 20)
          }
        }
      )
      const input = await openSearch('needle')
      expect(input.parentElement?.textContent).toContain('1/2')
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click()
      )
      expect(input.parentElement?.textContent).toContain('2/2')
      expect(container.querySelector('[data-pdf-text-layer]')).toBeNull()
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: 'start',
        behavior: 'auto'
      })
      expect(scroll.scrollTop).toBe(0)
      if (outcome === 'query cleared') {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '')
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
      } else if (outcome === 'document replaced') {
        await act(async () =>
          root.render(
            <PdfPreviewContent path="/workspace/replacement.pdf" name="replacement.pdf" />
          )
        )
      }
      await act(async () => {
        intersectionCallback?.(
          [{ isIntersecting: true, target: observed.at(-1) } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      })
      expect(container.querySelector('[data-pdf-text-layer]')?.textContent).toBe('needle needle')
      expect(scroll.scrollTop).toBe(outcome === 'ready' ? 1510 : 0)
      // A later text-layer render must not pull the reader back to a completed result.
      scroll.scrollTop = 400
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click()
      )
      expect(scroll.scrollTop).toBe(400)
    }
  )

  it.each(['mouse', 'keyboard'])(
    'allows collapsing the active section parent using $0',
    async (method) => {
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          observe = vi.fn()
          unobserve = vi.fn()
          disconnect = vi.fn()
        }
      )
      vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
        promise: Promise.resolve({
          numPages: 2,
          getPage,
          destroy: destroyDocument,
          getOutline: async () => [
            { title: 'Chapter', dest: [0], items: [{ title: 'Section', dest: [1], items: [] }] }
          ]
        }),
        destroy: vi.fn().mockResolvedValue(undefined)
      } as never)
      await act(async () =>
        root.render(<PdfPreviewContent path="/workspace/outline-collapse.pdf" name="outline.pdf" />)
      )
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')!.click()
      )
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[title="Section"]')!.click()
      )
      expect(container.querySelector('[title="Section"]')?.getAttribute('aria-selected')).toBe(
        'true'
      )
      const parent = container.querySelector<HTMLButtonElement>('[title="Chapter"]')!
      await act(async () => {
        if (method === 'mouse')
          container.querySelector<HTMLButtonElement>('[aria-label="Collapse"]')!.click()
        else parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
      })
      expect(parent.getAttribute('aria-expanded')).toBe('false')
      expect(container.querySelector('[title="Section"]')).toBeNull()
      expect(container.querySelector('[role="treeitem"][tabindex="0"]')).toBe(parent)
      await act(async () => parent.click())
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Expand"]')!.click()
      )
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[title="Section"]')!.click()
      )
      expect(parent.getAttribute('aria-expanded')).toBe('true')
    }
  )

  it('reopens active ancestors only when the section changes or the outline is first shown', async () => {
    const items = [
      {
        id: 'chapter',
        title: 'Chapter',
        pageNumber: 1,
        children: [
          {
            id: 'section',
            title: 'Section',
            pageNumber: 2,
            children: [{ id: 'subsection', title: 'Subsection', pageNumber: 3, children: [] }]
          }
        ]
      }
    ]
    const renderOutline = async (currentPage: number): Promise<void> => {
      await act(async () =>
        root.render(
          <PdfOutlineSidebar
            document={{ getPage } as never}
            items={items}
            pageCount={4}
            currentPage={currentPage}
            width={240}
            onWidthChange={vi.fn()}
            onClose={vi.fn()}
            onNavigate={vi.fn()}
          />
        )
      )
    }
    await renderOutline(3)
    expect(container.querySelector('[title="Subsection"]')).not.toBeNull()
    const chapter = container.querySelector<HTMLButtonElement>('[title="Chapter"]')!
    await act(async () =>
      chapter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    )
    await renderOutline(4)
    expect(chapter.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[title="Subsection"]')).toBeNull()
    expect(container.querySelector('[role="treeitem"][tabindex="0"]')).toBe(chapter)
    await renderOutline(2)
    expect(chapter.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[title="Section"]')?.getAttribute('aria-selected')).toBe('true')
  })

  it('keeps later same-page outline entries active when their destinations lack coordinates', async () => {
    await act(async () =>
      root.render(
        <PdfOutlineSidebar
          document={{ getPage } as never}
          items={[
            { id: 'first', title: 'First', pageNumber: 1, children: [] },
            { id: 'second', title: 'Second', pageNumber: 1, children: [] }
          ]}
          pageCount={1}
          currentPage={1}
          position={{ pageNumber: 1, top: 0 }}
          width={240}
          onWidthChange={vi.fn()}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
        />
      )
    )
    expect(container.querySelector('[title="First"]')?.getAttribute('aria-selected')).toBe('false')
    expect(container.querySelector('[title="Second"]')?.getAttribute('aria-selected')).toBe('true')
  })

  it('stops a stale full-document search before parsing the remaining pages', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    let resolveFirstPage: ((value: { items: Array<{ str: string }> }) => void) | undefined
    const cleanupSearchPage = vi.fn()
    const searchGetPage = vi.fn((pageNumber: number) =>
      Promise.resolve({
        cleanup: cleanupSearchPage,
        getTextContent: () =>
          pageNumber === 1
            ? new Promise<{ items: Array<{ str: string }> }>((resolve) => {
                resolveFirstPage = resolve
              })
            : Promise.resolve({ items: [{ str: 'needle' }] })
      })
    )
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage: searchGetPage,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/search-cancel.pdf" name="search.pdf" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    await act(async () =>
      scroll.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f',
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search document"]')!
    const setQuery = async (query: string): Promise<void> => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          query
        )
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    await setQuery('needle')
    await act(async () => vi.advanceTimersByTimeAsync(180))
    expect(searchGetPage).toHaveBeenCalledTimes(1)
    await setQuery('')
    await act(async () => {
      resolveFirstPage?.({ items: [{ str: 'needle' }] })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(searchGetPage).toHaveBeenCalledTimes(1)
    expect(cleanupSearchPage).toHaveBeenCalledOnce()
  })

  it('publishes the first search result before the remaining pages finish parsing', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    let resolveSecondPage: ((value: { items: Array<{ str: string }> }) => void) | undefined
    const searchGetPage = vi.fn((pageNumber: number) =>
      Promise.resolve({
        cleanup: vi.fn(),
        getTextContent: () =>
          pageNumber === 1
            ? Promise.resolve({ items: [{ str: 'needle' }] })
            : new Promise<{ items: Array<{ str: string }> }>((resolve) => {
                resolveSecondPage = resolve
              })
      })
    )
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage: searchGetPage,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/search-progress.pdf" name="search.pdf" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    await act(async () =>
      scroll.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f',
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search document"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'needle'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(180)
    })

    await vi.waitFor(() => expect(input.parentElement?.textContent).toContain('1/1'))
    expect(resolveSecondPage).toBeDefined()

    await act(async () => {
      resolveSecondPage?.({ items: [] })
      await Promise.resolve()
    })
  })

  it('updates the active outline on a bounded interval while the PDF is still scrolling', async () => {
    vi.useFakeTimers()
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        getOutline: vi.fn().mockResolvedValue([
          {
            title: 'Chapter',
            dest: [0],
            items: [{ title: 'Later section', dest: [2], items: [] }]
          },
          { title: 'Middle section', dest: [1], items: [] }
        ]),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/live.pdf" name="live.pdf" source="local" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const outlineToggle = await vi.waitFor(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')
    )
    await act(async () => outlineToggle?.click())
    await act(async () => vi.runOnlyPendingTimersAsync())

    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'))
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 600,
      height: 600
    } as DOMRect)
    pages.forEach((page, index) => {
      const top = index * 700 - 1_400
      vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
        top,
        bottom: top + 600,
        height: 600
      } as DOMRect)
    })

    act(() => scroll.dispatchEvent(new Event('scroll')))
    expect(container.querySelector('[title="Later section"]')?.getAttribute('aria-selected')).toBe(
      'false'
    )
    await act(async () => vi.advanceTimersByTimeAsync(99))
    expect(container.querySelector('[title="Later section"]')?.getAttribute('aria-selected')).toBe(
      'false'
    )
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(container.querySelector('[title="Later section"]')?.getAttribute('aria-selected')).toBe(
      'true'
    )
    expect(container.querySelector('[title="Middle section"]')?.getAttribute('aria-selected')).toBe(
      'false'
    )
  })

  it('keeps navigation and detected page aligned while the next page remains below midpoint', async () => {
    vi.useFakeTimers()
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        getOutline: vi.fn().mockResolvedValue([
          { title: 'First', dest: [0], items: [] },
          { title: 'Target', dest: [1], items: [] },
          { title: 'Next', dest: [2], items: [] }
        ]),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/short-pages.pdf" name="short-pages.pdf" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const navigation = await vi.waitFor(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')
    )
    await act(async () => navigation?.click())
    await act(async () => vi.runOnlyPendingTimersAsync())

    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'))
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 800,
      top: 0,
      bottom: 600,
      width: 800,
      height: 600
    } as DOMRect)
    const pageBounds = [
      { top: -260, bottom: -20 },
      { top: 0, bottom: 240 },
      { top: 320, bottom: 560 }
    ]
    pages.forEach((page, index) => {
      vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 600,
        width: 600,
        height: 240,
        ...pageBounds[index]
      } as DOMRect)
    })

    await act(async () => container.querySelector<HTMLButtonElement>('[title="Target"]')!.click())
    act(() => scroll.dispatchEvent(new Event('scroll')))
    await act(async () => vi.advanceTimersByTimeAsync(100))

    expect(container.querySelector('[title="Target"]')?.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[title="Next"]')?.getAttribute('aria-selected')).toBe('false')
    expect(container.querySelector('[data-pdf-page-control]')?.textContent).toBe('2/3')
  })

  it('tracks the current page without an outline or Reading callback', async () => {
    vi.useFakeTimers()
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        getOutline: vi.fn().mockResolvedValue([]),
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/no-outline.pdf" name="no-outline.pdf" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => vi.runOnlyPendingTimersAsync())

    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'))
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 600,
      height: 600
    } as DOMRect)
    pages.forEach((page, index) => {
      const top = index * 700 - 700
      vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
        top,
        bottom: top + 600,
        height: 600
      } as DOMRect)
    })

    act(() => scroll.dispatchEvent(new Event('scroll')))
    await act(async () => vi.advanceTimersByTimeAsync(100))

    expect(container.querySelector('[data-pdf-page-control]')?.textContent).toBe('2/3')
  })

  it.each([
    ['interaction', 'Show navigation', 'Hand', 200],
    ['view', 'Page 1 of 2', 'Zoom in', 200]
  ])(
    'delays the first hint and shares a 300ms skip window in the %s toolbar',
    async (_, firstLabel, nextLabel, delay) => {
      vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
        promise: Promise.resolve({ numPages: 2, getPage, destroy: destroyDocument }),
        destroy: vi.fn().mockResolvedValue(undefined)
      } as never)
      await act(async () => {
        root.render(<PdfPreviewContent path="/workspace/hints.pdf" name="hints.pdf" />)
      })
      await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
      vi.useFakeTimers()
      const first = container.querySelector<HTMLButtonElement>(`[aria-label="${firstLabel}"]`)!
      const next = container.querySelector<HTMLButtonElement>(`[aria-label="${nextLabel}"]`)!
      const hover = (element: Element): void => {
        fireEvent.pointerOver(element, { pointerType: 'mouse' })
        fireEvent.pointerMove(element, { pointerType: 'mouse' })
      }
      const leave = (element: Element): void => {
        fireEvent.pointerLeave(element)
        fireEvent.pointerMove(document.body, { pointerType: 'mouse', clientX: 1000, clientY: 1000 })
      }
      expect(first.hasAttribute('title')).toBe(false)
      hover(first)
      await act(async () => vi.advanceTimersByTimeAsync(delay - 1))
      expect(first.getAttribute('data-state')).toBe('closed')
      await act(async () => vi.advanceTimersByTimeAsync(1))
      expect(first.getAttribute('data-state')).toBe('delayed-open')
      leave(first)
      hover(next)
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(next.getAttribute('data-state')).toBe('instant-open')
      leave(next)
      await act(async () => vi.advanceTimersByTimeAsync(301))
      hover(first)
      await act(async () => vi.advanceTimersByTimeAsync(delay - 1))
      expect(first.getAttribute('data-state')).toBe('closed')
      await act(async () => vi.advanceTimersByTimeAsync(1))
      expect(first.getAttribute('data-state')).toBe('delayed-open')
      act(() => fireEvent.keyDown(first, { key: 'Escape' }))
      expect(first.getAttribute('data-state')).toBe('closed')
    }
  )

  it('explains page entry on focus and dismisses the hint while editing or cancelling', async () => {
    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/hints.pdf" name="hints.pdf" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    const button = container.querySelector<HTMLButtonElement>('[data-pdf-page-control] button')!
    await act(async () => button.focus())
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Click to enter a page number'
    )
    await act(async () => button.click())
    const input = container.querySelector<HTMLInputElement>('[data-pdf-page-control] input')!
    expect(document.activeElement).toBe(input)
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    act(() => fireEvent.change(input, { target: { value: '99' } }))
    act(() => fireEvent.keyDown(input, { key: 'Escape' }))
    expect(container.querySelector('[data-pdf-page-control]')?.textContent).toBe('1/1')
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('provides keyboard hints for search actions and the sidebar close action', async () => {
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 2, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/hints.pdf" name="hints.pdf" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Search"]')!.click()
    )
    act(() =>
      fireEvent.change(container.querySelector('[aria-label="Search document"]')!, {
        target: { value: 'Selectable' }
      })
    )
    await vi.waitFor(() =>
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="Next match"]')?.disabled
      ).toBe(false)
    )
    for (const label of ['Previous match', 'Next match', 'Close search']) {
      const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
      await act(async () => button.focus())
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(label)
      act(() => fireEvent.keyDown(button, { key: 'Escape' }))
      expect(document.querySelector('[role="tooltip"]')).toBeNull()
    }
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!.click()
    )
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Show navigation"]')!.click()
    )
    const close = container.querySelector<HTMLButtonElement>(
      'aside [aria-label="Hide navigation"]'
    )!
    expect(close.hasAttribute('title')).toBe(false)
    await act(async () => close.focus())
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Hide navigation')
    await act(async () => close.click())
    expect(container.querySelector('aside')).toBeNull()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    expect(
      container.querySelector('[aria-label="Show navigation"] .lucide-panel-left')
    ).not.toBeNull()
  })

  it('matches the artifact image zoom action order and reset icon', async () => {
    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/paper.pdf" name="paper.pdf" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())

    const zoomButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter(
      (button) => ['Zoom in', 'Zoom out', 'Reset zoom'].includes(button.ariaLabel ?? '')
    )
    expect(zoomButtons.map((button) => button.ariaLabel)).toEqual([
      'Zoom in',
      'Zoom out',
      'Reset zoom'
    ])
    expect(zoomButtons.at(-1)?.querySelector('.lucide-shrink')).not.toBeNull()
    expect(
      container.querySelector('[data-pdf-controls="view"] [aria-label="Select area for Agent"]')
    ).toBeNull()
    expect(
      container.querySelector('[data-pdf-controls="interaction"] [aria-label="Back"]')
    ).toBeNull()
    expect(
      container.querySelector('[data-pdf-controls="interaction"] [aria-label="Forward"]')
    ).toBeNull()
    expect(
      Array.from(container.querySelectorAll('[data-pdf-controls="view"] button')).every(
        (button) => button.getAttribute('data-size') === 'icon-sm'
      )
    ).toBe(true)
  })

  it('shows the current and total pages and navigates from an entered page number', async () => {
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/paper.pdf" name="paper.pdf" />)
    })
    await vi.waitFor(() =>
      expect(container.querySelectorAll<HTMLElement>('[data-page-number]')).toHaveLength(3)
    )

    const pageControl = container.querySelector<HTMLElement>('[data-pdf-page-control]')!
    expect(pageControl.textContent).toBe('1/3')
    await act(async () =>
      pageControl.querySelector<HTMLButtonElement>('[aria-label="Page 1 of 3"]')?.click()
    )

    const input = pageControl.querySelector<HTMLInputElement>('input')!
    const pageThree = container.querySelector<HTMLElement>('[data-page-number="3"]')!
    const scrollIntoView = vi.spyOn(pageThree, 'scrollIntoView')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '3')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' })
    expect(pageControl.textContent).toBe('3/3')
  })

  it('defaults to Select and lets Hand drag the PDF viewport', async () => {
    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/paper.pdf" name="paper.pdf" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())

    const interactionControls = container.querySelector('[data-pdf-controls="interaction"]')
    const select = interactionControls?.querySelector<HTMLButtonElement>('[aria-label="Select"]')
    const hand = interactionControls?.querySelector<HTMLButtonElement>('[aria-label="Hand"]')
    expect(select?.getAttribute('aria-pressed')).toBe('true')
    expect(hand?.getAttribute('aria-pressed')).toBe('false')

    await act(async () => hand?.click())
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    expect(scroll.dataset.pdfCursorMode).toBe('hand')
    scroll.scrollLeft = 100
    scroll.scrollTop = 200
    scroll.setPointerCapture = vi.fn()
    scroll.hasPointerCapture = vi.fn(() => true)
    scroll.releasePointerCapture = vi.fn()

    await act(async () => dispatchPointer(scroll, 'pointerdown', { clientX: 50, clientY: 60 }))
    expect(scroll.className).toContain('cursor-grabbing')
    act(() => dispatchPointer(scroll, 'pointermove', { clientX: 30, clientY: 20 }))
    expect(scroll.scrollLeft).toBe(120)
    expect(scroll.scrollTop).toBe(240)
    await act(async () => dispatchPointer(scroll, 'pointerup', { clientX: 30, clientY: 20 }))
    expect(scroll.className).toContain('cursor-grab')
    expect(scroll.className).not.toContain('cursor-grabbing')
  })

  it('marks PDF.js whitespace spans so native selection does not paint detached blocks', async () => {
    getPage.mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      getTextContent: vi
        .fn()
        .mockResolvedValue({ items: [{ str: 'Evidence' }, { str: ' ' }], styles: {} }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/paper.pdf" name="paper.pdf" />)
    })

    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-pdf-text-layer] span:last-of-type')?.classList
      ).toContain('pdf-text-layer-whitespace')
    )
    expect(
      container.querySelector('[data-pdf-text-layer] span:first-of-type')?.classList
    ).not.toContain('pdf-text-layer-whitespace')
  })

  it('coalesces scroll signals into 100ms page updates and skips unchanged pages', async () => {
    vi.useFakeTimers()
    const onReadingPositionChange = vi.fn()
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    await act(async () => {
      root.render(
        <PdfPreviewContent
          path="/workspace/reading.pdf"
          name="reading.pdf"
          source="local"
          onReadingPositionChange={onReadingPositionChange}
        />
      )
    })
    await vi.waitFor(() =>
      expect(container.querySelectorAll<HTMLElement>('[data-page-number]')).toHaveLength(3)
    )
    await act(async () => vi.runOnlyPendingTimersAsync())

    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'))
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 600,
      height: 600
    } as DOMRect)
    let scrollOffset = 390
    pages.forEach((page, index) => {
      vi.spyOn(page, 'getBoundingClientRect').mockImplementation(() => {
        const top = index * 700 - scrollOffset
        return {
          top,
          bottom: top + 600,
          height: 600
        } as DOMRect
      })
    })

    onReadingPositionChange.mockClear()
    act(() => scroll.dispatchEvent(new Event('scroll')))
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(onReadingPositionChange).not.toHaveBeenCalled()

    scrollOffset = 410
    act(() => {
      scroll.dispatchEvent(new Event('scroll'))
      scroll.dispatchEvent(new Event('scroll'))
      scroll.dispatchEvent(new Event('scroll'))
    })

    expect(onReadingPositionChange).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(99))
    expect(onReadingPositionChange).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))

    expect(onReadingPositionChange).toHaveBeenCalledOnce()
    expect(onReadingPositionChange).toHaveBeenCalledWith({ pageNumber: 2, pageCount: 3 })

    act(() => scroll.dispatchEvent(new Event('scroll')))
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(onReadingPositionChange).toHaveBeenCalledOnce()

    scrollOffset = 1_110
    act(() => scroll.dispatchEvent(new Event('scroll')))
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(onReadingPositionChange).toHaveBeenCalledTimes(2)
    expect(onReadingPositionChange).toHaveBeenLastCalledWith({ pageNumber: 3, pageCount: 3 })
  })

  it('uses each PDF page aspect ratio instead of stretching it into a fixed frame', async () => {
    getPage.mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 900, height: 450 })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/landscape.pdf" name="landscape.pdf" source="local" />
      )
    })
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          container.querySelector<HTMLElement>('[data-page-number="1"] [data-pdf-page-ready]')
            ?.style.aspectRatio
        ).toBe('2 / 1')
      )
    })

    expect(getPage).toHaveBeenCalledWith(1)
  })

  it('rasterizes at the on-screen width times device pixel ratio, not the page point size', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(700)
    vi.stubGlobal('devicePixelRatio', 2)
    // Base page is 350pt wide; a 700px frame at 2x should back the canvas at 1400px (scale 4).
    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 350 * scale,
        height: 500 * scale
      })),
      render,
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/sharp.pdf" name="sharp.pdf" source="local" />)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const canvas = container.querySelector<HTMLCanvasElement>('canvas')
    expect(canvas?.width).toBe(1400)
    expect(canvas?.height).toBe(2000)

    clientWidthSpy.mockRestore()
  })

  it('re-rasterizes at a higher resolution when the user zooms in', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/zoom.pdf" name="zoom.pdf" source="local" />)
    })
    // At fit width (100%) the 400pt page backs the canvas at its own width.
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLCanvasElement>('canvas')?.width).toBe(400)
    )

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })

    // 125% zoom widens the page and re-rasterizes rather than upscaling the old bitmap.
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLCanvasElement>('canvas')?.width).toBe(500)
    )
    expect(container.textContent).toContain('125%')
    expect(container.querySelector<HTMLCanvasElement>('canvas')?.height).toBe(700)

    clientWidthSpy.mockRestore()
  })

  it('keeps the PDF text layer on the same scale as the zoomed page', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale,
        scale
      })),
      getTextContent: vi
        .fn()
        .mockResolvedValue({ items: [{ str: 'Selectable text' }], styles: {} }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/text-scale.pdf" name="text-scale.pdf" source="local" />
      )
    })
    await vi.waitFor(() =>
      expect(
        container
          .querySelector<HTMLElement>('[data-pdf-text-layer]')
          ?.style.getPropertyValue('--total-scale-factor')
      ).toBe('1')
    )

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })

    await vi.waitFor(() =>
      expect(
        container
          .querySelector<HTMLElement>('[data-pdf-text-layer]')
          ?.style.getPropertyValue('--total-scale-factor')
      ).toBe('1.25')
    )

    clientWidthSpy.mockRestore()
  })

  it('projects persisted PDF Evidence from normalized coordinates and exposes area selection', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    const source = {
      kind: 'upload-version' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      versionId: 'version-1',
      name: 'paper.pdf',
      path: 'upload-version:project-1/session-1/version-1',
      checksum: 'a'.repeat(64)
    }
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    const onRemoveAnnotation = vi.fn(() => queueMicrotask(() => outside.focus()))
    const onUndoAnnotation = vi.fn(() => true)
    const onRedoAnnotation = vi.fn(() => true)

    await act(async () => {
      root.render(
        <PdfPreviewContent
          path={source.path}
          name={source.name}
          source="upload"
          projectId={source.projectId}
          sessionId={source.sessionId}
          managedFileId="upload-1"
          selectedVersionId={source.versionId}
          pdfEvidenceSource={source}
          annotationProps={{
            item: {
              id: 'upload:version-1',
              type: 'file',
              format: 'pdf',
              source: 'upload',
              projectId: source.projectId,
              sessionId: source.sessionId,
              path: source.path,
              name: source.name,
              title: source.name,
              mimeType: 'application/pdf'
            },
            activeAnnotations: [
              {
                id: 'region-1',
                kind: 'pdf',
                target: 'agent',
                source,
                selector: {
                  kind: 'region',
                  pageNumber: 1,
                  rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
                  pageRotation: 0,
                  image: { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
                }
              },
              {
                id: 'stale-region',
                kind: 'pdf',
                target: 'agent',
                source: { ...source, checksum: 'b'.repeat(64) },
                selector: {
                  kind: 'region',
                  pageNumber: 1,
                  rect: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
                  pageRotation: 0,
                  image: { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
                }
              }
            ],
            onAddAnnotation: vi.fn(),
            onRemoveAnnotation,
            onUndoAnnotation,
            onRedoAnnotation
          }}
        />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())

    const highlight = container.querySelector<HTMLElement>(
      '[data-pdf-evidence-highlight="region-1"]'
    )
    expect(highlight?.style.left).toBe('10%')
    expect(highlight?.style.top).toBe('20%')
    expect(highlight?.style.width).toBe('30%')
    expect(highlight?.style.height).toBe('40%')
    expect(container.querySelector('[data-pdf-evidence-highlight="stale-region"]')).toBeNull()
    await act(async () => highlight?.click())
    expect(highlight?.getAttribute('aria-pressed')).toBe('true')
    await act(async () =>
      container
        .querySelector('[data-pdf-preview-root]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    )
    expect(onRemoveAnnotation).toHaveBeenCalledWith('region-1')

    const removeButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove PDF area"]'
    )!
    expect(removeButton.style.left).toBe('40%')
    expect(removeButton.style.top).toBe('20%')
    expect(removeButton.style.transform).toBe('translate(-50%, -50%)')
    onRemoveAnnotation.mockClear()
    await act(async () => removeButton.click())
    expect(onRemoveAnnotation).toHaveBeenCalledWith('region-1')
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(container.querySelector('[role="region"]'))
    )

    const preview = document.activeElement!
    await act(async () =>
      preview.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
      )
    )
    await act(async () =>
      preview.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    await act(async () =>
      preview.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'y',
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    expect(onUndoAnnotation).toHaveBeenCalledTimes(1)
    expect(onRedoAnnotation).toHaveBeenCalledTimes(2)
    outside.remove()

    const revealScroll = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>
    revealScroll.mockClear()
    const regionAnnotation = {
      id: 'region-1',
      kind: 'pdf' as const,
      target: 'agent' as const,
      source,
      selector: {
        kind: 'region' as const,
        pageNumber: 1,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        pageRotation: 0,
        image: { mimeType: 'image/png' as const, data: 'AQID', byteLength: 3 }
      }
    }
    await act(async () => {
      requestAnnotationReveal(regionAnnotation)
    })

    expect(revealScroll).toHaveBeenCalledWith({
      block: 'center',
      inline: 'center',
      behavior: 'smooth'
    })
    const revealed = container.querySelector<HTMLElement>(
      '[data-pdf-evidence-highlight="region-1"]'
    )
    expect(revealed?.dataset.pdfEvidenceRevealed).toBe('true')
    expect(revealed?.classList.contains('pdf-evidence-reveal')).toBe(true)

    revealScroll.mockClear()
    await act(async () => requestAnnotationReveal(regionAnnotation))
    expect(revealScroll).toHaveBeenCalledWith({
      block: 'center',
      inline: 'center',
      behavior: 'smooth'
    })
    expect(container.querySelector('[data-pdf-evidence-highlight="region-1"]')).not.toBe(revealed)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Select area for Agent"]')?.click()
    })
    expect(container.querySelector('[data-pdf-region-selection="true"]')).not.toBeNull()
    expect(
      container
        .querySelector('[data-pdf-controls="interaction"] [aria-label="Select area for Agent"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true')
    expect(
      container.querySelector('[data-pdf-controls="view"] [aria-label="Select area for Agent"]')
    ).toBeNull()

    const areaSelection = container.querySelector<HTMLElement>(
      '[data-pdf-region-selection="true"]'
    )!
    areaSelection.setPointerCapture = vi.fn()
    areaSelection.hasPointerCapture = vi.fn(() => true)
    Object.defineProperty(areaSelection, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 400, bottom: 560, width: 400, height: 560 })
    })
    await act(async () =>
      dispatchPointer(areaSelection, 'pointerdown', {
        pointerId: 9,
        button: 2,
        clientX: 40,
        clientY: 56
      })
    )
    await act(async () => {
      dispatchPointer(areaSelection, 'pointermove', {
        pointerId: 9,
        button: 2,
        clientX: 200,
        clientY: 280
      })
    })
    expect(container.querySelector('[data-pdf-region-draft="true"]')).toBeNull()

    clientWidthSpy.mockRestore()
  })

  it('keeps the toolbar text tool exclusive, preserves its style, and exits on Escape', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      drawImage: vi.fn()
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID')
    const source = {
      kind: 'upload-version' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceFileId: 'upload-1',
      versionId: 'version-1',
      name: 'paper.pdf',
      path: 'upload-version:version-1',
      checksum: 'a'.repeat(64)
    }
    const onAddAnnotation = vi.fn()
    const create = vi.fn(async (input) => ({
      ...input,
      version: 1,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z'
    }))
    window.api = {
      ...window.api,
      pdfAnnotations: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), create }
    } as unknown as Window['api']
    await act(async () => {
      root.render(
        <TooltipProvider>
          <PdfAnnotationsProvider projectId="project-1" sessionId="session-1">
            <PdfPreviewContent
              path={source.path}
              name={source.name}
              source="upload"
              projectId={source.projectId}
              sessionId={source.sessionId}
              managedFileId="upload-1"
              selectedVersionId={source.versionId}
              pdfEvidenceSource={source}
              pdfBookmarkSource={source}
              annotationProps={{
                item: {
                  id: 'upload-1',
                  type: 'file',
                  format: 'pdf',
                  source: 'upload',
                  projectId: 'project-1',
                  sessionId: 'session-1',
                  path: source.path,
                  name: source.name,
                  title: source.name
                },
                onAddAnnotation
              }}
            />
          </PdfAnnotationsProvider>
        </TooltipProvider>
      )
      await flush()
    })
    const tool = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>('[aria-label="Annotate selected text"]')!
    expect(tool().disabled).toBe(false)
    await act(async () => tool().click())
    expect(tool().getAttribute('aria-pressed')).toBe('true')
    const styleTrigger = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>('[aria-label="Mark style"]')!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const previousFocus = document.activeElement
    await act(async () => {
      fireEvent.pointerEnter(tool(), { pointerType: 'mouse' })
      await vi.advanceTimersByTimeAsync(120)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => {
      fireEvent.pointerEnter(styleTrigger(), { pointerType: 'mouse' })
      await vi.advanceTimersByTimeAsync(120)
    })
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(document.activeElement).toBe(previousFocus)
    await act(async () => {
      fireEvent.pointerLeave(styleTrigger(), { pointerType: 'mouse' })
      fireEvent.pointerEnter(screen.getByRole('dialog'), { pointerType: 'mouse' })
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(screen.getByRole('dialog')).not.toBeNull()
    await act(async () => {
      fireEvent.pointerLeave(screen.getByRole('dialog'), { pointerType: 'mouse' })
      await vi.advanceTimersByTimeAsync(180)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    const areaTrigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Area selection actions"]'
    )!
    await act(async () => {
      fireEvent.pointerEnter(areaTrigger, { pointerType: 'mouse' })
      await vi.advanceTimersByTimeAsync(120)
    })
    expect(screen.getByRole('menu')).not.toBeNull()
    await act(async () => {
      fireEvent.pointerLeave(areaTrigger, { pointerType: 'mouse' })
      fireEvent.pointerEnter(screen.getByRole('menu'), { pointerType: 'mouse' })
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(screen.getByRole('menu')).not.toBeNull()
    await act(async () => {
      fireEvent.pointerDown(areaTrigger, { button: 0, pointerType: 'mouse' })
      fireEvent.pointerLeave(screen.getByRole('menu'), { pointerType: 'mouse' })
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(screen.getByRole('menu')).not.toBeNull()
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    })
    expect(screen.queryByRole('menu')).toBeNull()
    vi.useRealTimers()
    await act(async () => styleTrigger().click())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Wavy underline' })))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Purple' })))
    expect(screen.getByRole('button', { name: 'Purple' }).getAttribute('aria-pressed')).toBe('true')
    await act(async () =>
      fireEvent.keyDown(screen.getByRole('button', { name: 'Purple' }), { key: 'Escape' })
    )
    expect(tool().getAttribute('aria-pressed')).toBe('true')
    container.setAttribute('role', 'dialog')
    await act(async () =>
      fireEvent.keyDown(container.querySelector('[data-pdf-preview-root]')!, { key: 'Escape' })
    )
    await act(flush)
    expect(tool().getAttribute('aria-pressed')).toBe('false')
    expect(
      container.querySelector('[data-pdf-cursor-mode]')?.getAttribute('data-pdf-cursor-mode')
    ).toBe('select')
    await act(async () => tool().click())
    await act(async () => styleTrigger().click())
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(
      screen.getByRole('button', { name: 'Wavy underline' }).getAttribute('aria-pressed')
    ).toBe('true')
    await act(async () =>
      fireEvent.keyDown(screen.getByRole('button', { name: 'Purple' }), { key: 'Escape' })
    )
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Hand"]')!.click()
    )
    expect(tool().getAttribute('aria-pressed')).toBe('false')
    expect(create).not.toHaveBeenCalled()
    expect(onAddAnnotation).not.toHaveBeenCalled()
  })

  it('keeps area-to-Agent immediate and routes area annotations independently, then resets the mode', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      drawImage: vi.fn()
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID')
    const source = {
      kind: 'upload-version' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceFileId: 'upload-1',
      versionId: 'version-1',
      name: 'paper.pdf',
      path: 'upload-version:version-1',
      checksum: 'a'.repeat(64)
    }
    const onAddAnnotation = vi.fn()
    const create = vi.fn(async (input) => ({
      ...input,
      version: 1,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z'
    }))
    window.api = {
      ...window.api,
      pdfAnnotations: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), create }
    } as unknown as Window['api']
    await act(async () => {
      root.render(
        <TooltipProvider>
          <PdfAnnotationsProvider projectId="project-1" sessionId="session-1">
            <PdfPreviewContent
              path={source.path}
              name={source.name}
              source="upload"
              projectId={source.projectId}
              sessionId={source.sessionId}
              managedFileId="upload-1"
              selectedVersionId={source.versionId}
              pdfEvidenceSource={source}
              pdfBookmarkSource={source}
              annotationProps={{
                item: {
                  id: 'upload-1',
                  type: 'file',
                  format: 'pdf',
                  source: 'upload',
                  projectId: 'project-1',
                  sessionId: 'session-1',
                  path: source.path,
                  name: source.name,
                  title: source.name
                },
                onAddAnnotation
              }}
            />
          </PdfAnnotationsProvider>
        </TooltipProvider>
      )
      await flush()
    })
    const dragArea = async (): Promise<void> => {
      const overlay = container.querySelector<HTMLElement>('[data-pdf-region-selection]')!
      expect(overlay).not.toBeNull()
      overlay.setPointerCapture = vi.fn()
      overlay.hasPointerCapture = vi.fn(() => true)
      overlay.releasePointerCapture = vi.fn()
      overlay.getBoundingClientRect = () => new DOMRect(0, 0, 400, 560)
      await act(async () =>
        dispatchPointer(overlay, 'pointerdown', { clientX: 40, clientY: 56, button: 0 })
      )
      await act(async () =>
        dispatchPointer(overlay, 'pointerup', { clientX: 200, clientY: 280, button: 0 })
      )
    }
    const startAnnotation = async (): Promise<void> => {
      await act(async () =>
        fireEvent.keyDown(container.querySelector('[aria-label="Area selection actions"]')!, {
          key: 'Enter'
        })
      )
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (item) => item.textContent === 'Select area to annotate'
      )!
      expect(item).toBeDefined()
      await act(async () => item.click())
      // Let the closing menu restore focus before beginning the next pointer gesture.
      await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      expect(container.textContent).toContain('Drag to annotate an area')
    }
    const expectReset = (): void => {
      expect(container.querySelector('[data-pdf-region-selection]')).toBeNull()
      expect(document.querySelector('[data-pdf-region-bookmark-editor]')).toBeNull()
      expect(container.querySelector('[aria-label="Select"]')?.getAttribute('aria-pressed')).toBe(
        'true'
      )
      expect(
        container
          .querySelector('[aria-label="Select area for Agent"]')
          ?.getAttribute('aria-pressed')
      ).toBe('false')
    }
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Select area for Agent"]')!.click()
    )
    await dragArea()
    expect(onAddAnnotation).toHaveBeenCalledTimes(1)
    expect(onAddAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'pdf',
        target: 'agent',
        selector: expect.objectContaining({
          kind: 'region',
          image: expect.objectContaining({ mimeType: 'image/png' })
        })
      })
    )
    expect(create).not.toHaveBeenCalled()
    expectReset()

    await startAnnotation()
    await dragArea()
    await waitFor(() =>
      expect(document.querySelector('[data-pdf-region-bookmark-editor]')).not.toBeNull()
    )
    const editor = document.querySelector<HTMLElement>('[data-pdf-region-bookmark-editor]')!
    expect(editor.textContent).not.toContain('For me')
    expect(editor.querySelector('[role="tablist"]')).toBeNull()
    await act(async () =>
      fireEvent.change(editor.querySelector('textarea')!, {
        target: { value: 'Compare the chart with Figure 2.' }
      })
    )
    await act(async () =>
      Array.from(editor.querySelectorAll('button'))
        .find((button) => button.textContent === 'Save annotation')!
        .click()
    )
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'area',
        note: 'Compare the chart with Figure 2.',
        target: expect.objectContaining({
          selector: expect.objectContaining({ kind: 'region', coordinateVersion: 1 })
        })
      })
    )
    expect(onAddAnnotation).toHaveBeenCalledTimes(1)
    expectReset()

    await startAnnotation()
    await dragArea()
    await act(async () =>
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Cancel')!
        .click()
    )
    expectReset()
    await startAnnotation()
    await dragArea()
    await waitFor(() =>
      expect(document.querySelector('[data-pdf-region-bookmark-editor] textarea')).not.toBeNull()
    )
    await act(async () =>
      fireEvent.keyDown(document.querySelector('[data-pdf-region-bookmark-editor] textarea')!, {
        key: 'Escape'
      })
    )
    expectReset()
    expect(create).toHaveBeenCalledTimes(1)
    expect(onAddAnnotation).toHaveBeenCalledTimes(1)
  })

  it('reveals sent PDF Evidence after the composer draft annotations are cleared', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    const source = {
      kind: 'upload-version' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      versionId: 'version-1',
      name: 'paper.pdf',
      path: 'upload-version:project-1/session-1/version-1',
      checksum: 'a'.repeat(64)
    }
    const annotation = {
      id: 'sent-region-1',
      kind: 'pdf' as const,
      target: 'agent' as const,
      source,
      selector: {
        kind: 'region' as const,
        pageNumber: 1,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        pageRotation: 0,
        image: { mimeType: 'image/png' as const, data: 'AQID', byteLength: 3 }
      }
    }

    await act(async () => {
      root.render(
        <PdfPreviewContent
          path={source.path}
          name={source.name}
          source="upload"
          projectId={source.projectId}
          sessionId={source.sessionId}
          managedFileId="upload-1"
          selectedVersionId={source.versionId}
          pdfRevealSource={source}
          annotationProps={{
            item: {
              id: 'upload:version-1',
              type: 'file',
              format: 'pdf',
              source: 'upload',
              projectId: source.projectId,
              sessionId: source.sessionId,
              path: source.path,
              name: source.name,
              title: source.name,
              mimeType: 'application/pdf'
            },
            activeAnnotations: []
          }}
        />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())

    await act(async () => requestAnnotationReveal(annotation))

    await vi.waitFor(() =>
      expect(
        container.querySelector<HTMLElement>('[data-pdf-evidence-highlight="sent-region-1"]')
          ?.dataset.pdfEvidenceRevealed
      ).toBe('true')
    )

    clientWidthSpy.mockRestore()
  })

  it('left-aligns pages once zoomed past fit so the left edge stays reachable', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/align.pdf" name="align.pdf" source="local" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBe(400))

    // At fit width the pages column is centered.
    const column = container.querySelector('[data-page-number]')?.parentElement
    expect(column?.className).toContain('items-center')
    expect(column?.className).not.toContain('items-start')

    // Zoomed wider than the pane, it must left-align so scrollLeft=0 reaches the true left edge.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(container.querySelector('[data-page-number]')?.parentElement?.className).toContain(
        'items-start'
      )
    )
    expect(container.querySelector('[data-page-number]')?.parentElement?.className).not.toContain(
      'items-center'
    )

    clientWidthSpy.mockRestore()
  })

  it('preserves viewport positions across zoom, native links and reading history', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getPage,
        destroy: destroyDocument
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale,
        rotation: 0
      })),
      getTextContent: vi.fn().mockResolvedValue({ items: [], styles: {} }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/anchor.pdf" name="anchor.pdf" source="local" />
      )
    })
    await vi.waitFor(() =>
      expect(container.querySelectorAll<HTMLElement>('[data-page-number]')).toHaveLength(3)
    )

    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'))
    scroll.scrollTop = 700
    scroll.scrollLeft = 50
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 400,
      top: 0,
      bottom: 600,
      width: 400,
      height: 600
    } as DOMRect)
    pages.forEach((page, index) => {
      vi.spyOn(page, 'getBoundingClientRect').mockImplementation(() => {
        const width = Number.parseFloat(page.style.width)
        const height = width * 1.4
        const top = 16 + index * (height + 12) - scroll.scrollTop
        return {
          left: 16 - scroll.scrollLeft,
          right: 16 - scroll.scrollLeft + width,
          top,
          bottom: top + height,
          width,
          height
        } as DOMRect
      })
      vi.spyOn(
        page.querySelector<HTMLElement>('[data-pdf-page-rotation]')!,
        'getBoundingClientRect'
      ).mockImplementation(() => page.getBoundingClientRect())
    })

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
    )

    await vi.waitFor(() => expect(container.textContent).toContain('125%'))
    expect(scroll.scrollTop).toBe(868)
    expect(scroll.scrollLeft).toBe(58.5)

    const navigate = (): Parameters<typeof renderPdfNativeLinks>[0]['onNavigate'] =>
      vi.mocked(renderPdfNativeLinks).mock.calls.at(-1)![0].onNavigate
    await act(async () => navigate()({ pageNumber: 3, x: 0.2, y: 0.5 }))
    expect(scroll.scrollTop).toBeCloseTo(16 + 2 * 712 + 350 - 72)
    expect(scroll.scrollLeft).toBeCloseTo(16 + 100)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Previous reading position' }).disabled
    ).toBe(false)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Next reading position' }).disabled
    ).toBe(true)
    // Manual movement and zoom at the destination become the forward destination.
    scroll.scrollTop += 50
    await act(async () => screen.getByRole('button', { name: 'Zoom in' }).click())
    const destinationTop = scroll.scrollTop,
      destinationLeft = scroll.scrollLeft
    await act(async () => screen.getByRole('button', { name: 'Previous reading position' }).click())
    expect(container.textContent).toContain('125%')
    expect(scroll.scrollTop).toBeCloseTo(868)
    expect(scroll.scrollLeft).toBeCloseTo(58.5)
    await act(async () => screen.getByRole('button', { name: 'Next reading position' }).click())
    expect(container.textContent).toContain('150%')
    expect(scroll.scrollTop).toBeCloseTo(destinationTop)
    expect(scroll.scrollLeft).toBeCloseTo(destinationLeft)
    await act(async () => screen.getByRole('button', { name: 'Previous reading position' }).click())
    await act(async () => navigate()({ pageNumber: 1, x: 0, y: 0 }))
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Next reading position' }).disabled
    ).toBe(true)
    // Switching files in an unkeyed preview must not retain old document locations.
    await act(async () =>
      root.render(<PdfPreviewContent path="/workspace/new.pdf" name="new.pdf" source="local" />)
    )
    expect(screen.queryByRole('button', { name: 'Previous reading position' })).toBeNull()

    clientWidthSpy.mockRestore()
  })

  it('exposes the scroll container as a keyboard-focusable region', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/a11y.pdf" name="a11y.pdf" source="local" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBe(400))

    // The inner scroller (parent of the measurement probe) owns overflow, so it must be reachable
    // by keyboard — the outer surface that gets focus is not the scrollable element.
    const scroll = container.querySelector<HTMLElement>('[aria-hidden="true"]')?.parentElement
    expect(scroll?.getAttribute('tabindex')).toBe('0')
    expect(scroll?.getAttribute('role')).toBe('region')
    expect(scroll?.getAttribute('aria-label')).toContain('a11y.pdf')

    clientWidthSpy.mockRestore()
  })

  it('keeps a zoomed page centered on a wide pane until it overflows the real viewport', async () => {
    // Pane is 1200px wide — well past the 768 reading-width cap. fitWidth caps at 768 but the
    // overflow decision must use the real 1200px viewport, not the cap.
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(1200)
    vi.stubGlobal('devicePixelRatio', 1)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 595 * scale,
        height: 842 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/wide.pdf" name="wide.pdf" source="local" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBeGreaterThan(0))

    const columnClass = (): string =>
      container.querySelector('[data-page-number]')?.parentElement?.className ?? ''

    // 125% (page 768*1.25 = 960px) still fits the 1200px pane → stays centered (regression check).
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('125%'))
    expect(columnClass()).toContain('items-center')
    expect(columnClass()).not.toContain('items-start')

    // 150% (960 -> 1152px) still fits → still centered.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('150%'))
    expect(columnClass()).toContain('items-center')

    // 175% (768*1.75 = 1344px) overflows the 1200px pane → now left-aligns.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('175%'))
    expect(columnClass()).toContain('items-start')
    expect(columnClass()).not.toContain('items-center')

    clientWidthSpy.mockRestore()
  })

  it('coalesces same-frame Ctrl/Cmd+wheel into one proportional zoom and ignores plain scroll', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    // Controllable rAF: capture the scheduled callback so same-frame events can be coalesced and
    // flushed once on demand, rather than running synchronously per event.
    let scheduled: { id: number; cb: FrameRequestCallback } | null = null
    let nextRafId = 1
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      scheduled = { id: nextRafId, cb }
      return nextRafId++
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      if (scheduled?.id === id) scheduled = null
    })
    const flushFrame = (): void => {
      const pending = scheduled
      scheduled = null
      pending?.cb(0)
    }
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/wheel.pdf" name="wheel.pdf" source="local" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBe(400))
    // Radix tab panels use one frame to suppress their initial enter animation.
    await act(async () => flushFrame())

    // The scroll container owns the wheel listener; it is the parent of the measurement probe.
    const scroll = container.querySelector<HTMLElement>('[aria-hidden="true"]')?.parentElement
    expect(scroll).toBeTruthy()

    // A plain wheel scroll schedules nothing and must not zoom.
    await act(async () => {
      scroll?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
      )
      await Promise.resolve()
    })
    expect(scheduled).toBeNull()
    expect(container.textContent).toContain('100%')

    // Two Ctrl+wheel events in the same frame coalesce: only one frame is scheduled and their
    // deltas sum (-200 * 0.0025 = +0.5), so a single flush yields 150%, not two separate steps.
    await act(async () => {
      scroll?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
      )
      scroll?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
      )
      flushFrame()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('150%'))

    // The Cmd (metaKey) branch also zooms: deltaY +100 * 0.0025 = -0.25 (150% -> 125%).
    await act(async () => {
      scroll?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 100, metaKey: true, bubbles: true, cancelable: true })
      )
      flushFrame()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('125%'))

    clientWidthSpy.mockRestore()
  })

  it('drops a queued wheel zoom when the file switches before the frame flushes', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    // Faithful rAF/cancel: a canceled frame cannot be flushed, mirroring the browser.
    let scheduled: { id: number; cb: FrameRequestCallback } | null = null
    let nextRafId = 1
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      scheduled = { id: nextRafId, cb }
      return nextRafId++
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      if (scheduled?.id === id) scheduled = null
    })
    const flushFrame = (): void => {
      const pending = scheduled
      scheduled = null
      pending?.cb(0)
    }
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/first.pdf" name="first.pdf" source="local" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBe(400))

    const scroll = container.querySelector<HTMLElement>('[aria-hidden="true"]')?.parentElement
    // Queue a Ctrl+wheel zoom but do NOT flush the frame yet.
    await act(async () => {
      scroll?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
      )
      await Promise.resolve()
    })
    expect(scheduled).not.toBeNull()
    expect(container.textContent).toContain('100%')

    // Switch files in place before the frame runs: the wheel effect restarts on requestKey and
    // cancels the queued frame, so the stale delta cannot re-apply on top of the reset.
    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/second.pdf" name="second.pdf" source="local" />
      )
    })
    await act(async () => {
      flushFrame()
      await Promise.resolve()
    })

    // The new document stays at fit (100%); the queued 25% was dropped, not re-applied.
    expect(container.textContent).toContain('100%')
    expect(container.textContent).not.toContain('125%')

    clientWidthSpy.mockRestore()
  })

  it('resets zoom to fit when the previewed file changes in place (dialog path)', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400)
    vi.stubGlobal('devicePixelRatio', 1)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/first.pdf" name="first.pdf" source="local" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBe(400))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('125%'))

    // The Files-tab dialog swaps the file in place (same component instance, no remount / key).
    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/second.pdf" name="second.pdf" source="local" />
      )
    })

    // The new file must open fit-to-width, not inherit the previous document's zoom.
    await vi.waitFor(() => expect(container.textContent).toContain('100%'))
    expect(container.textContent).not.toContain('125%')

    clientWidthSpy.mockRestore()
  })

  it('re-rasterizes a widened page without reloading it through the range transport', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
      }
    )
    let measuredWidth = 400
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(() => measuredWidth)
    vi.stubGlobal('devicePixelRatio', 1)
    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      render,
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/resize.pdf" name="resize.pdf" source="local" />
      )
    })
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1))
    expect(getPage).toHaveBeenCalledTimes(1)
    expect(container.querySelector<HTMLCanvasElement>('canvas')?.width).toBe(400)

    // Widening the panel must re-rasterize the already-loaded page, not fetch it again.
    // Both widths stay under the fit-width cap so pageWidth tracks the measured width directly.
    await act(async () => {
      measuredWidth = 600
      resizeCallbacks[0]?.([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2))
    expect(getPage).toHaveBeenCalledTimes(1)
    expect(container.querySelector<HTMLCanvasElement>('canvas')?.width).toBe(600)
    expect(container.querySelector<HTMLElement>('[data-page-number="1"]')?.style.width).toBe(
      '600px'
    )

    // Narrowing the panel (or returning from full screen) must shrink the displayed page back to
    // fit, not leave it pinned at the old larger width forcing horizontal scroll at 100%.
    await act(async () => {
      measuredWidth = 300
      resizeCallbacks[0]?.([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLElement>('[data-page-number="1"]')?.style.width).toBe(
        '300px'
      )
    )
    expect(getPage).toHaveBeenCalledTimes(1)
    // Displayed width is responsive (300px), while the backing store never drops below the page's
    // intrinsic 400px width — the crisp bitmap simply downscales via CSS.
    expect(container.querySelector<HTMLCanvasElement>('canvas')?.width).toBe(400)

    clientWidthSpy.mockRestore()
  })

  it('preserves the page-relative viewport location when the preview changes width', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()

        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
      }
    )
    let measuredWidth = 400
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(() => measuredWidth)
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 3, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 560 * scale
      })),
      getTextContent: vi.fn().mockResolvedValue({ items: [], styles: {} }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/modal.pdf" name="modal.pdf" />)
    })
    await vi.waitFor(() =>
      expect(container.querySelectorAll<HTMLElement>('[data-page-number]')).toHaveLength(3)
    )

    const scroll = container.querySelector<HTMLElement>('[role="region"]')!
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'))
    scroll.scrollTop = 700
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 400,
      top: 0,
      bottom: 600,
      width: 400,
      height: 600
    } as DOMRect)
    pages.forEach((page, index) => {
      vi.spyOn(page, 'getBoundingClientRect').mockImplementation(() => {
        const width = Number.parseFloat(page.style.width)
        const height = width * 1.4
        const top = 16 + index * (height + 12) - scroll.scrollTop
        return { left: 16, right: 16 + width, top, bottom: top + height, width, height } as DOMRect
      })
    })

    await act(async () => {
      measuredWidth = 600
      resizeCallbacks[0]?.([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
      await Promise.resolve()
    })

    await vi.waitFor(() =>
      expect(container.querySelector<HTMLElement>('[data-page-number="1"]')?.style.width).toBe(
        '600px'
      )
    )
    expect(scroll.scrollTop).toBe(1036)

    clientWidthSpy.mockRestore()
  })

  it('clamps the backing store to browser canvas limits for a tall, narrow page', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(700)
    vi.stubGlobal('devicePixelRatio', 2)
    // A 200x12000 page in a 700px frame at 2x would want scale 4 → a 48000px-tall canvas,
    // far past Chromium's limits. The clamp must keep both dimensions within bounds.
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 200 * scale,
        height: 12000 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/tall.pdf" name="tall.pdf" source="local" />)
    })
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('canvas')?.height).toBeGreaterThan(0))
    })

    const canvas = container.querySelector<HTMLCanvasElement>('canvas')
    expect(canvas?.height).toBeLessThanOrEqual(8192)
    expect(canvas?.width).toBeLessThanOrEqual(8192)
    // Sanity: without the clamp this page would have been ~48000px tall.
    expect(canvas?.height).toBeLessThan(12000)

    clientWidthSpy.mockRestore()
  })

  it('rasterizes zoom at full high-DPI resolution, not clipped to a fixed 4x cap', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(768)
    vi.stubGlobal('devicePixelRatio', 2)
    // A4-like page (595pt wide) at the 768px fit width, zoomed to 175% on a 2x display needs a
    // backing width of 768 * 1.75 * 2 = 2688px to stay sharp. A fixed 4x cap would clip it to
    // 595 * 4 = 2380px and the browser would upscale — the blur this removal fixes.
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 595 * scale,
        height: 842 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/hidpi.pdf" name="hidpi.pdf" source="local" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBeGreaterThan(0))

    // Zoom to 175% (100 -> 125 -> 150 -> 175 via three button steps).
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
        await Promise.resolve()
      })
    }
    await vi.waitFor(() => expect(container.textContent).toContain('175%'))

    const width = container.querySelector<HTMLCanvasElement>('canvas')?.width ?? 0
    // Backing reaches the physical on-screen pixels (~2688), well past the old 2380 (4x) ceiling,
    // and stays within the browser canvas limit.
    expect(width).toBeGreaterThan(2380)
    expect(width).toBeLessThanOrEqual(2688)
    expect(width).toBeLessThanOrEqual(8192)

    clientWidthSpy.mockRestore()
  })

  it('caps the backing scale at the deepest zoom to bound per-page memory', async () => {
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(768)
    vi.stubGlobal('devicePixelRatio', 2)
    // A4-like page (595x842) at 768px fit, 300% zoom, 2x DPI: the physical target scale is
    // 768*3*2/595 = 7.74, and even the area clamp alone would allow ~5.79 (595*5.79 = 3443px).
    // The MAX_RENDER_SCALE=5 ceiling caps it to 595*5 = 2975px so a page cannot take the full
    // canvas-area budget.
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 595 * scale,
        height: 842 * scale
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/deep.pdf" name="deep.pdf" source="local" />)
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')?.width).toBeGreaterThan(0))

    // Zoom to the 300% max (eight 25% button steps).
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
        await Promise.resolve()
      })
    }
    await vi.waitFor(() => expect(container.textContent).toContain('300%'))

    const width = container.querySelector<HTMLCanvasElement>('canvas')?.width ?? 0
    // Scale is capped at 5 → 595*5 = 2975, below the ~3443 the area clamp alone would permit.
    expect(width).toBe(2975)
    expect(width).toBeLessThan(3443)

    clientWidthSpy.mockRestore()
  })

  it('clears detached canvas storage on scroll-out and reacquires it on re-entry', async () => {
    const observer = observe()
    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/release.pdf" name="release.pdf" />)
      await flush()
    })
    const page = container.querySelector('[data-page-number="1"]')!
    await observer.notify(page, true)
    const firstCanvas = container.querySelector('canvas')!
    expect(firstCanvas.width).toBeGreaterThan(0)
    expect(firstCanvas.height).toBeGreaterThan(0)

    await observer.notify(page, false)
    expect(firstCanvas.isConnected).toBe(false)
    expect(firstCanvas.width).toBe(0)
    expect(firstCanvas.height).toBe(0)
    expect(destroyDocument).not.toHaveBeenCalled()

    await observer.notify(page, true)
    const secondCanvas = container.querySelector('canvas')!
    expect(secondCanvas).not.toBe(firstCanvas)
    expect(secondCanvas.width).toBeGreaterThan(0)
    expect(secondCanvas.height).toBeGreaterThan(0)
    expect(getPage).toHaveBeenCalledTimes(2)

    await act(async () => root.unmount())
    expect(secondCanvas.isConnected).toBe(false)
    expect(secondCanvas.width).toBe(0)
    expect(secondCanvas.height).toBe(0)
    expect(destroyDocument).toHaveBeenCalledOnce()
  })

  it('treats a render canceled by scroll-out as teardown, not a page failure', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }
      }
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // A render whose promise rejects with PDF.js's cancellation error when cancel() is called.
    const cancelRender = vi.fn()
    let rejectRender: ((error: Error) => void) | undefined
    getPage.mockResolvedValue({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale
      })),
      render: vi.fn(() => ({
        promise: new Promise((_, reject) => {
          rejectRender = reject
        }),
        cancel: () => {
          cancelRender()
          rejectRender?.(
            Object.assign(new Error('Rendering cancelled'), {
              name: 'RenderingCancelledException'
            })
          )
        }
      })),
      cleanup: vi.fn()
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/scroll.pdf" name="scroll.pdf" source="local" />
      )
      await Promise.resolve()
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    // Scroll the page out: its acquire effect disposes and cancels the in-flight render.
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cancelRender).toHaveBeenCalled()
    // The cancellation must not be logged as a render failure nor shown as a page error.
    const loggedRenderFailure = consoleError.mock.calls.some((call) =>
      String(call[0]).includes('Failed to render PDF page')
    )
    expect(loggedRenderFailure).toBe(false)
    expect(container.textContent).not.toContain('could not be rendered')

    consoleError.mockRestore()
  })

  it('releases a canceled PDF load without reporting worker destruction as a failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let rejectLoadingTask!: (error: Error) => void
    const promise = new Promise((_, reject) => {
      rejectLoadingTask = reject
    })
    const destroyLoadingTask = vi.fn(async () => {
      rejectLoadingTask(new Error('Worker was destroyed'))
    })
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise,
      destroy: destroyLoadingTask
    } as never)
    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/report.pdf" name="report.pdf" source="local" />
      )
    })
    await act(async () => root.render(null))
    expect(destroyLoadingTask).toHaveBeenCalledTimes(1)
    expect(window.api.previewResources.release).toHaveBeenCalledExactlyOnceWith({
      resourceId: 'resource-1'
    })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('destroys the loading task when PDF parsing fails', async () => {
    const destroyLoadingTask = vi.fn().mockResolvedValue(undefined)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let rejectLoadingTask: ((error: Error) => void) | undefined
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: new Promise((_, reject) => {
        rejectLoadingTask = reject
      }),
      destroy: destroyLoadingTask
    } as never)

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/broken.pdf" name="broken.pdf" source="local" />
      )
      await Promise.resolve()
    })
    await act(async () => {
      rejectLoadingTask?.(new Error('Invalid PDF'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain("This PDF couldn't be rendered for preview")
    expect(destroyLoadingTask).toHaveBeenCalledTimes(1)
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource-1'
    })
    expect(destroyLoadingTask.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(window.api.previewResources.release).mock.invocationCallOrder[0] as number
    )
    consoleError.mockRestore()
  })

  it('does not render PDF pages until their containers approach the viewport', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    const observed: Element[] = []
    const createObserver = vi.fn()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn((element: Element) => observed.push(element))
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          createObserver()
          intersectionCallback = callback
        }
      }
    )
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 2, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/lazy-pages.pdf" name="lazy-pages.pdf" source="local" />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(createObserver).toHaveBeenCalledTimes(1)
    expect(getPage).not.toHaveBeenCalled()
    expect(container.querySelectorAll('canvas')).toHaveLength(0)

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true, target: observed[0] } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getPage).toHaveBeenCalledTimes(1)
    expect(getPage).toHaveBeenCalledWith(1)
    expect(container.querySelectorAll('canvas')).toHaveLength(1)
  })

  it('does not mount annotation and Evidence listeners for every page in a large PDF', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 120, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)
    const source = {
      kind: 'upload-version' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      versionId: 'version-1',
      name: 'large.pdf',
      path: 'upload-version:project-1/session-1/version-1',
      checksum: 'a'.repeat(64)
    }

    await act(async () => {
      root.render(
        <PdfPreviewContent
          path={source.path}
          name={source.name}
          source="upload"
          projectId={source.projectId}
          sessionId={source.sessionId}
          managedFileId="upload-1"
          selectedVersionId={source.versionId}
          pdfEvidenceSource={source}
          annotationProps={{
            item: {
              id: 'upload:version-1',
              type: 'file',
              format: 'pdf',
              source: 'upload',
              projectId: source.projectId,
              sessionId: source.sessionId,
              path: source.path,
              name: source.name,
              title: source.name,
              mimeType: 'application/pdf'
            },
            activeAnnotations: [],
            onAddAnnotation: vi.fn(() => undefined)
          }}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelectorAll('[data-page-number]')).toHaveLength(120)
    expect(container.querySelectorAll('[data-preview-text-annotation-surface]')).toHaveLength(0)
  })

  it('uses the compact status for a page that is still loading', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }
      }
    )
    getPage.mockReturnValue(new Promise(() => undefined))

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/loading.pdf" name="loading.pdf" source="local" />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
    })

    expect(container.querySelector('[data-preview-status="compact-loading"]')).not.toBeNull()
    expect(container.textContent).not.toContain('loading.pdf')
  })

  it('creates lazy page containers beyond page thirty', async () => {
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 31, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/long.pdf" name="long.pdf" source="local" />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelectorAll('[data-page-number]')).toHaveLength(31)
  })

  it('cleans up a page that resolves after its container leaves the viewport', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    let resolvePage: ((page: unknown) => void) | undefined
    const cleanupPage = vi.fn()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }
      }
    )
    getPage.mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve
      })
    )
    vi.mocked(createManagedPdfLoadingTask).mockReturnValue({
      promise: Promise.resolve({ numPages: 1, getPage, destroy: destroyDocument }),
      destroy: vi.fn().mockResolvedValue(undefined)
    } as never)

    await act(async () => {
      root.render(<PdfPreviewContent path="/workspace/late.pdf" name="late.pdf" source="local" />)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
    })
    await act(async () => {
      resolvePage?.({
        getViewport: vi.fn(),
        render: vi.fn(),
        cleanup: cleanupPage
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(cleanupPage).toHaveBeenCalledTimes(1)
  })

  it('cancels active page work before destroying the parent document', async () => {
    const cancelRender = vi.fn()
    const cleanupPage = vi.fn()
    const render = vi.fn(() => ({ promise: new Promise(() => undefined), cancel: cancelRender }))
    getPage.mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      render,
      cleanup: cleanupPage
    })

    await act(async () => {
      root.render(
        <PdfPreviewContent path="/workspace/active.pdf" name="active.pdf" source="local" />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    // Wait until rasterization is in flight so the render task exists to be canceled.
    await act(async () => {
      await vi.waitFor(() => expect(render).toHaveBeenCalled())
    })

    await act(async () => root.unmount())

    expect(cancelRender).toHaveBeenCalledTimes(1)
    expect(cleanupPage).toHaveBeenCalledTimes(1)
    expect(cancelRender.mock.invocationCallOrder[0]).toBeLessThan(
      destroyDocument.mock.invocationCallOrder[0] as number
    )
    expect(cleanupPage.mock.invocationCallOrder[0]).toBeLessThan(
      destroyDocument.mock.invocationCallOrder[0] as number
    )
  })

  it('selects a saved PDF mark and exposes its delete action', async () => {
    getPage.mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 600, height: 800, rotation: 0 })),
      getTextContent: vi
        .fn()
        .mockResolvedValue({ items: [{ str: 'Selectable text' }], styles: {} }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn()
    })
    const source = {
      kind: 'upload-version' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceFileId: 'upload-1',
      versionId: 'version-1',
      name: 'paper.pdf',
      path: 'upload-version:version-1',
      checksum: 'a'.repeat(64)
    }
    const annotation = {
      id: 'bookmark-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      version: 1,
      origin: 'user' as const,
      target: {
        source,
        selector: {
          kind: 'text' as const,
          pageNumber: 1,
          exact: 'Selectable text',
          position: { start: 0, end: 15 },
          quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.03 }],
          extractorVersion: 'pdfjs-test',
          pageRotation: 0,
          coordinateVersion: 1
        }
      },
      kind: 'highlight' as const,
      color: 'yellow' as const,
      tagIds: [],
      note: 'Saved note',
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z'
    }
    const deleteAnnotation = vi.fn().mockResolvedValue({ deleted: true })
    window.api = {
      ...window.api,
      tags: { snapshot: vi.fn().mockResolvedValue({ revision: 1, tags: [], assignments: [] }) },
      pdfAnnotations: {
        list: vi.fn().mockResolvedValue({ source, items: [annotation], total: 1 }),
        delete: deleteAnnotation
      }
    } as unknown as Window['api']
    await act(async () => {
      root.render(
        <PdfAnnotationsProvider projectId="project-1" sessionId="session-1">
          <PdfPreviewContent
            path={source.path}
            name={source.name}
            source="upload"
            projectId={source.projectId}
            sessionId={source.sessionId}
            managedFileId="upload-1"
            selectedVersionId={source.versionId}
            pdfBookmarkSource={source}
          />
        </PdfAnnotationsProvider>
      )
      await flush()
    })
    await vi.waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    await vi.waitFor(() =>
      expect(container.querySelector('[data-pdf-bookmark-highlight="bookmark-1"]')).not.toBeNull()
    )
    const highlight = container.querySelector<HTMLButtonElement>(
      '[data-pdf-bookmark-highlight="bookmark-1"]'
    )
    await act(async () => highlight?.click())
    expect(highlight?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[aria-label="Delete annotation"]')).toBeNull()
    const marker = container.querySelector<HTMLButtonElement>('[data-pdf-annotation-marker]')!
    await act(async () => marker.click())
    const remove = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
    ).find((button) => button.textContent === 'Delete annotation')!
    expect(remove).toBeDefined()
    await act(async () => remove.click())
    await vi.waitFor(() =>
      expect(deleteAnnotation).toHaveBeenCalledWith(expect.objectContaining({ id: 'bookmark-1' }))
    )
  })
  it.each(['literature', 'upload'] as const)(
    'handles selected annotation Escape only in the %s reader',
    async (previewSource) => {
      getPage.mockResolvedValue({
        getViewport: vi.fn(() => ({ width: 600, height: 800, rotation: 0 })),
        getTextContent: vi
          .fn()
          .mockResolvedValue({ items: [{ str: 'Selectable text' }], styles: {} }),
        render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
        cleanup: vi.fn()
      })
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
      const source = {
        kind:
          previewSource === 'literature'
            ? ('literature-attachment-version' as const)
            : ('upload-version' as const),
        projectId: 'project-1',
        sessionId: 'session-1',
        sourceFileId: 'file-1',
        versionId: 'version-1',
        name: 'paper.pdf',
        path: `${previewSource === 'literature' ? 'literature-attachment-version' : 'upload-version'}:version-1`,
        checksum: 'a'.repeat(64)
      }
      const annotation: SavedPdfAnnotation = {
        id: 'bookmark-1',
        projectId: source.projectId,
        sessionId: source.sessionId,
        version: 1,
        origin: 'user',
        target: {
          source,
          selector: {
            kind: 'text',
            pageNumber: 1,
            exact: 'Selectable text',
            position: { start: 0, end: 15 },
            quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.03 }],
            extractorVersion: 'pdfjs-test',
            pageRotation: 0,
            coordinateVersion: 1
          }
        },
        kind: 'underline',
        color: 'pink',
        tagIds: [],
        note: 'Saved note',
        createdAt: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z'
      }
      window.api = {
        ...window.api,
        tags: { snapshot: vi.fn().mockResolvedValue({ revision: 1, tags: [], assignments: [] }) },
        pdfAnnotations: {
          list: vi.fn().mockResolvedValue({ source, items: [annotation], total: 1 })
        }
      } as unknown as Window['api']
      await act(async () => {
        root.render(
          <PdfAnnotationsProvider projectId={source.projectId} sessionId={source.sessionId}>
            <PdfPreviewContent
              path={source.path}
              name={source.name}
              source={previewSource}
              projectId={source.projectId}
              sessionId={source.sessionId}
              managedFileId={source.sourceFileId}
              selectedVersionId={source.versionId}
              pdfBookmarkSource={source}
            />
          </PdfAnnotationsProvider>
        )
        await flush()
      })
      const highlight = await waitFor(() => {
        const element = container.querySelector<HTMLButtonElement>(
          '[data-pdf-bookmark-highlight="bookmark-1"]'
        )
        expect(element).not.toBeNull()
        return element!
      })
      await act(async () => highlight.click())
      const pdfRoot = container.querySelector<HTMLElement>('[data-pdf-preview-root]')!
      expect(highlight.getAttribute('aria-pressed')).toBe('true')
      expect(pdfRoot.hasAttribute('data-preview-escape-boundary')).toBe(
        previewSource === 'literature'
      )
      const composingEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
        isComposing: true
      })
      await act(async () => document.activeElement!.dispatchEvent(composingEscape))
      expect(highlight.getAttribute('aria-pressed')).toBe('true')
      // An inner panel owns its Escape, even when it is portalled outside the reader.
      const marker = container.querySelector<HTMLButtonElement>('[data-pdf-annotation-marker]')!
      await act(async () => marker.click())
      const panel = await screen.findByRole('dialog')
      await act(async () => fireEvent.keyDown(panel, { key: 'Escape' }))
      expect(highlight.getAttribute('aria-pressed')).toBe('true')
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true
      })
      await act(async () => pdfRoot.dispatchEvent(escape))
      expect(escape.defaultPrevented).toBe(previewSource === 'literature')
      expect(highlight.getAttribute('aria-pressed')).toBe(
        previewSource === 'literature' ? 'false' : 'true'
      )
      expect(pdfRoot.hasAttribute('data-preview-escape-boundary')).toBe(false)
      const nextEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true
      })
      await act(async () => pdfRoot.dispatchEvent(nextEscape))
      expect(nextEscape.defaultPrevented).toBe(false)
    }
  )
})
