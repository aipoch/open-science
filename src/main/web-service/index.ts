import { join } from 'node:path'

import { app } from 'electron'

import { createLogger } from '../logger'
import { resolveConfigRoot } from '../storage-root'
import { loadOrCreateWebToken } from './auth'
import { startWebHttpServer, type RunningWebServer } from './http-server'
import type { WebModeOptions } from './options'
import type { RpcCapture } from './rpc-capture'
import { removeWebServiceState, writeWebServiceState } from './state-file'

const startOptionalWebService = async ({
  options,
  rpc,
  requestShutdown
}: {
  options: WebModeOptions
  rpc: RpcCapture
  requestShutdown: () => void
}): Promise<RunningWebServer | undefined> => {
  if (!options.enabled) return undefined

  const configRoot = resolveConfigRoot()
  const token = await loadOrCreateWebToken(configRoot)
  const server = await startWebHttpServer({
    host: '127.0.0.1',
    port: options.port,
    token,
    staticRoot: join(app.getAppPath(), 'out', 'web'),
    rpc,
    onShutdownRequest: requestShutdown,
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

  try {
    await writeWebServiceState(configRoot, {
      pid: process.pid,
      port: server.port,
      startedAt: new Date().toISOString(),
      appVersion: app.getVersion()
    })
  } catch (error) {
    await server.close()
    throw error
  }

  const url = `http://127.0.0.1:${server.port}/?token=${encodeURIComponent(token)}`
  createLogger('web-service').info('local web service started', {
    host: '127.0.0.1',
    port: server.port,
    url: `http://127.0.0.1:${server.port}/`
  })
  console.log(`Open Science Web: ${url}`)
  return {
    port: server.port,
    close: async () => {
      try {
        await server.close()
      } finally {
        await removeWebServiceState(configRoot)
      }
    }
  }
}

const buildAuthenticatedWebUrl = async (port: number): Promise<string> => {
  const token = await loadOrCreateWebToken(resolveConfigRoot())
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
}

export { parseWebModeOptions } from './options'
export { buildAuthenticatedWebUrl, startOptionalWebService }
export type { RunningWebServer }
