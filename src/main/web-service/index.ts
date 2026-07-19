import { join } from 'node:path'

import { app } from 'electron'

import { createLogger } from '../logger'
import { resolveConfigRoot } from '../storage-root'
import { loadOrCreateWebToken } from './auth'
import { startWebHttpServer, type RunningWebServer } from './http-server'
import type { WebModeOptions } from './options'
import type { RpcCapture } from './rpc-capture'

const startOptionalWebService = async ({
  options,
  rpc
}: {
  options: WebModeOptions
  rpc: RpcCapture
}): Promise<RunningWebServer | undefined> => {
  if (!options.enabled) return undefined

  const token = await loadOrCreateWebToken(resolveConfigRoot())
  const server = await startWebHttpServer({
    host: '127.0.0.1',
    port: options.port,
    token,
    staticRoot: join(app.getAppPath(), 'out', 'web'),
    rpc,
    bootstrap: {
      appName: app.getName(),
      appVersion: app.getVersion(),
      platform: process.platform,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node
      }
    }
  })

  const url = `http://127.0.0.1:${server.port}/?token=${encodeURIComponent(token)}`
  createLogger('web-service').info('local web service started', {
    host: '127.0.0.1',
    port: server.port,
    url: `http://127.0.0.1:${server.port}/`
  })
  console.log(`Open Science Web: ${url}`)
  return server
}

export { parseWebModeOptions } from './options'
export { startOptionalWebService }
export type { RunningWebServer }
