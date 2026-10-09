import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

// Reuses the Web transport's authenticated streaming preview route. The token and fixed endpoint
// stay in Electron main; renderers continue using their existing opaque custom-protocol URLs.
export async function createDesktopPreviewProxy(
  configRoot: string,
  expectedPid: number
): Promise<{
  fetch(request: Request): Promise<Response>
  dispose(): void
}> {
  const state = z
    .object({ pid: z.literal(expectedPid), port: z.number().int().min(1).max(65535) })
    .parse(JSON.parse(await readFile(join(configRoot, 'web-service.json'), 'utf8')))
  const token = (await readFile(join(configRoot, 'web-token'), 'utf8')).trim()
  if (token.length < 32) throw new Error('Invalid backend preview authentication.')
  const lifetime = new AbortController()
  return {
    dispose: () => lifetime.abort(),
    fetch: async (request) => {
      lifetime.signal.throwIfAborted()
      const url = new URL(request.url)
      if (
        url.protocol !== 'open-science-preview:' ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.port ||
        !['GET', 'HEAD'].includes(request.method)
      )
        throw new Error('Invalid managed preview request.')
      const headers = new Headers({ authorization: `Bearer ${token}` })
      const range = request.headers.get('range')
      if (range) headers.set('range', range)
      const response = await fetch(
        `http://127.0.0.1:${state.port}/preview/${encodeURIComponent(url.hostname)}${url.pathname}`,
        {
          method: request.method,
          headers,
          redirect: 'error',
          signal: AbortSignal.any([request.signal, lifetime.signal])
        }
      )
      const outgoing = new Headers(response.headers)
      outgoing.delete('set-cookie')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: outgoing
      })
    }
  }
}
