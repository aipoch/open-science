/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Transport checks only. Real browser DOM/visual checks are documented in README.md.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const [pdfPath] = process.argv.slice(2)
assert(pdfPath, 'Usage: check-viewer.mjs <exported.pdf>')
const worker = spawn(
  process.execPath,
  [fileURLToPath(new URL('./serve-viewer.mjs', import.meta.url)), pdfPath, '0'],
  { stdio: ['ignore', 'pipe', 'inherit'] }
)
const exited = once(worker, 'exit')
const lines = createInterface({ input: worker.stdout })
try {
  const [url] = await once(lines, 'line', { signal: AbortSignal.timeout(10_000) })
  const htmlResponse = await fetch(url)
  assert.equal(htmlResponse.status, 200)
  const html = await htmlResponse.text()
  assert(html.includes('/pdfjs/web/pdf_viewer.css'))
  assert(html.includes('max-height: min(320px, 40vh)'))
  assert(html.includes('PDF annotation assistive text is visually exposed'))
  assert(!html.includes('deleteRule'), 'User-facing preview must not remove annotation styles')
  const oldLink = await fetch(new URL('/?page=2&missing-style=1', url))
  assert.equal(oldLink.status, 200)
  assert.equal(await oldLink.text(), html, 'Old reproduction links must serve the normal viewer')
  const cssResponse = await fetch(new URL('/pdfjs/web/pdf_viewer.css', url))
  assert.equal(cssResponse.status, 200)
  assert(cssResponse.headers.get('content-type').startsWith('text/css'))
  assert((await cssResponse.text()).includes('.overlaidText'))
  const moduleResponse = await fetch(new URL('/pdfjs/build/pdf.mjs', url))
  assert.equal(moduleResponse.status, 200)
  assert(moduleResponse.headers.get('content-type').startsWith('text/javascript'))
  await moduleResponse.body.cancel()
  const input = await readFile(pdfPath)
  const served = Buffer.from(await (await fetch(new URL('/sample.pdf', url))).arrayBuffer())
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
  assert.equal(hash(served), hash(input), 'Viewer must receive the unchanged exported PDF')
  for (const path of ['/package.json', '/pdfjs/%2e%2e%2fpackage.json', '/pdfjs/build/']) {
    assert.equal((await fetch(new URL(path, url))).status, 404)
  }
  assert.equal((await fetch(url, { method: 'POST' })).status, 405)
  console.log('PASS: paired styles/modules, exact PDF bytes, read-only routes and path boundary')
} finally {
  lines.close()
  worker.kill()
  await exited
}
