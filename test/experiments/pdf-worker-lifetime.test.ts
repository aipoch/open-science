import { Worker } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

const nestedSource = `
const { workerData, parentPort } = require('node:worker_threads')
const counter = new Int32Array(workerData.counter)
Atomics.add(counter, 0, 1)
parentPort.postMessage('ready')
while (true) Atomics.add(counter, 0, 1)
`
const outerSource = `
const { Worker, parentPort, workerData } = require('node:worker_threads')
const child = new Worker(workerData.source, { eval: true, workerData })
child.once('message', () => parentPort.postMessage('ready'))
`
it('terminating the owner stops a real busy descendant', async () => {
  const counter = new SharedArrayBuffer(4)
  const view = new Int32Array(counter)
  const outer = new Worker(outerSource, {
    eval: true,
    workerData: { counter, source: nestedSource }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      outer.once('message', () => resolve())
      outer.once('error', reject)
    })
    expect(Atomics.load(view, 0), 'descendant must actually be active').toBeGreaterThan(0)
    await outer.terminate() // ABLATION: owner termination
    expect(outer.threadId, 'termination must confirm the owner has exited').toBe(-1)
    const stopped = Atomics.load(view, 0)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(Atomics.load(view, 0), 'no descendant work may survive awaited owner termination').toBe(
      stopped
    )
  } finally {
    await outer.terminate()
  }
}, 5000)

it('initializes bundled language byte objects by language code, not byte contents', () => {
  const require = createRequire(import.meta.url)
  const source = readFileSync(require.resolve('tesseract.js/src/worker-script/index.js'), 'utf8')
  const declaration = source.match(/const langs = \(typeof _langs === 'string'\)[\s\S]*?;/)?.[0]
  expect(
    declaration,
    'pin the real installed initializer, not a duplicate implementation'
  ).toBeTruthy()
  const initializer = runInNewContext(`(_langs) => { ${declaration} return langs }`) as (
    langs: unknown
  ) => string
  expect(
    initializer([
      { code: 'eng', data: new Uint8Array([1, 2]) },
      { code: 'chi_sim', data: new Uint8Array([3, 4]) }
    ])
  ).toBe('eng+chi_sim')
})
