import type { IncomingMessage } from 'node:http'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import {
  ResourceBudgetExceededError,
  assertWithinResourceBudget,
  readBoundedJsonBody
} from './resource-budget'

describe('resource budget', () => {
  it('allows the exact limit and rejects the first byte above it', () => {
    expect(() => assertWithinResourceBudget('file', 4, 4)).not.toThrow()
    expect(() => assertWithinResourceBudget('file', 5, 4)).toThrow(ResourceBudgetExceededError)
  })

  it('rejects a declared request before reading its body', async () => {
    const request = Readable.from(['{}']) as IncomingMessage
    request.headers = { 'content-length': '3' }

    await expect(readBoundedJsonBody(request, 2)).rejects.toThrow(ResourceBudgetExceededError)
  })

  it('rejects a chunked request on the first byte above the limit', async () => {
    const request = {
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from([0x7b, 0x22, 0x61, 0x22])
        yield Buffer.from(':1}')
      }
    } as unknown as IncomingMessage

    await expect(readBoundedJsonBody(request, 6)).rejects.toMatchObject({
      dimension: 'request',
      observedBytes: 7,
      limitBytes: 6
    })
  })

  it('returns the configured value for an empty body', async () => {
    const request = Readable.from([]) as IncomingMessage
    request.headers = {}

    await expect(
      readBoundedJsonBody<undefined>(request, 1, { emptyValue: undefined })
    ).resolves.toBeUndefined()
  })

  it('wires the shared request limit into both normal stdio MCP entry points', async () => {
    for (const path of [
      'src/main/artifacts/mcp-server.ts',
      'src/main/notebook/mcp-server.ts',
      'src/main/reviewer/mcp-stdio-proxy.ts',
      'src/main/session-plan/plan-mcp-server.ts',
      'src/main/skills/mcp-server.ts'
    ]) {
      const source = await readFile(path, 'utf8')
      expect(source, path).toContain('maxBufferSize: LOCAL_RESOURCE_BUDGETS.requestBytes')
    }
  })
})
