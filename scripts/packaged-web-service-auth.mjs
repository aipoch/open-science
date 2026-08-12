/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const STATE_FILE = 'web-service.json'
const TOKEN_FILE = 'web-token'
const READY_URL_PATTERN =
  /Open Science Web:\s+(http:\/\/127\.0\.0\.1:\d+\/(?:\?token=[A-Za-z0-9_-]+)?)/

const parsePackagedAppEndpoint = (output) => {
  const match = output.match(READY_URL_PATTERN)
  if (!match) return undefined
  const url = new URL(match[1])
  const token = url.searchParams.get('token')
  return {
    endpoint: url.origin,
    ...(token ? { auth: `token=${encodeURIComponent(token)}` } : {})
  }
}

const authenticatePackagedAppEndpoint = async (
  output,
  configRoots = [],
  { readText = readFile, joinPath = join } = {}
) => {
  const service = parsePackagedAppEndpoint(output)
  if (!service || service.auth) return service

  const port = Number(new URL(service.endpoint).port)
  const roots = [...new Set(configRoots.filter((root) => typeof root === 'string' && root))]

  for (const root of roots) {
    try {
      const state = JSON.parse(await readText(joinPath(root, STATE_FILE), 'utf8'))
      if (state.port !== port) continue
      const token = (await readText(joinPath(root, TOKEN_FILE), 'utf8')).trim()
      if (token.length < 32) continue
      return {
        ...service,
        auth: `token=${encodeURIComponent(token)}`
      }
    } catch {
      // State and token files are published independently; retry while the service is starting.
    }
  }

  return undefined
}

export { authenticatePackagedAppEndpoint, parsePackagedAppEndpoint }
