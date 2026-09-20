// Read-only, loopback-only browser diagnostic. Never imported by the application.
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const [pdfArg, portArg = '5198'] = process.argv.slice(2)
assert(pdfArg, 'Usage: serve-viewer.mjs <exported.pdf> [port]')
const pdfPath = resolve(pdfArg)
assert((await stat(pdfPath)).isFile(), 'Input must be a PDF file')
const port = Number(portArg)
assert(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid port')
const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const viewerPath = fileURLToPath(new URL('./viewer.html', import.meta.url))
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
}
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end()
      return
    }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    let path
    if (pathname === '/' || pathname === '/viewer.html') path = viewerPath
    else if (pathname === '/sample.pdf') path = pdfPath
    else if (pathname.startsWith('/pdfjs/')) {
      const candidate = resolve(pdfjsRoot, pathname.slice('/pdfjs/'.length))
      const within = relative(pdfjsRoot, candidate)
      if (within && !within.startsWith('..') && !isAbsolute(within)) path = candidate
    }
    if (!path || !(await stat(path)).isFile()) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'Content-Type': mime[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    if (request.method === 'HEAD') response.end()
    else await pipeline(createReadStream(path), response)
  } catch (error) {
    if (response.headersSent) response.destroy()
    else response.writeHead(error.code === 'ENOENT' ? 404 : 400).end()
  }
})
server.listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}/`)
})
