import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve inferred fixture types.
const setup = async (mode: 'success' | 'reject' | 'hang') => {
  const root = await mkdtemp(join(tmpdir(), 'scan-ocr-'))
  roots.push(root)
  const enginePath = join(root, 'engine.cjs')
  const language = join(root, 'eng.traineddata.gz')
  await writeFile(language, 'local fixture')
  // Exercise the standard Tesseract worker messages without downloading models.
  await writeFile(
    enginePath,
    `
    const {parentPort}=require('node:worker_threads');
    parentPort.on('message', ({workerId,jobId,action}) => {
      if (action === 'loadLanguage' && ${JSON.stringify(mode)} === 'hang') return;
      if (action === 'loadLanguage' && ${JSON.stringify(mode)} === 'reject') {
        parentPort.postMessage({workerId,jobId,action,status:'reject',data:'bad language'}); return;
      }
      parentPort.postMessage({workerId,jobId,action,status:'resolve',data: action === 'recognize' ? {
        confidence: 92,
        tsv: 'level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n5\\t1\\t1\\t1\\t1\\t1\\t10\\t20\\t40\\t10\\t92\\tFIGURE'
      } : {}});
    });
  `
  )
  const { createScanOcr } = await import(
    `${pathToFileURL(resolve('resources/literature-pdf-scan-ocr.mjs')).href}?test=${roots.length}-${mode}`
  )
  return createScanOcr({ enginePath, languages: ['eng'], languageAssets: { eng: language } })
}
it('returns measured OCR word boxes using only supplied local assets', async () => {
  const session = await setup('success')
  expect(
    await session.recognize(Buffer.from('image'), 100, 100, { width: 200, height: 300 })
  ).toEqual([{ text: 'FIGURE', confidence: 92, rect: [20, 60, 100, 90] }])
  await session.close()
})
it('falls back and terminates workers after a language initialization failure', async () => {
  const session = await setup('reject')
  expect(
    await session.recognize(Buffer.from('image'), 100, 100, { width: 100, height: 100 })
  ).toBeUndefined()
  await session.close()
})
it('bounds a stalled initialization and closes its nested worker', async () => {
  const session = await setup('hang')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const pending = session.recognize(Buffer.from('image'), 100, 100, { width: 100, height: 100 })
  await vi.advanceTimersByTimeAsync(30001)
  expect(await pending).toBeUndefined()
  await session.close()
})
