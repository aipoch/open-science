import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import type { PdfStructureEngine, PdfStructureEngineOptions } from './types.js'
import { nodeProcessRuntime } from './node-runtime.js'
import { readWorkerResult } from './worker-result.js'

// Internal resource override is used only by package lifecycle tests.
export const createEngineAt = (
  resources: string,
  options: PdfStructureEngineOptions
): PdfStructureEngine => {
  const runtimeHost = options.runtime ?? nodeProcessRuntime
  return {
    async describe() {
      const hash = createHash('sha256')
        .update('candidate-pdf-engine-v2')
        .update(JSON.stringify(options.modelRecipe))
      const require = createRequire(pathToFileURL(join(resources, 'host.mjs')))
      hash.update(JSON.stringify(sharp.versions))
      for (const dependency of ['pdfjs-dist', '@napi-rs/canvas']) {
        hash
          .update(dependency)
          .update(await readFile(require.resolve(`${dependency}/package.json`)))
      }
      for (const name of (await readdir(resources))
        .filter((name) => name.endsWith('.mjs'))
        .sort()) {
        hash.update(name).update(await readFile(join(resources, name)))
      }
      return { fingerprint: hash.digest('hex'), modelRevision: options.modelRecipe.revision }
    },
    start(request) {
      const thumbnails = new Map<string, Uint8Array>()
      const output = join(dirname(request.inputPath), 'extractor')
      const runtime = request.model.assets.find((asset) => asset.file === 'ort.wasm.min.mjs')
      if (
        !runtime ||
        request.identity.sourceSizeBytes > 50 * 1024 ** 2 ||
        request.identity.requestedPages.length > 5
      ) {
        return {
          thumbnails,
          result: Promise.reject(new Error('PDF resources or request limits are unsupported.')),
          stop: async () => undefined
        }
      }
      const child = runtimeHost.spawn(join(resources, 'host.mjs'))
      let failure: Error | undefined
      let stderr = ''
      let bytes = 0
      let stopping: Promise<void> | undefined
      let stopped = false
      let converting: Promise<unknown> | undefined
      const closed = new Promise<void>((resolve) => {
        child.once('error', (error) => {
          failure = error
        })
        child.once('close', (code) => {
          if (code !== 0 && !failure) failure = new Error(stderr.trim() || 'PDF extraction failed.')
          resolve()
        })
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000)
      })
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 4 * 1024 ** 2) {
          failure = new Error('PDF worker output limit exceeded.')
          void stop().catch(() => undefined)
        }
      })
      const stop = (): Promise<void> => {
        if (stopped) return Promise.resolve()
        stopping ??= (async () => {
          if (child.exitCode === null && child.signalCode === null) {
            await runtimeHost.stop(child)
          }
          await closed
          await converting?.catch(() => undefined)
          const cleanup = await import(pathToFileURL(join(resources, 'scratch.mjs')).href)
          await cleanup.inspectScratch(output, true)
          stopped = true
        })().finally(() => {
          stopping = undefined
        })
        return stopping
      }
      const abort = (): void => {
        void stop().catch(() => undefined)
      }
      request.signal.addEventListener('abort', abort, { once: true })
      child.stdin.on('error', (error) => {
        failure ??= error
      })
      child.stdin.write(
        JSON.stringify({
          input: request.inputPath,
          output,
          assets: dirname(runtime.path),
          runtime: runtime.path,
          pages: request.identity.requestedPages
        }) + '\n'
      )
      if (request.signal.aborted) abort()
      try {
        request.onProgress({ phase: 'extracting', processedPages: [] })
      } catch (error) {
        // A standalone observer must not prevent returning the owned job's cleanup handle.
        failure = error instanceof Error ? error : new Error(String(error))
        void stop().catch(() => undefined)
      }
      const result = (async () => {
        await closed
        request.signal.throwIfAborted()
        if (failure) throw failure
        converting = readWorkerResult(output, request.identity, thumbnails)
        const value = await converting
        request.signal.throwIfAborted()
        request.onProgress({
          phase: 'complete',
          processedPages: [...request.identity.requestedPages]
        })
        return value
      })().finally(() => request.signal.removeEventListener('abort', abort))
      void result.catch(() => undefined)
      return { result, thumbnails, stop }
    }
  }
}
