/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { candidateConfigRoots, readWebToken } from './config-root.mjs'

// Discovery records are hints. A live authenticated response from the same generation is authority.
export async function requestExistingRuntimeWeb(options, fetch = globalThis.fetch) {
  for (const configRoot of candidateConfigRoots({ override: options.configRoot })) {
    let record
    try {
      record = JSON.parse(await readFile(join(configRoot, 'runtime-owner.json'), 'utf8'))
    } catch {
      continue
    }
    if (
      record.schemaVersion !== 1 ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 1 ||
      !Number.isSafeInteger(record.port) ||
      record.port < 1 ||
      record.port > 65535 ||
      !['node', 'electron'].includes(record.host) ||
      typeof record.generation !== 'string'
    )
      continue
    let response
    try {
      response = await fetch(
        `http://127.0.0.1:${record.port}${options.credentialStore !== undefined ? '/owner' : `/web/start?port=${options.port ?? 44100}`}`,
        {
          method: options.credentialStore !== undefined ? 'GET' : 'POST',
          headers: {
            authorization: `Bearer ${await readWebToken(configRoot)}`,
            'x-open-science-runtime-generation': record.generation
          },
          signal: AbortSignal.timeout(30_000)
        }
      )
      if (!response.ok) continue
      const result = await response.json()
      if (result.generation !== record.generation || result.pid !== record.pid) continue
    } catch {
      continue
    }
    if (options.credentialStore !== undefined)
      throw new Error(
        'Open-Science is already running. Stop it before selecting a credential store.'
      )
    return configRoot
  }
}
