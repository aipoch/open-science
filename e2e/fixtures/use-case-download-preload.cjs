'use strict'
/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Node network fixture for the real Electron journey. */
// Replace only public catalog HTTP responses; the preload bridge, downloader, filesystem and importer stay real.
if (!process.versions.electron && process.env.OPEN_SCIENCE_E2E_USE_CASE_GATE) {
  const { readFileSync, existsSync, appendFileSync } = require('node:fs')
  const { join } = require('node:path')
  const { createHash } = require('node:crypto')
  const bytes = readFileSync(
    join(
      __dirname,
      '../../src/main/session-package/fixtures/session-package-v0.31.1-minimal.science'
    )
  )
  const manifest = Array.from({ length: 7 }, (_, index) => ({
    name: `example-${index + 1}`,
    title: `Example ${index + 1}`,
    cover: { file_name: 'cover.png' },
    case: {
      file_name: 'example.science',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  }))
  const gate = process.env.OPEN_SCIENCE_E2E_USE_CASE_GATE
  const original = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    const url = String(input)
    if (url === 'https://statics.aipoch.com/open-science/usecases/manifest.json') {
      appendFileSync(`${gate}.catalog-requests`, 'request\n')
      if (existsSync(`${gate}.catalog-offline`)) throw new Error('Catalog offline')
      return Response.json(manifest)
    }
    if (
      /^https:\/\/statics\.aipoch\.com\/open-science\/usecases\/example-\d\/example\.science$/.test(
        url
      )
    ) {
      if (existsSync(`${gate}.fail`)) return new Response(null, { status: 503 })
      let offset = 0
      return new Response(
        new ReadableStream({
          async pull(controller) {
            if (offset > 0) {
              while (!existsSync(gate)) {
                options.signal.throwIfAborted()
                await new Promise((resolve) => setTimeout(resolve, 50))
              }
            }
            options.signal.throwIfAborted()
            const end = offset === 0 ? Math.floor(bytes.length / 4) : bytes.length
            controller.enqueue(bytes.subarray(offset, end))
            offset = end
            if (offset === bytes.length) controller.close()
          }
        })
      )
    }
    return original(input, options)
  }
}
