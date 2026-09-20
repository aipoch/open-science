import type { PdfElementOutput } from './agent-reader'
import type { PdfStructureOwner } from './owner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersistedChatSession, SessionPdfBinding } from '../../../shared/session-persistence'
import type { PdfStructureResult } from '../../../shared/pdf-structure'
import { createLinearConversationGraph } from '../../../shared/conversation-graph'
import { PdfElementAgentReader, type PdfElementContext } from './agent-reader'
import { PdfStructureSourceAuthority } from './source'
import { prepareModelImageData } from '../../uploads/attachment-media'

vi.mock('../../uploads/attachment-media', () => ({
  prepareModelImageData: vi.fn(async () => ({ data: 'typed-image', mimeType: 'image/png' }))
}))
afterEach(() => vi.clearAllMocks())
const region = { page: 2, x: 0.1, y: 0.1, width: 0.8, height: 0.7 }
const binding: SessionPdfBinding = {
  version: 1,
  bindingId: 'paper',
  sourceKind: 'literature-attachment-version',
  sourceFileId: 'attachment',
  sourceVersionId: 'version',
  name: 'Trial.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 100,
  checksum: 'a'.repeat(64),
  linkedAt: 1
}
const figure: PdfStructureResult['elements'][number] = {
  id: 'figure-3',
  kind: 'figure',
  regions: [region],
  caption: { text: 'Figure 3. Survival by treatment group.', regions: [{ ...region, page: 3 }] },
  thumbnailId: 'crop-3',
  issues: []
}
const table: PdfStructureResult['elements'][number] = {
  id: 'table-2',
  kind: 'table',
  regions: [region],
  caption: { text: 'Table 2. Treatment-group outcomes.', regions: [region] },
  table: {
    rowCount: 70,
    columnCount: 3,
    cells: [
      {
        row: 0,
        column: 0,
        rowSpan: 1,
        columnSpan: 3,
        text: 'Adjusted survival (%)',
        regions: [region]
      },
      ...Array.from({ length: 69 }, (_, i) => ({
        row: i + 1,
        column: 0,
        rowSpan: 1,
        columnSpan: 1,
        text: i === 0 ? 'Treatment' : `Group ${i}: 9.2a`,
        regions: [region],
        ...(i === 1
          ? {
              textRuns: [
                { text: 'Group 1: 9.2', position: 'normal' as const },
                { text: 'a', position: 'superscript' as const }
              ]
            }
          : {})
      }))
    ],
    notes: [{ text: 'a Adjusted for baseline age.', regions: [region] }],
    unassignedText: [{ text: '95% confidence interval', regions: [region] }],
    issues: []
  },
  issues: []
}
const setup = (
  elements = [figure, table]
): {
  reader: PdfElementAgentReader
  owner: {
    readCached: ReturnType<typeof vi.fn<PdfStructureOwner['readCached']>>
    readThumbnail: ReturnType<typeof vi.fn<PdfStructureOwner['readThumbnail']>>
  }
  sources: { pageCount: ReturnType<typeof vi.fn<() => Promise<number>>> }
  session: PersistedChatSession
  result: PdfStructureResult
  context: PdfElementContext
  controller: AbortController
  reference: (id?: number) => Promise<string>
  list: () => Promise<PdfElementOutput>
  source: { checksum: string }
} => {
  const controller = new AbortController()
  const context: PdfElementContext = {
    projectId: 'project',
    sessionId: 'session',
    promptMessageId: 'prompt',
    signal: controller.signal
  }
  const session: PersistedChatSession = {
    id: 'session',
    projectId: 'project',
    title: 'Trial',
    cwd: '/workspace',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Compare treatment outcomes',
        status: 'complete',
        createdAt: 1,
        updatedAt: 1,
        eventIds: [],
        pdfContext: { version: 1, bindings: [binding] }
      }
    ]
  }
  const sessions = { loadSessionForContinuation: vi.fn(async () => session) }
  const source = {
    sourceKind: binding.sourceKind,
    sourceFileId: binding.sourceFileId,
    sourceVersionId: binding.sourceVersionId,
    filename: binding.name,
    contentType: binding.mimeType,
    sizeBytes: binding.sizeBytes,
    checksum: binding.checksum,
    path: '/never-read-directly.pdf'
  }
  const authority = new PdfStructureSourceAuthority({
    sessions,
    literature: { resolveVersion: vi.fn() },
    sources: { resolveVersion: vi.fn(async () => source) }
  })
  const sources = {
    resolve: authority.resolve.bind(authority),
    reauthorize: authority.reauthorize.bind(authority),
    pageCount: vi.fn(async () => 12)
  }
  const result: PdfStructureResult = {
    schemaVersion: 1,
    extractionId: 'extraction-1',
    engineFingerprint: 'b'.repeat(64),
    sourceChecksum: source.checksum,
    sourceSizeBytes: 100,
    pageCount: 12,
    requestedPages: [2],
    processedPages: [2],
    pages: [],
    elements: structuredClone(elements),
    navigation: [],
    issues: [],
    thumbnails: [
      {
        id: 'crop-3',
        mimeType: 'image/png',
        width: 800,
        height: 600,
        sizeBytes: 12,
        sha256: 'c'.repeat(64)
      }
    ]
  }
  const owner = {
    readCached: vi.fn(async (_request, pages) => (pages[0] === 2 ? result : undefined)),
    readThumbnail: vi.fn(async () => Buffer.from('image'))
  }
  const reader = new PdfElementAgentReader({ owner, sources, sessions })
  const list = (): Promise<PdfElementOutput> => reader.list(context, {})
  const reference = async (id = 0): Promise<string> =>
    ((await list()).data.elements as Array<{ elementRef: string }>)[id].elementRef
  return { reader, owner, sources, session, result, context, controller, reference, list, source }
}

describe('Agent PDF evidence from existing Structure caches', () => {
  it('lets the agent select treatment outcomes and distinguishes parse gaps from object absence', async () => {
    const { list, reader, context, owner, sources } = setup()
    const first = await list()
    expect(first.image).toBeUndefined()
    expect(first.data.elements).toMatchObject([
      {
        kind: 'figure',
        caption: 'Figure 3. Survival by treatment group.',
        pageStart: 2,
        captionPages: [3],
        hasImage: true
      },
      {
        kind: 'table',
        caption: 'Table 2. Treatment-group outcomes.',
        preview: expect.stringContaining('Treatment'),
        hasTableData: true
      }
    ])
    expect(first.data.coverage).toMatchObject({
      checkedPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      parsedPages: [2],
      scanComplete: false
    })
    expect(JSON.stringify(first.data)).not.toContain('textRuns')
    expect(owner.readThumbnail).not.toHaveBeenCalled()
    const last = await reader.list(context, { cursor: first.data.nextCursor as string })
    expect(last.data).toMatchObject({
      nextCursor: null,
      coverage: {
        checkedPages: [11, 12],
        parsedPages: [],
        unavailablePages: [11, 12],
        scanComplete: true
      }
    })
    expect(sources.pageCount).toHaveBeenCalledTimes(1)
  })

  it('delivers Figure 3 as typed image evidence with its native caption and physical pages', async () => {
    const { reader, context, reference, owner } = setup()
    const output = await reader.read(context, { elementRef: await reference() })
    expect(output).toMatchObject({
      data: {
        kind: 'figure',
        caption: figure.caption!.text,
        imageIncluded: true,
        nextCursor: null
      },
      image: { data: 'typed-image', mimeType: 'image/png' }
    })
    expect(JSON.stringify(output.data)).not.toContain('typed-image')
    expect(owner.readThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'session', promptMessageId: 'prompt' }),
      [2],
      'extraction-1',
      'crop-3',
      context.signal
    )
  })

  it('preserves treatment labels, merged cells, superscripts and notes through bounded table batches', async () => {
    const { reader, context, reference, owner } = setup()
    const elementRef = await reference(1)
    const first = await reader.read(context, { elementRef })
    expect(first.data.table).toMatchObject({
      returnedRowStart: 0,
      returnedRowEnd: 31,
      cells: expect.arrayContaining([
        expect.objectContaining({ columnSpan: 3, text: 'Adjusted survival (%)' }),
        expect.objectContaining({
          text: 'Group 1: 9.2a',
          textRuns: expect.arrayContaining([{ text: 'a', position: 'superscript' }])
        })
      ]),
      notes: ['a Adjusted for baseline age.'],
      unassignedText: ['95% confidence interval']
    })
    const second = await reader.read(context, {
      elementRef,
      cursor: first.data.nextCursor as string
    })
    expect(second.data.table).toMatchObject({
      returnedRowStart: 32,
      returnedRowEnd: 63,
      contextCells: expect.arrayContaining([expect.objectContaining({ row: 0, columnSpan: 3 })]),
      notes: ['a Adjusted for baseline age.']
    })
    const last = await reader.read(context, {
      elementRef,
      cursor: second.data.nextCursor as string
    })
    expect(last.data).toMatchObject({
      nextCursor: null,
      table: { returnedRowStart: 64, returnedRowEnd: 69 }
    })
    expect(owner.readThumbnail).not.toHaveBeenCalled()
    expect([first, second, last].every((batch) => JSON.stringify(batch.data).length < 32000)).toBe(
      true
    )
  })

  it('paginates within a crowded page without duplicate objects and rejects a replaced extraction', async () => {
    const { list, reader, context, result } = setup(
      Array.from({ length: 12 }, (_, i) => ({ ...figure, id: `figure-${i}` }))
    )
    const first = await list()
    expect(first.data.elements).toHaveLength(8)
    const second = await reader.list(context, { cursor: first.data.nextCursor as string })
    expect(second.data.elements).toHaveLength(4)
    result.extractionId = 'extraction-2'
    await expect(reader.list(context, { cursor: first.data.nextCursor as string })).rejects.toThrow(
      'REFERENCE_STALE'
    )
  })

  it('does not guess a PDF or use refs across messages, sessions, projects, restarts or operations', async () => {
    const { reader, context, reference, session } = setup()
    const elementRef = await reference()
    for (const changed of [
      { projectId: 'other' },
      { sessionId: 'other' },
      { promptMessageId: 'other' }
    ])
      await expect(reader.read({ ...context, ...changed }, { elementRef })).rejects.toThrow(
        'REFERENCE_STALE'
      )
    await expect(setup().reader.read(context, { elementRef })).rejects.toThrow('REFERENCE_STALE')
    await expect(reader.list(context, { cursor: elementRef })).rejects.toThrow('REFERENCE_STALE')
    session.messages[0].pdfContext = {
      version: 1,
      bindings: [binding, { ...binding, bindingId: 'second' }]
    }
    await expect(reader.list(context, {})).rejects.toThrow('PDF_DOCUMENT_SELECTION_REQUIRED')
    await expect(reader.list(context, { documentId: 'paper' })).resolves.toBeDefined()
    session.messages[0].pdfContext = undefined
    await expect(reader.read(context, { elementRef })).rejects.toThrow('NO_LINKED_PDF_CONTEXT')
  })

  it('keeps references readable for the maximum existing Unicode binding identity', async () => {
    const { reader, context, session } = setup()
    const documentId = '文'.repeat(512)
    session.messages[0].pdfContext = {
      version: 1,
      bindings: [{ ...binding, bindingId: documentId }]
    }
    const listed = await reader.list(context, { documentId })
    const elementRef = (listed.data.elements as Array<{ elementRef: string }>)[0].elementRef
    expect(elementRef.length).toBeGreaterThan(1536)
    await expect(reader.read(context, { elementRef })).resolves.toMatchObject({
      data: { imageIncluded: true }
    })
    await expect(
      reader.list(context, { cursor: listed.data.nextCursor as string })
    ).resolves.toBeDefined()
  })

  it('rejects a continuation belonging to another element or a changed immutable source', async () => {
    const { reader, context, reference, source } = setup()
    const figureRef = await reference(),
      tableRef = await reference(1)
    const batch = await reader.read(context, { elementRef: tableRef })
    await expect(
      reader.read(context, { elementRef: figureRef, cursor: batch.data.nextCursor as string })
    ).rejects.toThrow('REFERENCE_STALE')
    source.checksum = 'f'.repeat(64)
    await expect(reader.read(context, { elementRef: tableRef })).rejects.toThrow(
      'LINKED_PDF_UNAVAILABLE'
    )
  })

  it('uses the active message branch and fails closed after cancellation or source revocation during reads', async () => {
    const { reader, context, reference, session, owner, result, controller } = setup()
    const elementRef = await reference()
    const original = session.messages
    session.conversationGraph = createLinearConversationGraph({
      sessionId: session.id,
      messages: [{ ...original[0], id: 'other' }],
      createdAt: 1,
      updatedAt: 1
    })
    await expect(reader.read(context, { elementRef })).rejects.toThrow('NO_LINKED_PDF_CONTEXT')
    session.conversationGraph = undefined
    owner.readCached.mockImplementationOnce(async () => {
      session.messages[0].pdfContext = undefined
      return result
    })
    await expect(reader.read(context, { elementRef })).rejects.toThrow('NO_LINKED_PDF_CONTEXT')
    controller.abort()
    await expect(reader.list(context, {})).rejects.toThrow()
  })

  it('preserves multi-part tables and sends one fallback image for ambiguous cells', async () => {
    const multi = {
      ...table,
      table: undefined,
      thumbnailId: 'crop-3',
      tableParts: [
        {
          title: 'Adults',
          table: {
            ...table.table!,
            issues: [{ code: 'ambiguous', detail: 'Some cells could not be assigned.' }]
          }
        },
        { title: 'Children', table: table.table! }
      ],
      tableNotes: [{ text: 'All values are percentages.', regions: [region] }]
    }
    const { reader, context, reference, owner } = setup([multi])
    const elementRef = await reference()
    let output = await reader.read(context, { elementRef })
    expect(output.data).toMatchObject({
      partIndex: 0,
      partCount: 2,
      tableParts: [{ title: 'Adults' }],
      tableNotes: ['All values are percentages.'],
      imageIncluded: true
    })
    for (let n = 0; output.data.nextCursor && n < 6; n++)
      output = await reader.read(context, { elementRef, cursor: output.data.nextCursor as string })
    expect(output.data).toMatchObject({
      partIndex: 1,
      tableParts: [{ title: 'Children' }],
      nextCursor: null,
      imageIncluded: false
    })
    expect(owner.readThumbnail).toHaveBeenCalledTimes(1)
  })

  it('includes merged group labels that span the next batch boundary', async () => {
    const grouped = structuredClone(table)
    grouped.table!.cells.push({
      row: 30,
      column: 1,
      rowSpan: 5,
      columnSpan: 1,
      text: 'Treatment cohort B',
      regions: [region]
    })
    const { reader, context, reference } = setup([grouped])
    const elementRef = await reference()
    const first = await reader.read(context, { elementRef })
    const second = await reader.read(context, {
      elementRef,
      cursor: first.data.nextCursor as string
    })
    expect(second.data.table).toMatchObject({
      returnedRowStart: 32,
      contextCells: expect.arrayContaining([
        expect.objectContaining({ row: 30, rowSpan: 5, text: 'Treatment cohort B' })
      ])
    })
  })

  it.each(['later-row', 'empty-part', 'later-notes'] as const)(
    'preflights %s so the first response supplies the only fallback image',
    async (limitation) => {
      const changed = structuredClone(table)
      changed.thumbnailId = 'crop-3'
      changed.table!.unassignedText = []
      if (limitation === 'later-row') changed.table!.cells[40].text = 'x'.repeat(12000)
      else {
        const later = structuredClone(changed.table!)
        if (limitation === 'empty-part') later.cells = []
        else later.notes = [{ text: 'n'.repeat(4000), regions: [region] }]
        changed.tableParts = [
          { title: 'First cohort', table: changed.table! },
          { title: 'Second cohort', table: later }
        ]
        delete changed.table
      }
      const { reader, context, reference, owner } = setup([changed])
      const elementRef = await reference()
      let output = await reader.read(context, { elementRef })
      expect(output.data.imageIncluded).toBe(true)
      for (let n = 0; output.data.nextCursor && n < 10; n++) {
        output = await reader.read(context, {
          elementRef,
          cursor: output.data.nextCursor as string
        })
        expect(output.data.imageIncluded).toBe(false)
      }
      expect(output.data.nextCursor).toBeNull()
      expect(owner.readThumbnail).toHaveBeenCalledTimes(1)
    }
  )

  it('reports unavailable and oversized evidence rather than inventing a complete table or caption', async () => {
    const huge = structuredClone(table)
    huge.caption!.text = 'caption'.repeat(1000)
    huge.table!.cells[0].text = 'value'.repeat(3000)
    const { reader, context, reference } = setup([huge])
    const output = await reader.read(context, { elementRef: await reference() })
    expect(output.data.table).toMatchObject({ omittedRows: [0] })
    expect(output.data.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Caption is truncated'),
        expect.stringContaining('omittedRows'),
        expect.stringContaining('No cached image')
      ])
    )
    expect(JSON.stringify(output.data).length).toBeLessThan(32000)
    expect(prepareModelImageData).not.toHaveBeenCalled()
  })
})
