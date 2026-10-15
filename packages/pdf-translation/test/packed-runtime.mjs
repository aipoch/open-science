/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationOwner } from '@aipoch/pdf-translation'
import { PdfTranslationWriter } from '@aipoch/pdf-translation/writer'
import { pdfTranslationWorkerPath } from '@aipoch/pdf-translation/resources'
import { stat } from 'node:fs/promises'

assert.ok((await stat(pdfTranslationWorkerPath())).isFile())
const original = await PDFDocument.create()
const font = await original.embedFont(StandardFonts.Helvetica)
original.addPage([400, 300]).drawText('Cell growth is measured.', { font, size: 12, x: 30, y: 250 })
const data = await original.save()
const writer = new PdfTranslationWriter()
const controller = new AbortController()
const caller = {
  leaseId: 'packed-consumer',
  generation: 1,
  signal: controller.signal,
  isCurrent: () => !controller.signal.aborted
}
const request = {
  id: 'packed-output',
  data,
  pages: [{ width: 400, height: 300 }],
  units: [
    {
      source: 'Cell growth is measured.',
      translation: '测量细胞生长。',
      fragments: [{ pageNumber: 1, rect: { x: 0.06, y: 0.1, width: 0.88, height: 0.18 } }]
    }
  ]
}
const result = await writer.generateDetailed(request, caller)
assert.ok(result?.data.byteLength)
assert.deepEqual(result.layoutFailures, [])
const loading = getDocument({ data: result.data.slice(), useSystemFonts: true })
try {
  const document = await loading.promise
  assert.equal(document.numPages, 1)
  const text = (await (await document.getPage(1)).getTextContent()).items
    .map((item) => item.str ?? '')
    .join('')
  assert.ok(text.includes('测量细胞生长。'), text)
} finally {
  await loading.destroy()
}
const cancelled = writer.generateDetailed({ ...request, id: 'packed-cancel' }, caller)
controller.abort()
assert.equal(await cancelled, null)
await assert.rejects(import('@aipoch/pdf-translation/reader/source'), {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
})
await assert.rejects(import('@aipoch/pdf-translation/dist/writer.js'), {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
})
console.log('Packed translation worker, WASM/font output, text roundtrip and cancellation passed.')

// Exercise the root workflow with one backend at a time, without an Agent or host code.
for (const mode of ['api', 'local']) {
  const lifetime = new AbortController()
  const lease = {
    leaseId: mode,
    generation: 1,
    signal: lifetime.signal,
    isCurrent: () => !lifetime.signal.aborted
  }
  const completions = []
  let recovered = 0,
    flushed = 0,
    released = 0,
    stopped = 0
  const usage = {
    start: async () => async (completion) => {
      completions.push(completion)
    },
    recover: async () => {
      recovered++
    },
    flush: async () => {
      flushed++
    }
  }
  const run = async ({ signal }) => {
    signal.throwIfAborted()
    return {
      text: '测量细胞生长。',
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 4, cacheTokens: 0 }
    }
  }
  const owner = new PdfTranslationOwner({
    usage,
    ...(mode === 'api'
      ? {
          captureApiTarget: async () => ({ providerId: 'consumer', model: 'translator' }),
          apiRunner: { supportsTarget: () => true, run }
        }
      : {
          localRunner: {
            acquireTarget: async () => ({ modelId: 'consumer', revision: '1' }),
            run,
            release: async () => {
              released++
            },
            shutdown: async () => {
              stopped++
            }
          }
        })
  })
  try {
    await owner.sweepStaleProfiles()
    const source = 'Cell growth is measured.'
    const input = {
      resourceRequestKey: mode,
      fingerprint: 'consumer',
      language: '中文',
      glossary: [],
      sources: [source]
    }
    await assert.rejects(owner.begin(input, lease), { code: 'unsupported-model' })
    const { operationId } = await owner.begin({ ...input, targetId: mode }, lease)
    assert.equal(
      await owner.translate({ operationId, sourceIndex: 0, source }, lease),
      '测量细胞生长。'
    )
    lifetime.abort()
    await assert.rejects(owner.translate({ operationId, sourceIndex: 0, source }, lease))
  } finally {
    await owner.shutdown()
  }
  assert.equal(recovered, 1)
  assert.equal(flushed, 1)
  assert.equal(completions.length, 1)
  assert.equal(completions[0].status, 'completed')
  assert.equal(released, mode === 'local' ? 1 : 0)
  assert.equal(stopped, mode === 'local' ? 1 : 0)
}
console.log(
  'Packed API-only and local-only translation workflows, leases, usage and shutdown passed.'
)

// Independent installed consumer: whole-object storage, no SQL schema or serialized row fields.
const { PdfTranslationCheckpoints } = await import('@aipoch/pdf-translation/storage')
let saved
const repository = {
  canPersist: async () => true,
  async transaction(operation) {
    let working = structuredClone(saved)
    const result = await operation({
      requireSource: async () => ({ sizeBytes: 12n }),
      requireDocument: async () => 'consumer-document',
      findLatest: async () => structuredClone(working ?? null),
      readHeader: async () => working ?? null,
      readMetadata: async () => working?.checkpoint ?? null,
      insert: async (record) => {
        working = structuredClone(record)
      },
      commit: async (_id, expectedRevision, change) => {
        if (working.checkpoint.revision !== expectedRevision) return false
        working.checkpoint = structuredClone(change.checkpoint)
        return true
      }
    })
    saved = working
    return result
  }
}
const checkpoints = () =>
  new PdfTranslationCheckpoints({
    getClient: async () => repository,
    resolveSource: async (sourceId) => ({ sourceId, checksum: 'a'.repeat(64) })
  })
const store = checkpoints()
const admitted = await store.open(
  {
    resourceRequestKey: 'installed',
    sourceId: 'custom:paper',
    fingerprint: 'fp',
    language: 'Chinese',
    glossary: [],
    sources: ['cell', '12']
  },
  'b'.repeat(64),
  { frameworkId: 'consumer', modelId: 'model' }
)
const progress = await store.append(admitted, 0, '细胞', new AbortController().signal)
assert.deepEqual((await checkpoints().read('custom:paper')).translations, ['细胞'])
await assert.rejects(
  store.append(admitted, 0, '细胞', new AbortController().signal),
  /another window/
)
const cancellation = new AbortController()
const transaction = repository.transaction.bind(repository)
repository.transaction = (operation) =>
  transaction((tx) =>
    operation({
      ...tx,
      commit: async (...args) => {
        const changed = await tx.commit(...args)
        cancellation.abort()
        return changed
      }
    })
  )
await assert.rejects(store.append(progress, 1, '12', cancellation.signal))
assert.equal(saved.checkpoint.revision, progress.revision)
assert.deepEqual(saved.checkpoint.translations, ['细胞'])
console.log(
  'Packed typed checkpoint consumer: reopen, CAS conflicts and cancellation rollback passed.'
)
