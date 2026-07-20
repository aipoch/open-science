import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createLogger, errorLogFields, flushLogs, formatLine, initLogger } from './logger'

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

describe('logger: errorLogFields', () => {
  it('expands an Error into message + stack', () => {
    const fields = errorLogFields(new Error('boom'))

    expect(fields.error).toBe('boom')
    expect(typeof fields.stack).toBe('string')
  })

  it('keeps JSON-RPC RequestError code + data (the real provider/agent reason)', () => {
    // Shape of the ACP RequestError the renderer saw as a bare "Internal error".
    const requestError = Object.assign(new Error('Internal error'), {
      name: 'RequestError',
      code: -32603,
      data: { details: 'agent exited with code 1' }
    })

    const fields = errorLogFields(requestError)

    expect(fields.error).toBe('Internal error')
    expect(fields.name).toBe('RequestError')
    expect(fields.code).toBe(-32603)
    expect(fields.data).toEqual({ details: 'agent exited with code 1' })
  })

  it('keeps Node system-error fields (errno/syscall/path)', () => {
    const spawnError = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'spawn claude',
      path: 'claude'
    })

    const fields = errorLogFields(spawnError)

    expect(fields.code).toBe('ENOENT')
    expect(fields.errno).toBe(-2)
    expect(fields.syscall).toBe('spawn claude')
    expect(fields.path).toBe('claude')
  })

  it('follows a nested cause (bounded), not collapsing it to {}', () => {
    const cause = new Error('underlying socket hang up')
    const wrapper = Object.assign(new Error('request failed'), { cause })

    const fields = errorLogFields(wrapper) as { cause: { error: string } }

    expect(fields.cause.error).toBe('underlying socket hang up')
  })

  it('breaks a self-referential cause so the record still serializes (not [unserializable])', () => {
    const selfReferential = new Error('loop') as Error & { cause?: unknown }
    selfReferential.cause = selfReferential

    const fields = errorLogFields(selfReferential)
    expect(fields.cause).toBe('[circular]')

    // The whole point: the final log line must survive JSON.stringify with the error + context intact,
    // rather than collapsing to the circular fallback and dropping everything.
    const parsed = JSON.parse(
      formatLine('error', 'acp', 'failed', { ...fields, framework: 'claude-code' })
    ) as { data: { error: string; cause: string; framework: string } }
    expect(parsed.data.error).toBe('loop')
    expect(parsed.data.cause).toBe('[circular]')
    expect(parsed.data.framework).toBe('claude-code')
  })

  it('breaks a mutually-referential cause cycle (a → b → a)', () => {
    const a = new Error('a') as Error & { cause?: unknown }
    const b = new Error('b') as Error & { cause?: unknown }
    a.cause = b
    b.cause = a

    const fields = errorLogFields(a) as { cause: { error: string; cause: string } }
    expect(fields.cause.error).toBe('b')
    expect(fields.cause.cause).toBe('[circular]')
    expect(() => JSON.parse(formatLine('error', 'x', 'y', fields))).not.toThrow()
  })

  it('breaks a cycle in a non-Error (plain object) cause', () => {
    const cyclic: Record<string, unknown> = { detail: 'provider blew up' }
    cyclic.self = cyclic
    const wrapper = Object.assign(new Error('request failed'), { cause: cyclic })

    const fields = errorLogFields(wrapper) as { cause: { detail: string; self: string } }
    expect(fields.cause.detail).toBe('provider blew up')
    expect(fields.cause.self).toBe('[circular]')
    expect(() => JSON.parse(formatLine('error', 'x', 'y', { ...fields, ctx: 1 }))).not.toThrow()
  })

  it('unwraps an Error nested inside a non-Error cause instead of dropping it to {}', () => {
    const inner = new Error('inner boom')
    const wrapper = Object.assign(new Error('outer'), { cause: { nested: inner } })

    const fields = errorLogFields(wrapper) as {
      cause: { nested: { error: string; stack?: string } }
    }
    expect(fields.cause.nested.error).toBe('inner boom')
    expect(typeof fields.cause.nested.stack).toBe('string')
  })

  it('breaks a cycle inside RequestError.data so the whole record still serializes', () => {
    const data: Record<string, unknown> = { details: 'rate limited' }
    data.loop = data
    const requestError = Object.assign(new Error('Internal error'), { code: -32603, data })

    const fields = errorLogFields(requestError) as {
      data: { details: string; loop: string }
    }
    expect(fields.data.details).toBe('rate limited')
    expect(fields.data.loop).toBe('[circular]')

    const parsed = JSON.parse(
      formatLine('error', 'acp', 'failed', { ...fields, framework: 'opencode' })
    ) as { data: { error: string; framework: string } }
    expect(parsed.data.error).toBe('Internal error')
    expect(parsed.data.framework).toBe('opencode')
  })

  it('breaks a cycle in a directly-thrown plain object', () => {
    const thrown: Record<string, unknown> = { message: 'weird throw', code: 7 }
    thrown.self = thrown

    const fields = errorLogFields(thrown) as { error: string; code: number; self: string }
    expect(fields.error).toBe('weird throw')
    expect(fields.code).toBe(7)
    expect(fields.self).toBe('[circular]')
    expect(() => JSON.parse(formatLine('warn', 'x', 'y', fields))).not.toThrow()
  })

  it('keeps sibling (non-cyclic) shared references, flagging only true back-references', () => {
    const shared = { id: 1 }
    const thrown = { a: shared, b: shared }

    const fields = errorLogFields(thrown) as { a: { id: number }; b: { id: number } }
    // A diamond is not a cycle: both positions keep the value.
    expect(fields.a).toEqual({ id: 1 })
    expect(fields.b).toEqual({ id: 1 })
  })

  it('keeps a thrown plain object’s own fields instead of "[object Object]"', () => {
    const fields = errorLogFields({ code: -32603, message: 'Internal error', data: { x: 1 } })

    expect(fields.error).toBe('Internal error')
    expect(fields.code).toBe(-32603)
    expect(fields.data).toEqual({ x: 1 })
  })

  it('stringifies primitive throws', () => {
    expect(errorLogFields('plain string').error).toBe('plain string')
    expect(errorLogFields(42).error).toBe('42')
  })

  it('survives the file logger nested in a context object (the {} regression it guards)', () => {
    // A raw Error nested in a context object serializes to {} — its fields are non-enumerable.
    const raw = JSON.parse(
      formatLine('error', 'acp', 'failed', { error: new Error('x'), framework: 'claude-code' })
    ) as { data: { error: unknown } }
    expect(raw.data.error).toEqual({})

    // Spreading errorLogFields keeps message + stack + context visible.
    const fixed = JSON.parse(
      formatLine('error', 'acp', 'failed', {
        ...errorLogFields(new Error('x')),
        framework: 'claude-code'
      })
    ) as { data: { error: string; stack?: string; framework: string } }

    expect(fixed.data.error).toBe('x')
    expect(typeof fixed.data.stack).toBe('string')
    expect(fixed.data.framework).toBe('claude-code')
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
