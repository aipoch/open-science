import { mkdtemp, rm, writeFile, readFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as realSetTimeout } from 'node:timers'
import { execFileSync } from 'node:child_process'
import type { PDFPageProxy } from 'pdfjs-dist'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { beforeAll, expect, it, vi } from 'vitest'
import { extractPdfText } from './pdf-text-extraction'
import { createPdfOcrSession, PDF_OCR_TIMEOUT_MS } from './pdf-ocr'
import { createLocalModelOwner } from '../local-models/owner'
import { OCR_MODEL_REVISIONS } from '../local-models/catalog'
const catalog = OCR_MODEL_REVISIONS[0]

const fault = vi.hoisted(() => ({ counter: undefined as SharedArrayBuffer | undefined }))
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(file: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        super(
          file,
          fault.counter ? { ...options, workerData: { counter: fault.counter } } : options
        )
      }
    }
  }
})

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/ocr/build.mjs'], { cwd: process.cwd() })
}, 30_000)
const installComponent = async (
  root: string
): Promise<ReturnType<typeof createLocalModelOwner>> => {
  expect(JSON.parse(await readFile('out/ocr/manifest.json', 'utf8'))).toEqual(catalog)
  const owner = createLocalModelOwner({
    namespace: 'ocr',
    dataRoot: () => root,
    acquireWriter: () => () => {},
    revisions: [catalog],
    download: async (url, destination) => {
      const asset = catalog.assets.find((asset) => asset.url === url)!
      await copyFile(join(process.cwd(), 'out/ocr', asset.file), destination)
      return destination
    }
  })
  await owner.install()
  await vi.waitFor(async () => expect((await owner.getSnapshot()).availability).toBe('ready'), {
    timeout: 10_000
  })
  return owner
}

it('joins the real downloaded worker and descendant before releasing its component lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-ocr-timeout-'))
  const owner = await installComponent(root)
  const lease = await owner.acquireUse()
  const entry = lease.assets.find((asset) => asset.file === 'ocr-worker.mjs')!.path
  const wrapper = join(root, 'stalled.mjs')
  const counter = new Int32Array(new SharedArrayBuffer(8))
  // Real OCR completes, but its result is withheld; a heartbeat in its descendant proves cleanup.
  await writeFile(
    wrapper,
    `
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
const require=createRequire(import.meta.url), threads=require('node:worker_threads');
const OriginalWorker=threads.Worker, counter=new Int32Array(workerData.counter);
threads.Worker=class extends OriginalWorker {
 constructor(file, options) { super(\`const {workerData}=require('node:worker_threads');
 const counter=new Int32Array(workerData.counter); setInterval(()=>Atomics.add(counter,0,1),1);
 import(workerData.entry);\`,{...options,eval:true,workerData:{entry:require('node:url').pathToFileURL(file).href,counter:workerData.counter}}); }
};
parentPort.postMessage=(result)=>{if(result.text?.includes('cleanup evidence'))Atomics.store(counter,1,1)};
await import(${JSON.stringify(pathToFileURL(entry).href)});
`
  )
  // The wrapper only supplies fault instrumentation; the actual worker and engine are unchanged.
  fault.counter = counter.buffer as SharedArrayBuffer
  let released = false
  const session = createPdfOcrSession({
    acquireUse: async () => ({
      ...lease,
      assets: lease.assets.map((asset) =>
        asset.file === 'ocr-worker.mjs' ? { ...asset, path: wrapper } : asset
      ),
      release: () => {
        released = true
        lease.release()
      }
    })
  })
  let pending: Promise<string> | undefined
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 200 * scale }),
      render: ({
        canvasContext
      }: {
        canvasContext: ReturnType<ReturnType<typeof createCanvas>['getContext']>
      }) => {
        canvasContext.fillStyle = 'white'
        canvasContext.fillRect(0, 0, 1800, 600)
        canvasContext.fillStyle = 'black'
        canvasContext.font = '70px sans-serif'
        canvasContext.fillText('cleanup evidence', 50, 200)
        return { promise: Promise.resolve(), cancel: () => {} }
      }
    } as unknown as PDFPageProxy
    pending = session.recognize(page)
    const failure = expect(pending).rejects.toThrow('deadline exceeded')
    for (let i = 0; i < 200 && !Atomics.load(counter, 1); i++)
      await new Promise((resolve) => realSetTimeout(resolve, 50))
    expect(Atomics.load(counter, 1)).toBe(1)
    expect(released).toBe(false)
    await vi.advanceTimersByTimeAsync(PDF_OCR_TIMEOUT_MS + 1)
    await failure
    expect(released).toBe(true)
    const stopped = Atomics.load(counter, 0)
    await new Promise((resolve) => realSetTimeout(resolve, 100))
    expect(Atomics.load(counter, 0)).toBe(stopped)
  } finally {
    await session.close()
    await pending?.catch(() => {})
    fault.counter = undefined
    vi.useRealTimers()
    lease.release()
    await owner.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('reads a real mixed PDF offline and reports blank pages without claiming full coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-ocr-'))
  let registeredFont: ReturnType<typeof GlobalFonts.registerFromPath> | undefined
  try {
    registeredFont = GlobalFonts.registerFromPath(
      join(process.cwd(), 'packages/pdf-translation/resources/NotoSansSC-Regular.otf'),
      'PdfOcrTest'
    )
    if (!registeredFont) throw new Error('OCR fixture font is unavailable.')
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([600, 800]).drawText('Native clinical evidence', { x: 40, y: 700, font, size: 20 })
    const canvas = createCanvas(1200, 400)
    const context = canvas.getContext('2d')
    context.fillStyle = 'white'
    context.fillRect(0, 0, 1200, 400)
    context.fillStyle = 'black'
    context.font = '48px PdfOcrTest'
    context.fillText('Clinical evidence improves research', 35, 120)
    context.fillText('Patients received treatment daily', 35, 210)
    context.fillText('临床证据支持科学研究', 35, 300)
    const image = await pdf.embedPng(await canvas.encode('png'))
    pdf.addPage([600, 800]).drawImage(image, { x: 0, y: 300, width: 600, height: 200 })
    const headedScan = pdf.addPage([600, 800])
    headedScan.drawText('1', { x: 40, y: 760, font, size: 12 })
    headedScan.drawImage(image, { x: 0, y: 300, width: 600, height: 200 })
    pdf.addPage([600, 800])
    const path = join(root, 'mixed.pdf')
    await writeFile(path, await pdf.save())
    const before = await extractPdfText(path, undefined, { ocr: true })
    expect(before.text).not.toMatch(/Patients received/)
    expect(before.coverage?.unavailablePages).toEqual([2, 3, 4])
    const owner = await installComponent(root)
    const result = await extractPdfText(path, undefined, {
      ocr: true,
      createOcrSession: () => createPdfOcrSession(owner)
    })
    expect((await owner.getSnapshot()).inUse).toBe(false)
    await owner.remove()
    expect((await owner.getSnapshot()).availability).toBe('notInstalled')
    await owner.close()
    expect(result.text).toContain('Native clinical evidence')
    expect(
      result.text.match(/Clinical evidence improves research/gi),
      'a native page number must not hide the scanned body'
    ).toHaveLength(2)
    expect(result.text.replace(/\s/g, '')).toContain('临床证据支持科学研究')
    expect(result.coverage).toEqual({
      textPages: [1, 3],
      ocrPages: [2, 3],
      unavailablePages: [4],
      uncheckedPages: [],
      unverifiedPages: [2, 3]
    })
    expect(result.truncated).toBe(false)
    const native = await extractPdfText(path)
    expect(native.coverage?.unavailablePages).toEqual([2, 4])
    expect(native.text).not.toMatch(/Patients received/)
  } finally {
    try {
      if (registeredFont) GlobalFonts.remove(registeredFont)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}, 120_000)
