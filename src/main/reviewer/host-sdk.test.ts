// Unit tests for ReviewerHostServer: covers host.read_artifact column-parsing for tabular artifacts
// (CSV/TSV), raw reads, the real managed-storage path layout, missing-file error propagation, and the
// out-of-scope rejection path.
//
// Tests start an actual ReviewerHostServer on a random port and POST to it, mirroring what the
// Python host bridge does. This exercises the full HTTP RPC layer.

import { writeFile, mkdtemp, mkdir, rename, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { utils as spreadsheetUtils, write as writeSpreadsheet } from 'styled-exceljs'

import { ReviewerHostServer, buildReviewerHostPythonBootstrap } from './host-sdk'
import * as boundedFileIo from '../bounded-file-io'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ReviewerFileEvidenceDescriptor, TurnScope } from '../../shared/reviewer'
import type { ArtifactVersionProvenance } from '../../shared/artifact-provenance'
import { ResourceBudgetExceededError } from '../resource-budget'
import { ManagedPreviewResources } from '../managed-preview-resources'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT = 'project-1'
// Managed artifacts are addressed by a colon-composite version id: <sessionId>:<messageId>:<filename>.
const V1 = 'session-1:msg-1:results.csv'

const makeSession = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: 'session-1',
  projectId: PROJECT,
  title: 'Test session',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: 'msg-1',
      role: 'user',
      content: 'Run the analysis',
      status: 'complete',
      eventIds: [],
      createdAt: 1000,
      updatedAt: 1000,
      artifactIds: [V1]
    }
  ],
  artifacts: [
    {
      id: V1,
      kind: 'managed-file',
      path: 'results.csv',
      mimeType: 'text/csv'
    }
  ],
  createdAt: 900,
  updatedAt: 2000,
  ...overrides
})

const makeScope = (artifactVersionIds: string[] = [V1]): TurnScope => ({
  turnMessageId: 'msg-1',
  blocks: [
    {
      id: 'message:msg-1',
      kind: 'message',
      sourceId: 'msg-1',
      blockIndex: 0,
      contentHash: 'abc123'
    }
  ],
  artifactVersionIds
})

// Writes an artifact into the REAL managed layout the app uses:
// <root>/artifacts/<projectId>/<sessionId>/<messageId>/<filename>, keyed by the colon-composite
// version id <sessionId>:<messageId>:<filename>.
const writeArtifact = async (
  root: string,
  versionId: string,
  content: string | Uint8Array
): Promise<void> => {
  const firstColon = versionId.indexOf(':')
  const secondColon = versionId.indexOf(':', firstColon + 1)
  const sessionId = versionId.slice(0, firstColon)
  const messageId = versionId.slice(firstColon + 1, secondColon)
  const filename = versionId.slice(secondColon + 1)
  const dir = join(root, 'artifacts', PROJECT, sessionId, messageId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, filename), content)
}

const blankPdf = (): Buffer => {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << >> >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object) => {
    const offset = Buffer.byteLength(pdf)
    pdf += object
    return offset
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

// Posts a JSON-RPC style request to the host server and returns the parsed body.
const post = async (
  endpoint: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<{ result?: unknown; error?: string }> => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ method, params })
  })
  return response.json() as Promise<{ result?: unknown; error?: string }>
}

const expectByteFreeMetadata = (value: unknown, forbiddenBytes: Buffer): void => {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain(forbiddenBytes.toString('base64'))
  expect(serialized).not.toContain('"type":"Buffer"')
  expect(serialized).not.toContain('"data"')
  expect(value).not.toHaveProperty('data')
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string
let server: ReviewerHostServer
let endpoint: string
let token: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'host-sdk-test-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await server?.stop().catch(() => undefined)
  await rm(tmpDir, { recursive: true, force: true })
})

describe('host.read_turn — frozen evidence', () => {
  it('does not rebuild reviewer evidence from a Session mutated after construction', () => {
    const session = makeSession()
    server = new ReviewerHostServer(session, makeScope(), tmpDir)
    const before = server.readTurn()

    session.messages[0]!.content = 'changed while the reviewer was running'

    expect(server.readTurn()).toEqual(before)
    expect(server.readTurn()[0]).toMatchObject({ content: 'Run the analysis' })
  })
})

describe('reviewer host request budget', () => {
  it('returns 413 for an authenticated compatibility request above the limit', async () => {
    server = new ReviewerHostServer(makeSession(), makeScope(), tmpDir, undefined, undefined, {
      requestBytes: 2
    })
    ;({ endpoint, token } = await server.start())

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: '{} '
    })

    expect(response.status).toBe(413)
    expect(response.headers.get('connection')).toBe('close')
  })
})

describe('host.read_artifact — trace view', () => {
  const nativeVersionId = 'native-version-1'
  const traceFixture = (): ArtifactVersionProvenance => ({
    descriptor: {
      id: nativeVersionId,
      artifactId: 'artifact-1',
      versionId: nativeVersionId,
      versionNumber: 3,
      checksum: 'c'.repeat(64),
      createdAt: '2026-08-28T00:00:00.000Z',
      projectId: PROJECT,
      sessionId: 'session-1',
      runId: 'artifact-run-1',
      name: 'generated.png',
      mimeType: 'image/png',
      size: 128,
      mtimeMs: 1,
      state: 'finalized',
      producerRunId: 'run-7'
    },
    contentStatus: { state: 'available' },
    evidence: {
      schema_version: 1,
      project_id: PROJECT,
      app_session_id: 'session-1',
      artifact_id: 'artifact-1',
      version_id: nativeVersionId,
      version_number: 3,
      filename: 'generated.png',
      content_type: 'image/png',
      size_bytes: 128,
      checksum: 'c'.repeat(64),
      created_at: '2026-08-28T00:00:00.000Z',
      conversation: {
        root_frame_id: 'root-1',
        agent_frame_id: 'agent-1',
        message_branch_id: 'branch-1',
        runtime_segment_id: 'segment-1',
        prompt_message_id: 'prompt-1'
      },
      is_user_upload: false,
      reproduction_code: 'model_generated_wrong()',
      execution_status: { state: 'available' },
      inputs: [
        {
          ordinal: 0,
          input_file_version_id: 'upload-version-1',
          source_kind: 'upload-version',
          source_file_id: 'upload-1',
          source_project_id: PROJECT,
          source_session_id: 'session-1',
          filename: 'source.csv',
          size_bytes: 9,
          checksum: 'd'.repeat(64),
          storage_key: 'private/storage/key',
          strongest_association: 'turn-attached'
        }
      ],
      producer: {
        state: 'available',
        notebook_session_id: 'notebook-1',
        producer_run_id: 'run-7',
        run_index: 0,
        kernel_kind: 'python',
        association_method: 'agent-declared-and-session-validated'
      },
      environment_status: { state: 'unavailable', reason: 'environment-capture-failed' }
    },
    execution: {
      schemaVersion: 2,
      rootFrameId: 'root-1',
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      terminalPromptMessageId: 'prompt-1',
      producerRunId: 'run-7',
      producerRunIndex: 0,
      createdAt: '2026-08-28T00:00:00.000Z',
      inputFiles: [
        {
          inputFileVersionId: 'upload-version-1',
          sourceKind: 'upload-version',
          sourceFileId: 'upload-1',
          sourceProjectId: PROJECT,
          sourceSessionId: 'session-1',
          filename: 'source.csv',
          sizeBytes: 9,
          checksum: 'd'.repeat(64),
          association: 'turn-attached',
          availability: { state: 'unavailable', reason: 'input-content-missing' }
        }
      ],
      runs: [
        {
          runId: 'run-7',
          runIndex: 0,
          agentFrameId: 'agent-1',
          messageBranchId: 'branch-1',
          runtimeSegmentId: 'segment-1',
          promptMessageId: 'prompt-1',
          kernelKind: 'python',
          script: "render_image('generated.png')",
          status: 'completed',
          startedAt: '2026-08-28T00:00:00.000Z',
          completedAt: '2026-08-28T00:00:01.000Z',
          outputs: [{ type: 'text', text: 'saved generated.png' }],
          inputFileVersionKeys: [
            { sourceKind: 'upload-version', inputFileVersionId: 'upload-version-1' }
          ]
        }
      ]
    },
    messages: { state: 'unavailable', reason: 'not-loaded' },
    review: { state: 'unavailable', reason: 'not-loaded' }
  })

  it('returns captured Notebook execution evidence without reading content bytes', async () => {
    const contentResolver = vi.fn()
    const traceResolver = vi.fn().mockResolvedValue(traceFixture())
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([nativeVersionId]),
      tmpDir,
      contentResolver,
      undefined,
      {},
      traceResolver
    )

    await expect(server.readArtifact(nativeVersionId, { view: 'trace' })).resolves.toMatchObject({
      id: nativeVersionId,
      role: 'work_product',
      file: {
        filename: 'generated.png',
        mimeType: 'image/png',
        sizeBytes: 128,
        checksum: 'c'.repeat(64),
        contentStatus: 'available'
      },
      producer: {
        kind: 'notebook',
        runId: 'run-7',
        language: 'python',
        code: "render_image('generated.png')",
        status: 'completed',
        outputs: [{ type: 'text', text: 'saved generated.png' }],
        inputs: [{ versionId: 'upload-version-1', checksum: 'd'.repeat(64) }]
      },
      limitations: expect.arrayContaining([
        expect.objectContaining({ kind: 'input-unavailable', subjectId: 'upload-version-1' })
      ])
    })
    expect(traceResolver).toHaveBeenCalledWith({ projectId: PROJECT, versionId: nativeVersionId })
    expect(contentResolver).not.toHaveBeenCalled()
  })

  it('returns Connector inputs with immutable Version ids and checksums', async () => {
    const trace = traceFixture()
    trace.evidence.producer = {
      state: 'available',
      kind: 'connector',
      connector_id: 'image-generator',
      tool_id: 'generate_image',
      invocation_id: 'invocation-1',
      implementation_version: '2.0.0',
      arguments_checksum: 'e'.repeat(64),
      association_method: 'app-owned-handler'
    }
    trace.evidence.connector_execution = {
      schema_version: 1,
      normalized_arguments: { method: 'heatmap' },
      arguments_checksum: 'e'.repeat(64)
    }
    trace.evidence.execution_status = { state: 'partial' }
    trace.execution = undefined
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([nativeVersionId]),
      tmpDir,
      undefined,
      undefined,
      {},
      vi.fn().mockResolvedValue(trace)
    )

    await expect(server.readArtifact(nativeVersionId, { view: 'trace' })).resolves.toMatchObject({
      producer: {
        kind: 'connector',
        connectorId: 'image-generator',
        toolId: 'generate_image',
        arguments: { method: 'heatmap' },
        inputs: [{ versionId: 'upload-version-1', checksum: 'd'.repeat(64) }]
      }
    })
  })

  it('keeps omitted view compatible with content reads', async () => {
    const nativePath = join(tmpDir, 'immutable', 'content')
    await mkdir(join(tmpDir, 'immutable'), { recursive: true })
    await writeFile(nativePath, 'plain text')
    const contentResolver = vi.fn().mockResolvedValue({
      path: nativePath,
      filename: 'note.txt',
      contentType: 'text/plain'
    })
    const traceResolver = vi.fn()
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([nativeVersionId]),
      tmpDir,
      contentResolver,
      undefined,
      {},
      traceResolver
    )

    await expect(server.readArtifact(nativeVersionId)).resolves.toMatchObject({
      kind: 'raw',
      content: 'plain text',
      encoding: 'utf8'
    })
    expect(contentResolver).toHaveBeenCalledOnce()
    expect(traceResolver).not.toHaveBeenCalled()
  })

  it('marks bounded trace evidence explicitly instead of returning an oversized payload', async () => {
    const trace = traceFixture()
    trace.execution!.runs[0]!.script = 'x'.repeat(4_000)
    trace.execution!.runs[0]!.outputs = [{ type: 'text', text: 'y'.repeat(4_000) }]
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([nativeVersionId]),
      tmpDir,
      undefined,
      undefined,
      { readBytes: 1_000, sessionBytes: 2_000 },
      vi.fn().mockResolvedValue(trace)
    )

    const result = await server.readArtifact(nativeVersionId, {
      view: 'trace',
      maxBytes: 1_000
    })
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1_000)
    expect(result).toMatchObject({
      limitations: expect.arrayContaining([expect.objectContaining({ kind: 'truncated' })])
    })
  })
})

// ---------------------------------------------------------------------------
// read_artifact: tabular (CSV)
// ---------------------------------------------------------------------------

describe('host.read_artifact — tabular CSV', () => {
  it('reads only the requested XLSX sheet, rows, and columns while recording file-level partial coverage', async () => {
    const versionId = 'native-spreadsheet-version'
    const nativePath = join(tmpDir, 'review-targets.xlsx')
    const workbook = spreadsheetUtils.book_new()
    spreadsheetUtils.book_append_sheet(
      workbook,
      spreadsheetUtils.aoa_to_sheet([
        ['sample', 'value', 'unit'],
        ['alpha', 10, 'mg'],
        ['beta', 20, 'mg'],
        ['gamma', 30, 'mg']
      ]),
      'Results'
    )
    spreadsheetUtils.book_append_sheet(
      workbook,
      spreadsheetUtils.aoa_to_sheet([['private'], ['not requested']]),
      'Other'
    )
    await writeFile(
      nativePath,
      writeSpreadsheet(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    )
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([versionId]),
      tmpDir,
      async () => ({
        path: nativePath,
        filename: 'review-targets.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      })
    )

    await expect(
      server.readArtifact(versionId, {
        sheet: 'Results',
        rowStart: 3,
        rowEnd: 4,
        columns: ['A', 'B']
      })
    ).resolves.toEqual({
      id: versionId,
      role: 'work_product',
      kind: 'spreadsheet',
      targets: { sheet: 'Results', rowStart: 3, rowEnd: 4, columns: ['A', 'B'] },
      sheets: [
        {
          name: 'Results',
          rowCount: 4,
          columnCount: 3,
          rows: [
            { rowNumber: 3, cells: { A: 'beta', B: '20' } },
            { rowNumber: 4, cells: { A: 'gamma', B: '30' } }
          ]
        }
      ],
      partial: true,
      limitations: []
    })

    await expect(
      server.readArtifact(versionId, {
        sheet: 'Results',
        rowStart: 3,
        rowEnd: 3,
        columns: ['a', 'b']
      })
    ).resolves.toMatchObject({
      targets: { columns: ['A', 'B'] },
      sheets: [{ rows: [{ rowNumber: 3, cells: { A: 'beta', B: '20' } }] }]
    })
    await expect(
      server.readArtifact(versionId, { sheet: 'Results', columns: ['A1'] })
    ).rejects.toThrow(/only column letters/i)
    await expect(
      server.readArtifact(versionId, { sheet: 'Results', rowStart: 1, rowEnd: 1_001 })
    ).rejects.toThrow(/must not exceed 1000 rows/i)
  })

  it('gates oversized compressed XLSX sources before allocating their bytes', async () => {
    const versionId = 'native-oversized-spreadsheet-version'
    const nativePath = join(tmpDir, 'oversized.xlsx')
    await writeFile(nativePath, '')
    await truncate(nativePath, 50 * 1024 * 1024 + 1)
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([versionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'oversized.xlsx' })
    )

    await expect(server.readArtifact(versionId, { sheet: 'Results' })).resolves.toMatchObject({
      kind: 'spreadsheet',
      sheets: [],
      limitations: [{ kind: 'budget-exhausted', subjectId: versionId }]
    })
  })

  it('propagates cancellation before reading structured artifact bytes', async () => {
    const versionId = 'native-cancelled-spreadsheet-version'
    const nativePath = join(tmpDir, 'cancelled.xlsx')
    await writeFile(nativePath, 'not read')
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([versionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'cancelled.xlsx' })
    )
    const controller = new AbortController()
    const reason = new Error('review cancelled')
    controller.abort(reason)

    await expect(
      server.readArtifact(versionId, { sheet: 'Results' }, controller.signal)
    ).rejects.toBe(reason)
  })

  it('skips unrequested worksheet inflation and rejects an oversized targeted worksheet', async () => {
    const versionId = 'native-inflated-spreadsheet-version'
    const nativePath = join(tmpDir, 'inflated.xlsx')
    await writeFile(
      nativePath,
      zipSync(
        {
          'xl/workbook.xml': strToU8(
            '<workbook><sheets><sheet name="Results" r:id="rId1"/>' +
              '<sheet name="Huge" r:id="rId2"/></sheets></workbook>'
          ),
          'xl/_rels/workbook.xml.rels': strToU8(
            '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
              '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'
          ),
          'xl/worksheets/sheet1.xml': strToU8(
            '<worksheet><dimension ref="A1"/><sheetData><row r="1"><c r="A1" t="inlineStr">' +
              '<is><t>bounded</t></is></c></row></sheetData></worksheet>'
          ),
          'xl/worksheets/sheet2.xml': strToU8(
            `<worksheet>${'x'.repeat(33 * 1024 * 1024)}</worksheet>`
          )
        },
        { level: 9 }
      )
    )
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([versionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'inflated.xlsx' })
    )

    await expect(
      server.readArtifact(versionId, { sheet: 'Results', columns: ['A'] })
    ).resolves.toMatchObject({
      kind: 'spreadsheet',
      sheets: [{ name: 'Results', rows: [{ cells: { A: 'bounded' } }] }],
      limitations: []
    })
    await expect(server.readArtifact(versionId, { sheet: 'Huge' })).resolves.toMatchObject({
      kind: 'spreadsheet',
      sheets: [],
      limitations: [{ kind: 'budget-exhausted', subjectId: versionId }]
    })
  })

  it('reads only requested PPTX slides and does not expand unrequested slide text', async () => {
    const versionId = 'native-presentation-version'
    const nativePath = join(tmpDir, 'review-targets.pptx')
    const archive = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'ppt/presentation.xml': strToU8(
        '<p:presentation><p:sldIdLst><p:sldId r:id="rId1"/><p:sldId r:id="rId9"/>' +
          '<p:sldId r:id="rId3"/></p:sldIdLst></p:presentation>'
      ),
      'ppt/_rels/presentation.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/>' +
          '<Relationship Id="rId9" Target="slides/slide9.xml"/>' +
          '<Relationship Id="rId3" Target="slides/slide3.xml"/></Relationships>'
      ),
      'ppt/slides/slide1.xml': strToU8('<p:sld><a:t>Overview</a:t></p:sld>'),
      'ppt/slides/slide9.xml': strToU8('<p:sld><a:t>Claim is 42 mg</a:t></p:sld>'),
      'ppt/slides/slide3.xml': strToU8('<p:sld><a:t>Unrequested appendix secret</a:t></p:sld>')
    })
    await writeFile(nativePath, archive)
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([versionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'review-targets.pptx' }),
      undefined,
      {},
      undefined,
      async () => ({
        pageCount: 3,
        pages: [
          { pageNumber: 2, text: 'Claim is 42 mg' },
          { pageNumber: 3, text: 'resolver must not expand targets' }
        ],
        media: [
          {
            pageNumber: 2,
            data: Buffer.from('rendered-slide-2').toString('base64'),
            mimeType: 'image/png'
          },
          { pageNumber: 3, data: 'unrequested', mimeType: 'image/png' }
        ]
      })
    )

    const result = await server.readArtifact(versionId, { pages: [2] })
    expect(result).toMatchObject({
      kind: 'paged',
      format: 'pptx',
      targets: { pages: [2] },
      pageCount: 3,
      pages: [{ pageNumber: 2, text: 'Claim is 42 mg' }],
      partial: true,
      limitations: []
    })
    expect(JSON.stringify(result)).not.toContain('appendix secret')
    await expect(
      server.readArtifact(versionId, { pages: [2], includePreview: true })
    ).resolves.toMatchObject({
      targets: { pages: [2] },
      media: [{ pageNumber: 2, mimeType: 'image/png' }]
    })
    expect(
      JSON.stringify(await server.readArtifact(versionId, { pages: [2], includePreview: true }))
    ).not.toContain('resolver must not expand targets')
    await expect(server.readArtifact(versionId, { pages: [4] })).rejects.toThrow(/between 1 and 3/)
  })

  it('uses rendered preview pagination for a flowing DOCX page and returns bounded visual content', async () => {
    const versionId = 'native-document-version'
    const nativePath = join(tmpDir, 'review-targets.docx')
    await writeFile(
      nativePath,
      zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        'word/document.xml': strToU8(
          `<w:document><w:body><w:p><w:t>${'Flowing paragraph. '.repeat(800)}</w:t></w:p>` +
            '<w:p><w:t>Second claim is supported</w:t></w:p></w:body></w:document>'
        )
      })
    )
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([versionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'review-targets.docx' }),
      undefined,
      {},
      undefined,
      async (request) => {
        expect(request).toMatchObject({
          artifactVersionId: versionId,
          format: 'docx',
          pages: [2],
          includePreview: true
        })
        return {
          pageCount: 3,
          pages: [{ pageNumber: 2, text: 'Second claim is supported' }],
          media: [
            { pageNumber: 2, data: Buffer.from('page-2').toString('base64'), mimeType: 'image/png' }
          ]
        }
      }
    )

    const result = await server.readArtifact(versionId, { pages: [2], includePreview: true })
    expect(result).toMatchObject({
      kind: 'paged',
      format: 'docx',
      targets: { pages: [2] },
      pageCount: 3,
      pages: [{ pageNumber: 2, text: 'Second claim is supported' }],
      media: [{ pageNumber: 2, mimeType: 'image/png' }],
      partial: true,
      limitations: []
    })
    expect(JSON.stringify(result)).not.toContain('Flowing paragraph')
  })

  it('marks bounded DOCX coverage partial when a 20-page document continues after its targets', async () => {
    const versionId = 'bounded-twenty-page-document'
    const nativePath = join(tmpDir, 'twenty-pages.docx')
    await writeFile(nativePath, Buffer.from('verified-docx-bytes'))
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([versionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'twenty-pages.docx' }),
      undefined,
      {},
      undefined,
      async (request) => {
        expect(request.verifiedChecksum).toMatch(/^[a-f0-9]{64}$/)
        expect(request.verifiedObservation).toMatchObject({ sizeBytes: 19 })
        return {
          // The targeted renderer discovered that page 3 exists, then stopped before rendering it.
          // It intentionally reports only its bounded count rather than claiming the total is 20.
          pageCount: 2,
          pageCountComplete: false,
          pages: [
            { pageNumber: 1, text: 'claim premise' },
            { pageNumber: 2, text: 'claim evidence' }
          ]
        }
      }
    )

    await expect(server.readArtifact(versionId, { pages: [1, 2] })).resolves.toMatchObject({
      kind: 'paged',
      targets: { pages: [1, 2] },
      pageCount: 2,
      pageCountComplete: false,
      pages: [
        { pageNumber: 1, text: 'claim premise' },
        { pageNumber: 2, text: 'claim evidence' }
      ],
      partial: true,
      limitations: [expect.objectContaining({ kind: 'truncated', subjectId: versionId })]
    })
  })

  it('never mints a preview capability after the verified artifact path is swapped', async () => {
    const versionId = 'swapped-after-verification'
    const nativePath = join(tmpDir, 'verified.docx')
    const replacementPath = join(tmpDir, 'replacement.docx')
    await writeFile(nativePath, Buffer.from('trusted-office'))
    await writeFile(replacementPath, Buffer.from('hostile-office'))
    const createId = vi.fn(() => 'must-not-mint')
    const resources = new ManagedPreviewResources({
      resolvePath: async () => {
        throw new Error('Reviewer resolved path must not be resolved again.')
      },
      createId
    })
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([versionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'verified.docx' }),
      undefined,
      {},
      undefined,
      async (request) => {
        await rename(replacementPath, nativePath)
        await resources.acquireResolvedFile(
          42,
          {
            path: request.path,
            verifiedObservation: request.verifiedObservation,
            verifiedChecksum: request.verifiedChecksum
          },
          40 * 1024 * 1024
        )
        throw new Error('unreachable')
      }
    )

    await expect(server.readArtifact(versionId, { pages: [1] })).resolves.toMatchObject({
      kind: 'paged',
      targets: { pages: [] },
      partial: true,
      limitations: [expect.objectContaining({ kind: 'checksum-mismatch', subjectId: versionId })]
    })
    expect(createId).not.toHaveBeenCalled()
  })

  it('distinguishes corrupt targeted document content from ordinary partial coverage', async () => {
    const versionId = 'native-corrupt-document-version'
    const nativePath = join(tmpDir, 'corrupt.docx')
    await writeFile(nativePath, 'not a zip package')
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([versionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'corrupt.docx' }),
      undefined,
      {},
      undefined,
      async () => {
        throw new Error('preview renderer rejected the damaged package')
      }
    )

    await expect(server.readArtifact(versionId, { pages: [1] })).resolves.toMatchObject({
      kind: 'paged',
      format: 'docx',
      partial: true,
      limitations: [{ kind: 'corrupt-content', subjectId: versionId }]
    })
  })

  it('preserves scanned PDF target coverage and returns its bounded page preview', async () => {
    const versionId = 'native-scanned-pdf-version'
    const nativePath = join(tmpDir, 'scanned.pdf')
    await writeFile(nativePath, blankPdf())
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([versionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'scanned.pdf', contentType: 'application/pdf' }),
      undefined,
      {},
      undefined,
      async () => ({
        pageCount: 1,
        pages: [{ pageNumber: 1, text: '' }],
        media: [
          {
            pageNumber: 1,
            data: Buffer.from('scanned-page-preview').toString('base64'),
            mimeType: 'image/png'
          }
        ]
      })
    )

    await expect(server.readArtifact(versionId, { pages: [1] })).resolves.toMatchObject({
      kind: 'paged',
      format: 'pdf',
      targets: { pages: [1] },
      pages: [{ pageNumber: 1, text: '' }],
      media: [{ pageNumber: 1, mimeType: 'image/png' }],
      limitations: []
    })
  })

  it('keeps scanned PDF target access when visual preview capability is unavailable', async () => {
    const versionId = 'native-scanned-pdf-without-preview-version'
    const nativePath = join(tmpDir, 'scanned-without-preview.pdf')
    await writeFile(nativePath, blankPdf())
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([versionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'scanned.pdf', contentType: 'application/pdf' })
    )

    await expect(server.readArtifact(versionId, { pages: [1] })).resolves.toMatchObject({
      kind: 'paged',
      targets: { pages: [1] },
      pages: [{ pageNumber: 1, text: '' }],
      limitations: [{ kind: 'unsupported-model-capability', subjectId: versionId }]
    })
  })

  it('distinguishes target budget exhaustion and returns no whole-slide expansion', async () => {
    const versionId = 'native-large-presentation-version'
    const nativePath = join(tmpDir, 'large.pptx')
    await writeFile(
      nativePath,
      zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        'ppt/presentation.xml': strToU8('<p:presentation/>'),
        'ppt/slides/slide1.xml': strToU8(`<p:sld><a:t>${'claim '.repeat(1_000)}</a:t></p:sld>`)
      })
    )
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([versionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'large.pptx' }),
      undefined,
      { readBytes: 600, sessionBytes: 5_000 }
    )

    const result = await server.readArtifact(versionId, { pages: [1] })
    expect(result).toMatchObject({
      kind: 'paged',
      partial: true,
      limitations: [{ kind: 'budget-exhausted', subjectId: versionId }]
    })
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(600)
  })

  it('returns unsupported-format when structured targets are requested for an unsupported file', async () => {
    const versionId = 'native-legacy-spreadsheet-version'
    const nativePath = join(tmpDir, 'legacy.xls')
    await writeFile(nativePath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]))
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([versionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'legacy.xls' })
    )

    await expect(server.readArtifact(versionId, { sheet: 'Results' })).resolves.toMatchObject({
      kind: 'unsupported',
      targets: { sheet: 'Results' },
      partial: true,
      limitations: [{ kind: 'unsupported-format', subjectId: versionId }]
    })
  })

  it('resolves native Artifact Versions through SQLite authority instead of a legacy id path', async () => {
    const nativeVersionId = 'native-version-1'
    const nativePath = join(tmpDir, 'immutable', 'content')
    await mkdir(join(tmpDir, 'immutable'), { recursive: true })
    await writeFile(nativePath, 'sample,value\na,1\nb,2\n')
    const resolverCalls: unknown[] = []
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([nativeVersionId]),
      tmpDir,
      async (request) => {
        resolverCalls.push(request)
        return { path: nativePath, filename: 'native.csv', contentType: 'text/csv' }
      }
    )

    await expect(server.readArtifact(nativeVersionId)).resolves.toMatchObject({
      id: nativeVersionId,
      kind: 'tabular',
      rowCount: 2
    })
    expect(resolverCalls).toEqual([{ projectId: PROJECT, versionId: nativeVersionId }])
  })

  it('rejects native Artifact bytes that no longer match the authority checksum', async () => {
    const nativeVersionId = 'native-version-checksum-mismatch'
    const nativePath = join(tmpDir, 'immutable-mismatch', 'content')
    await mkdir(join(tmpDir, 'immutable-mismatch'), { recursive: true })
    await writeFile(nativePath, 'tampered bytes')
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([nativeVersionId]),
      tmpDir,
      async () => ({
        path: nativePath,
        filename: 'native.txt',
        contentType: 'text/plain',
        checksum: '0'.repeat(64)
      })
    )

    await expect(server.readArtifact(nativeVersionId)).rejects.toThrow(/checksum mismatch/i)
  })

  it('verifies the whole Artifact once while returning bounded pages', async () => {
    const nativeVersionId = 'native-version-truncated'
    const nativePath = join(tmpDir, 'immutable-truncated', 'content')
    await mkdir(join(tmpDir, 'immutable-truncated'), { recursive: true })
    await writeFile(nativePath, 'abcdefghij')
    const verify = vi.spyOn(boundedFileIo, 'readFilePageAndDigest')
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([nativeVersionId]),
      tmpDir,
      async () => ({
        path: nativePath,
        filename: 'native.txt',
        contentType: 'text/plain'
      }),
      undefined,
      { readBytes: 4, sessionBytes: 400 }
    )

    await expect(server.readArtifact(nativeVersionId)).resolves.toMatchObject({
      kind: 'raw',
      content: 'abcd',
      sizeBytes: 10,
      returnedBytes: 4,
      truncated: true
    })
    await expect(
      server.readArtifact(nativeVersionId, { offset: 4, maxBytes: 2 })
    ).resolves.toMatchObject({
      content: 'ef',
      offset: 4,
      returnedBytes: 2,
      truncated: true
    })
    expect(verify).toHaveBeenCalledTimes(1)
    await expect(server.readArtifact(nativeVersionId)).rejects.toBeInstanceOf(
      ResourceBudgetExceededError
    )
  })

  it('paginates UTF-8 text on code-point boundaries without replacement characters', async () => {
    const nativeVersionId = 'native-version-utf8'
    const nativePath = join(tmpDir, 'immutable-utf8', 'content')
    await mkdir(join(tmpDir, 'immutable-utf8'), { recursive: true })
    await writeFile(nativePath, 'a你b')
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([nativeVersionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'native.txt', contentType: 'text/plain' }),
      undefined,
      { readBytes: 4, sessionBytes: 1_000 }
    )

    await expect(server.readArtifact(nativeVersionId, { maxBytes: 2 })).resolves.toMatchObject({
      content: 'a',
      offset: 0,
      returnedBytes: 1,
      nextOffset: 1,
      truncated: true
    })
    await expect(server.readArtifact(nativeVersionId, { offset: 1 })).resolves.toMatchObject({
      content: '你b',
      offset: 1,
      returnedBytes: 4,
      truncated: false
    })
  })

  it('does not encode invalid UTF-8 bytes into text content', async () => {
    const nativeVersionId = 'native-version-invalid-utf8'
    const nativePath = join(tmpDir, 'immutable-invalid-utf8', 'content')
    const bytes = Buffer.from([0xff, 0xfe, 0x61])
    await mkdir(join(tmpDir, 'immutable-invalid-utf8'), { recursive: true })
    await writeFile(nativePath, bytes)
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([nativeVersionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'native.txt', contentType: 'text/plain' }),
      undefined,
      { readBytes: 2, sessionBytes: 1_000 }
    )

    const result = await server.readArtifact(nativeVersionId)
    expect(result).toMatchObject({
      kind: 'unsupported',
      returnedBytes: 0,
      limitations: [{ kind: 'unsupported-format', subjectId: nativeVersionId }]
    })
    expect(JSON.stringify(result)).not.toContain(bytes.subarray(0, 2).toString('base64'))
  })

  it('treats invalid UTF-8 prefixes as opaque instead of leaking encoded bytes', async () => {
    const nativeVersionId = 'native-version-invalid-utf8-prefix'
    const nativePath = join(tmpDir, 'immutable-invalid-utf8-prefix', 'content')
    const bytes = Buffer.from([0x80, 0x61, 0x62])
    await mkdir(join(tmpDir, 'immutable-invalid-utf8-prefix'), { recursive: true })
    await writeFile(nativePath, bytes)
    server = new ReviewerHostServer(
      makeSession({ artifacts: [] }),
      makeScope([nativeVersionId]),
      tmpDir,
      async () => ({ path: nativePath, filename: 'native.txt', contentType: 'text/plain' }),
      undefined,
      { readBytes: 2, sessionBytes: 1_000 }
    )

    const result = await server.readArtifact(nativeVersionId)
    expect(result).toMatchObject({
      kind: 'unsupported',
      returnedBytes: 0,
      limitations: [{ kind: 'unsupported-format', subjectId: nativeVersionId }]
    })
    expect(JSON.stringify(result)).not.toContain(bytes.subarray(0, 2).toString('base64'))
  })

  it('returns paged CSV as reconstructable raw windows across quoted records', async () => {
    const quote = String.fromCharCode(34)
    const content = [
      'name,value',
      `alpha,${quote}one`,
      `two${quote}`,
      `beta,${quote}escaped ${quote}${quote}quote${quote}${quote}${quote}`,
      ''
    ].join('\n')
    await writeArtifact(tmpDir, V1, content)
    server = new ReviewerHostServer(makeSession(), makeScope(), tmpDir, undefined, undefined, {
      readBytes: 8,
      sessionBytes: 10_000
    })

    let offset = 0
    let reconstructed = ''
    for (;;) {
      const page = await server.readArtifact(V1, { offset })
      expect(page).toMatchObject({ kind: 'raw', encoding: 'utf8', offset })
      if (!('kind' in page) || page.kind !== 'raw') {
        throw new Error('Expected a raw CSV byte window.')
      }
      reconstructed += page.content
      if (!page.truncated) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset!
    }
    expect(reconstructed).toBe(content)
  })

  it('returns kind=tabular with column-addressable structure for a simple CSV', async () => {
    await writeArtifact(tmpDir, V1, 'name,value,unit\nalpha,1,mg\nbeta,2,mg\ngamma,3,mg\n')

    server = new ReviewerHostServer(makeSession(), makeScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: V1 })

    expect(body.result).toMatchObject({
      id: V1,
      kind: 'tabular',
      rowCount: 3,
      columns: {
        name: ['alpha', 'beta', 'gamma'],
        value: ['1', '2', '3'],
        unit: ['mg', 'mg', 'mg']
      }
    })
  })

  it('returns kind=tabular for a CSV with more than 5 columns', async () => {
    const versionId = 'session-1:msg-1:wide.csv'
    const header = 'a,b,c,d,e,f,g'
    const row1 = '1,2,3,4,5,6,7'
    const row2 = '8,9,10,11,12,13,14'
    await writeArtifact(tmpDir, versionId, `${header}\n${row1}\n${row2}\n`)

    server = new ReviewerHostServer(
      makeSession({
        artifacts: [{ id: versionId, kind: 'managed-file', path: 'wide.csv', mimeType: 'text/csv' }]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    const result = body.result as {
      kind: string
      rowCount: number
      columns: Record<string, string[]>
    }
    expect(result.kind).toBe('tabular')
    expect(result.rowCount).toBe(2)
    expect(Object.keys(result.columns)).toHaveLength(7)
    expect(result.columns['a']).toEqual(['1', '8'])
    expect(result.columns['g']).toEqual(['7', '14'])
  })

  it('returns kind=tabular for a TSV artifact', async () => {
    const versionId = 'session-1:msg-1:data.tsv'
    await writeArtifact(tmpDir, versionId, 'col1\tcol2\tcol3\nfoo\t10\tbar\nbaz\t20\tqux\n')

    server = new ReviewerHostServer(
      makeSession({
        artifacts: [
          {
            id: versionId,
            kind: 'managed-file',
            path: 'data.tsv',
            mimeType: 'text/tab-separated-values'
          }
        ]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    const result = body.result as {
      kind: string
      rowCount: number
      columns: Record<string, string[]>
    }
    expect(result.kind).toBe('tabular')
    expect(result.rowCount).toBe(2)
    expect(result.columns['col1']).toEqual(['foo', 'baz'])
    expect(result.columns['col2']).toEqual(['10', '20'])
  })
})

// ---------------------------------------------------------------------------
// read_artifact: non-tabular (kind=raw)
// ---------------------------------------------------------------------------

describe('host.read_artifact — non-tabular', () => {
  it('returns kind=raw with content for a plain text artifact', async () => {
    const versionId = 'session-1:msg-1:report.txt'
    await writeArtifact(tmpDir, versionId, 'Hello from the artifact!')

    server = new ReviewerHostServer(
      makeSession({
        artifacts: [
          { id: versionId, kind: 'managed-file', path: 'report.txt', mimeType: 'text/plain' }
        ]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    expect(body.result).toMatchObject({
      id: versionId,
      kind: 'raw',
      content: 'Hello from the artifact!'
    })
  })

  it('returns kind=raw for an artifact with no mimeType (content-sniff fallback)', async () => {
    const versionId = 'session-1:msg-1:unknown.bin'
    await writeArtifact(tmpDir, versionId, 'some text content')

    // Session has no mimeType for this artifact — should fall back to raw.
    server = new ReviewerHostServer(
      makeSession({
        artifacts: [{ id: versionId, kind: 'managed-file', path: 'unknown.bin' }]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    const result = body.result as { kind: string }
    expect(result.kind).toBe('raw')
  })

  it.each([
    ['plot.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['plot.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ['plot.gif', 'image/gif', Buffer.from('GIF89a', 'ascii')],
    ['plot.webp', 'image/webp', Buffer.from('RIFF0000WEBP', 'ascii')]
  ])('returns bounded %s media bytes outside JSON metadata', async (filename, mimeType, bytes) => {
    const versionId = `session-1:msg-1:${filename}`
    await writeArtifact(tmpDir, versionId, bytes)
    server = new ReviewerHostServer(
      makeSession({
        artifacts: [{ id: versionId, kind: 'managed-file', path: filename, mimeType }]
      }),
      makeScope([versionId]),
      tmpDir
    )

    const result = await server.readArtifact(versionId)

    expect(result).toMatchObject({
      id: versionId,
      kind: 'media',
      delivery: 'delivered',
      filename,
      mimeType,
      sizeBytes: bytes.length,
      returnedBytes: bytes.length,
      truncated: false
    })
    if (!('kind' in result) || result.kind !== 'media' || result.delivery !== 'delivered') {
      throw new Error('Expected delivered media content.')
    }
    expect(result.data).toEqual(bytes)

    ;({ endpoint, token } = await server.start())
    const compatibility = await post(endpoint, token, 'read_artifact', { id: versionId })
    expect(compatibility.result).toMatchObject({ kind: 'media', delivery: 'delivered' })
    expectByteFreeMetadata(compatibility.result, bytes)
  })

  it('returns only bounded opaque-binary metadata and an unsupported-format limitation', async () => {
    const versionId = 'session-1:msg-1:archive.zip'
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef])
    await writeArtifact(tmpDir, versionId, bytes)
    server = new ReviewerHostServer(
      makeSession({
        artifacts: [
          { id: versionId, kind: 'managed-file', path: 'archive.zip', mimeType: 'application/zip' }
        ]
      }),
      makeScope([versionId]),
      tmpDir
    )

    const result = await server.readArtifact(versionId)

    expect(result).toMatchObject({
      id: versionId,
      kind: 'unsupported',
      filename: 'archive.zip',
      mimeType: 'application/zip',
      sizeBytes: bytes.length,
      limitations: [{ kind: 'unsupported-format', subjectId: versionId }]
    })
    expectByteFreeMetadata(result, bytes)
  })

  it('does not return a partial invalid image when media exceeds the bounded read budget', async () => {
    const versionId = 'session-1:msg-1:large.png'
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 1)
    ])
    await writeArtifact(tmpDir, versionId, bytes)
    server = new ReviewerHostServer(
      makeSession({
        artifacts: [
          { id: versionId, kind: 'managed-file', path: 'large.png', mimeType: 'image/png' }
        ]
      }),
      makeScope([versionId]),
      tmpDir,
      undefined,
      undefined,
      { readBytes: 16, sessionBytes: 1_000 }
    )

    await expect(server.readArtifact(versionId)).resolves.toMatchObject({
      kind: 'media',
      delivery: 'limited',
      sizeBytes: bytes.length,
      returnedBytes: 0,
      truncated: true,
      limitations: expect.arrayContaining([
        expect.objectContaining({ kind: 'budget-exhausted', subjectId: versionId })
      ])
    })
    expectByteFreeMetadata(await server.readArtifact(versionId), bytes)
  })
})

// ---------------------------------------------------------------------------
// read_artifact: real content vs. read failure (regression: no silent-swallow)
// ---------------------------------------------------------------------------

describe('host.read_artifact — read failures are not empty content', () => {
  it('surfaces an error (not empty content) when the artifact file is missing on disk', async () => {
    // The version id is in scope, but no file was written to managed storage.
    server = new ReviewerHostServer(makeSession(), makeScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: V1 })

    // A read failure must be an error, NOT a { kind:'raw', content:'' } success — otherwise the
    // reviewer cannot tell "could not read" from "genuinely empty".
    expect(body.result).toBeUndefined()
    expect(body.error).toBeTruthy()
    expect(body.error).toMatch(/results\.csv|read/i)
  })

  it('returns empty content WITHOUT error for a genuinely empty (0-byte) readable artifact', async () => {
    const versionId = 'session-1:msg-1:empty.txt'
    await writeArtifact(tmpDir, versionId, '')

    server = new ReviewerHostServer(
      makeSession({
        artifacts: [
          { id: versionId, kind: 'managed-file', path: 'empty.txt', mimeType: 'text/plain' }
        ]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    expect(body.error).toBeUndefined()
    expect(body.result).toMatchObject({ id: versionId, kind: 'raw', content: '' })
  })
})

// ---------------------------------------------------------------------------
// read_artifact: scope isolation — out-of-scope id rejected
// ---------------------------------------------------------------------------

describe('host.read_artifact — scope isolation', () => {
  it('returns trusted role and source provenance for a frozen Source Document Version', async () => {
    const sourceVersionId = 'upload-version-1'
    const sourcePath = join(tmpDir, 'immutable-source.csv')
    const sourceContent = 'sample,value\na,1\n'
    const sourceChecksum = createHash('sha256').update(sourceContent).digest('hex')
    await writeFile(sourcePath, sourceContent)
    const resolver = vi.fn(async () => ({
      path: sourcePath,
      filename: 'source.csv',
      contentType: 'text/csv',
      checksum: sourceChecksum
    }))
    const sourceEvidence: ReviewerFileEvidenceDescriptor = {
      versionId: sourceVersionId,
      role: 'source_document',
      filename: 'source.csv',
      mimeType: 'text/csv',
      sizeBytes: 17,
      checksum: sourceChecksum,
      scopeReason: 'read-by-turn',
      traceAvailable: true,
      contentStatus: 'available'
    }
    const workTraceResolver = vi.fn()
    server = new ReviewerHostServer(
      makeSession(),
      { ...makeScope([V1]), sourceDocumentVersionIds: [sourceVersionId] },
      tmpDir,
      resolver,
      undefined,
      {},
      workTraceResolver,
      undefined,
      [sourceEvidence]
    )

    await expect(server.readArtifact(sourceVersionId)).resolves.toMatchObject({
      id: sourceVersionId,
      role: 'source_document',
      kind: 'tabular',
      rowCount: 1
    })
    await expect(server.readArtifact(sourceVersionId, { view: 'trace' })).resolves.toEqual({
      id: sourceVersionId,
      role: 'source_document',
      file: {
        filename: 'source.csv',
        mimeType: 'text/csv',
        sizeBytes: 17,
        checksum: sourceChecksum,
        contentStatus: 'available'
      },
      source: { kind: 'upload-version', scopeReason: 'read-by-turn' },
      limitations: []
    })
    expect(resolver).toHaveBeenCalledWith({ projectId: PROJECT, versionId: sourceVersionId })
    expect(workTraceResolver).not.toHaveBeenCalled()
  })

  it('does not elevate a Work Product to a trusted source based on its filename', async () => {
    const versionId = 'session-1:msg-1:source-document.csv'
    await writeArtifact(tmpDir, versionId, 'value\n42\n')
    server = new ReviewerHostServer(
      makeSession({
        artifacts: [
          { id: versionId, kind: 'managed-file', path: 'source-document.csv', mimeType: 'text/csv' }
        ]
      }),
      makeScope([versionId]),
      tmpDir
    )

    await expect(server.readArtifact(versionId)).resolves.toMatchObject({
      id: versionId,
      role: 'work_product'
    })
  })

  it('preserves Source checksum mismatch integrity and validates the descriptor authority', async () => {
    const sourceVersionId = 'upload-checksum-mismatch'
    const sourceEvidence: ReviewerFileEvidenceDescriptor = {
      versionId: sourceVersionId,
      role: 'source_document',
      filename: 'source.csv',
      mimeType: 'text/csv',
      sizeBytes: 20,
      checksum: 'a'.repeat(64),
      scopeReason: 'artifact-input',
      traceAvailable: true,
      contentStatus: 'checksum-mismatch'
    }
    server = new ReviewerHostServer(
      makeSession(),
      { ...makeScope([V1]), sourceDocumentVersionIds: [sourceVersionId] },
      tmpDir,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      [sourceEvidence]
    )

    await expect(server.readArtifact(sourceVersionId, { view: 'trace' })).resolves.toMatchObject({
      role: 'source_document',
      file: { contentStatus: 'checksum-mismatch' },
      source: { kind: 'artifact-input-version', scopeReason: 'artifact-input' },
      limitations: [{ kind: 'checksum-mismatch', subjectId: sourceVersionId }]
    })
    expect(
      () =>
        new ReviewerHostServer(
          makeSession(),
          { ...makeScope([V1]), sourceDocumentVersionIds: [sourceVersionId] },
          tmpDir
        )
    ).toThrow(/descriptor map/i)
  })

  it('rejects artifact ids not in the turn scope', async () => {
    server = new ReviewerHostServer(
      makeSession(),
      makeScope([V1]), // only V1 in scope
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    // A different version id is NOT in scope.
    const body = await post(endpoint, token, 'read_artifact', {
      id: 'session-1:msg-1:secret.csv'
    })

    expect(body.error).toMatch(/secret\.csv/)
    expect(body.error).toMatch(/not in this turn/)
  })

  it('rejects requests with an invalid bearer token', async () => {
    server = new ReviewerHostServer(makeSession(), makeScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer bad-token'
      },
      body: JSON.stringify({ method: 'read_artifact', params: { id: V1 } })
    })

    expect(response.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// read_artifact: CSV sniffing by content when no mimeType
// ---------------------------------------------------------------------------

describe('host.read_artifact — CSV content sniffing', () => {
  it('detects CSV by comma-delimited content even without a mimeType', async () => {
    const versionId = 'session-1:msg-1:data.csv'
    // A clean CSV file but stored without a mimeType in the session artifacts.
    await writeArtifact(tmpDir, versionId, 'x,y,z\n1,2,3\n4,5,6\n')

    server = new ReviewerHostServer(
      makeSession({
        // Artifact stored without mimeType but with .csv extension in path — use extension to sniff.
        artifacts: [{ id: versionId, kind: 'managed-file', path: 'data.csv' }]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    const result = body.result as { kind: string; rowCount: number }
    expect(result.kind).toBe('tabular')
    expect(result.rowCount).toBe(2)
  })

  it('detects TSV by .tsv extension when no mimeType', async () => {
    const versionId = 'session-1:msg-1:results.tsv'
    await writeArtifact(tmpDir, versionId, 'a\tb\tc\n1\t2\t3\n')

    server = new ReviewerHostServer(
      makeSession({
        artifacts: [{ id: versionId, kind: 'managed-file', path: 'results.tsv' }]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    const result = body.result as { kind: string }
    expect(result.kind).toBe('tabular')
  })
})

// ---------------------------------------------------------------------------
// read_turn / query_execution_log: surface tool I/O from toolContent
// ---------------------------------------------------------------------------

// A scope whose single block is the tool activity `act-1`.
const activityScope = (): TurnScope => ({
  turnMessageId: 'msg-1',
  blocks: [
    { id: 'activity:act-1', kind: 'activity', sourceId: 'act-1', blockIndex: 0, contentHash: 'h1' }
  ],
  artifactVersionIds: []
})

describe('host tool I/O — surfaced from toolContent', () => {
  it('surfaces tool payload text from toolContent when rawInput/rawOutput are absent', async () => {
    // Mirrors a real MCP notebook_execute activity: no rawInput/rawOutput, payload lives in toolContent.
    const session = makeSession({
      messages: [],
      activities: [
        {
          id: 'act-1',
          kind: 'tool',
          title: 'mcp__open-science-notebook__notebook_execute',
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          createdAt: 1,
          updatedAt: 2,
          toolContent: [
            { type: 'content', content: { type: 'text', text: '{"script":"print(6*7)"}' } }
          ]
        }
      ]
    })

    server = new ReviewerHostServer(session, activityScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    // query_execution_log exposes the payload.
    const log = await post(endpoint, token, 'query_execution_log', { activityId: 'act-1' })
    const records = log.result as Array<Record<string, unknown>>
    expect(records).toHaveLength(1)
    expect(JSON.stringify(records[0])).toContain('print(6*7)')

    // read_turn exposes the same payload on the activity block.
    const turn = await post(endpoint, token, 'read_turn')
    const blocks = turn.result as Array<Record<string, unknown>>
    expect(JSON.stringify(blocks[0])).toContain('print(6*7)')
  })

  it('preserves existing rawInput/rawOutput/terminalOutput (no regression)', async () => {
    const session = makeSession({
      messages: [],
      activities: [
        {
          id: 'act-1',
          kind: 'tool',
          title: 'Bash',
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          createdAt: 1,
          updatedAt: 2,
          rawInput: { command: 'ls' },
          rawOutput: { stdout: 'file.txt' },
          terminalOutput: 'file.txt'
        }
      ]
    })

    server = new ReviewerHostServer(session, activityScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    const log = await post(endpoint, token, 'query_execution_log', { activityId: 'act-1' })
    const records = log.result as Array<{
      rawInput?: unknown
      rawOutput?: unknown
      terminalOutput?: string
    }>
    expect(records[0].rawInput).toEqual({ command: 'ls' })
    expect(records[0].rawOutput).toEqual({ stdout: 'file.txt' })
    expect(records[0].terminalOutput).toBe('file.txt')
  })

  it('tolerates empty / malformed toolContent blocks without throwing', async () => {
    const session = makeSession({
      messages: [],
      activities: [
        {
          id: 'act-1',
          kind: 'tool',
          title: 'mcp__open-science-notebook__notebook_execute',
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          createdAt: 1,
          updatedAt: 2,
          toolContent: [
            {},
            { type: 'content' },
            { type: 'content', content: { type: 'text', text: 'kept-text' } }
          ]
        }
      ]
    })

    server = new ReviewerHostServer(session, activityScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    const log = await post(endpoint, token, 'query_execution_log', { activityId: 'act-1' })
    expect(log.error).toBeUndefined()
    const records = log.result as Array<Record<string, unknown>>
    expect(JSON.stringify(records[0])).toContain('kept-text')
  })
})

// ---------------------------------------------------------------------------
// host RPC — method surface discoverability
// ---------------------------------------------------------------------------

describe('host RPC — method surface', () => {
  it('answers an unknown method with an error naming the supported methods', async () => {
    server = new ReviewerHostServer(makeSession(), makeScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    // The reviewer model tends to guess methods like `list_artifacts`; the error must tell it what
    // IS available so it stops guessing.
    const body = await post(endpoint, token, 'list_artifacts')

    expect(body.result).toBeUndefined()
    expect(body.error).toMatch(/list_artifacts/)
    expect(body.error).toMatch(/read_turn/)
    expect(body.error).toMatch(/query_execution_log/)
    expect(body.error).toMatch(/read_artifact/)
  })
})

describe('buildReviewerHostPythonBootstrap — single source of the host client', () => {
  it('defines all three supported host methods and binds the endpoint/token', () => {
    const code = buildReviewerHostPythonBootstrap('http://127.0.0.1:9', 'tok-123')

    expect(code).toContain('def read_turn')
    expect(code).toContain('def query_execution_log')
    expect(code).toContain('def read_artifact')
    expect(code).toContain('http://127.0.0.1:9')
    expect(code).toContain('tok-123')
  })
})
