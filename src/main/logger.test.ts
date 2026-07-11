import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createLogger, flushLogs, formatLine, initLogger } from './logger'

let logDir: string | undefined

afterEach(async () => {
  if (logDir) {
    await rm(logDir, { recursive: true, force: true })
    logDir = undefined
  }
})

describe('logger: formatLine', () => {
  it('produces a single-line JSON record with level, scope, and message', () => {
    const line = formatLine('info', 'acp', 'connected')
    const parsed = JSON.parse(line) as Record<string, unknown>

    expect(line).not.toContain('\n')
    expect(parsed.level).toBe('info')
    expect(parsed.scope).toBe('acp')
    expect(parsed.msg).toBe('connected')
    expect(typeof parsed.t).toBe('string')
  })

  it('attaches structured data', () => {
    const parsed = JSON.parse(formatLine('debug', 'agent', 'spawn', { pid: 42 })) as {
      data: { pid: number }
    }

    expect(parsed.data.pid).toBe(42)
  })

  it('unwraps Error payloads so the stack is preserved', () => {
    const parsed = JSON.parse(formatLine('error', 'agent', 'failed', new Error('boom'))) as {
      data: { name: string; message: string; stack?: string }
    }

    expect(parsed.data.name).toBe('Error')
    expect(parsed.data.message).toBe('boom')
    expect(typeof parsed.data.stack).toBe('string')
  })

  it('does not throw on circular data', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    const line = formatLine('warn', 'x', 'circular', circular)

    expect(() => JSON.parse(line)).not.toThrow()
    expect((JSON.parse(line) as { data: unknown }).data).toBe('[unserializable]')
  })
})

describe('logger: rotation (auto-cleanup)', () => {
  it('caps total files, rotating oldest out so logs never grow unbounded', async () => {
    logDir = await mkdtemp(join(tmpdir(), 'os-logger-'))

    // Tiny cap so a handful of lines forces several rotations; keep the live file + 2 backups.
    initLogger({ logDir, fileName: 'main.log', maxBytes: 120, maxFiles: 3, mirrorToConsole: false })
    const log = createLogger('test')

    for (let i = 0; i < 50; i += 1) {
      log.info('a reasonably long message to exceed the tiny cap quickly', { i })
    }
    await flushLogs()

    const files = (await readdir(logDir)).filter((name) => name.startsWith('main')).sort()

    // Never more than maxFiles total, and the 3rd backup was dropped rather than kept forever.
    expect(files).toEqual(['main.1.log', 'main.2.log', 'main.log'])
    expect(files).not.toContain('main.3.log')
  })

  it('keeps the live file when maxFiles is 1 (drop-and-restart)', async () => {
    logDir = await mkdtemp(join(tmpdir(), 'os-logger-'))

    initLogger({ logDir, fileName: 'main.log', maxBytes: 120, maxFiles: 1, mirrorToConsole: false })
    const log = createLogger('test')

    for (let i = 0; i < 30; i += 1) {
      log.info('message that overflows the single-file cap', { i })
    }
    await flushLogs()

    const files = (await readdir(logDir)).filter((name) => name.startsWith('main'))

    expect(files).toEqual(['main.log'])
  })
})
