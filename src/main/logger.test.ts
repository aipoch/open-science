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

  it('stringifies bigint / function / symbol values that JSON.stringify cannot represent', () => {
    const fields = errorLogFields(
      Object.assign(new Error('boom'), {
        data: {
          big: 10n,
          fn: function handler() {
            return 1
          },
          sym: Symbol('s')
        }
      })
    ) as { data: { big: string; fn: string; sym: string } }

    expect(fields.data.big).toBe('10n')
    expect(fields.data.fn).toBe('[function handler]')
    expect(fields.data.sym).toBe('Symbol(s)')
    expect(() => JSON.parse(formatLine('error', 'x', 'y', fields))).not.toThrow()
  })

  it('serializes a valid Date to ISO and never throws on an invalid Date', () => {
    const valid = errorLogFields(Object.assign(new Error('e'), { data: new Date(0) })) as {
      data: string
    }
    expect(valid.data).toBe('1970-01-01T00:00:00.000Z')

    const invalid = errorLogFields(
      Object.assign(new Error('e'), { data: new Date('not-a-date') })
    ) as { data: string }
    expect(invalid.data).toBe('[invalid date]')
  })

  it('degrades a throwing getter to a marker while keeping sibling fields', () => {
    const data = { ok: 'kept' }
    Object.defineProperty(data, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter blew up')
      }
    })
    const fields = errorLogFields(Object.assign(new Error('e'), { data })) as {
      data: { ok: string; boom: string }
    }

    expect(fields.data.ok).toBe('kept')
    expect(fields.data.boom).toBe('[unreadable]')
    expect(() => JSON.parse(formatLine('error', 'x', 'y', fields))).not.toThrow()
  })

  it('never throws on a Proxy whose ownKeys/get traps throw', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys trap')
        },
        get() {
          throw new Error('get trap')
        }
      }
    )

    // Directly thrown hostile object, and nested inside a normal error's data — neither may throw.
    expect(() => errorLogFields(hostile)).not.toThrow()
    const nested = errorLogFields(Object.assign(new Error('e'), { data: hostile }))
    expect(() => JSON.parse(formatLine('error', 'x', 'y', nested))).not.toThrow()
  })

  it('bounds recursion depth on a deeply nested (non-cyclic) structure', () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 50; i += 1) deep = { next: deep }

    const fields = errorLogFields(Object.assign(new Error('e'), { data: deep }))
    const line = formatLine('error', 'x', 'y', fields)
    expect(() => JSON.parse(line)).not.toThrow()
    // The depth marker appears somewhere in the truncated chain rather than the whole thing being dropped.
    expect(line).toContain('[max depth]')
  })

  it('degrades a throwing message getter to a field marker while keeping the other Error fields', () => {
    // An Error whose message accessor throws must NOT send the whole record to the outer fallback: the
    // still-readable code/data survive, only the message degrades.
    const hostile = new Error() as Error & { code?: string }
    hostile.code = 'EHOSTILE'
    ;(hostile as unknown as { data?: unknown }).data = { detail: 'kept' }
    Object.defineProperty(hostile, 'message', {
      configurable: true,
      get() {
        throw new Error('message trap')
      }
    })

    const fields = errorLogFields(hostile) as {
      error: string
      code: string
      data: { detail: string }
      serializationFailed?: boolean
    }
    expect(fields.serializationFailed).toBeUndefined()
    // A read that *throws* is surfaced as the marker (distinct from a genuinely empty/absent message).
    expect(fields.error).toBe('[unreadable]')
    expect(fields.code).toBe('EHOSTILE')
    expect(fields.data).toEqual({ detail: 'kept' })
    expect(() => JSON.parse(formatLine('error', 'x', 'y', fields))).not.toThrow()
  })

  it('distinguishes a genuinely absent message ("") from an unreadable one ("[unreadable]")', () => {
    // Absent message: empty string, not the marker.
    const noMessage = new Error()
    Object.defineProperty(noMessage, 'message', { value: undefined, configurable: true })
    expect((errorLogFields(noMessage) as { error: string }).error).toBe('')
  })

  it('degrades a throwing detail (data) getter to the marker while keeping other fields', () => {
    const err = new Error('outer') as Error & { code?: string }
    err.code = 'EKEEP'
    Object.defineProperty(err, 'data', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('data trap')
      }
    })

    const fields = errorLogFields(err) as { error: string; code: string; data: string }
    // The whole Error must not collapse to the outer fallback: message + code survive, only data degrades.
    expect(fields.error).toBe('outer')
    expect(fields.code).toBe('EKEEP')
    expect(fields.data).toBe('[unreadable]')
    expect(() => JSON.parse(formatLine('error', 'x', 'y', fields))).not.toThrow()
  })

  it('degrades a hostile nested value without dropping its readable siblings', () => {
    // data.bad is a Proxy whose getPrototypeOf trap throws (so sanitizing it throws internally); data.ok
    // must still survive as a normal field.
    const bad = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('nested proto trap')
        }
      }
    )
    const err = Object.assign(new Error('e'), { data: { ok: 'survives', bad } })

    const fields = errorLogFields(err) as { data: { ok: string; bad: string } }
    expect(fields.data.ok).toBe('survives')
    expect(fields.data.bad).toBe('[unreadable]')
    expect(() => JSON.parse(formatLine('error', 'x', 'y', fields))).not.toThrow()
  })

  it('hits the outer fallback (serializationFailed) when even type inspection throws', () => {
    // A Proxy whose getPrototypeOf trap throws makes `value instanceof Error` throw — the very first
    // thing errorLogFields does — so only the outermost guard can catch it.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('proto trap')
        }
      }
    )

    const fields = errorLogFields(hostile) as { error: string; serializationFailed?: boolean }
    expect(fields.serializationFailed).toBe(true)
    expect(typeof fields.error).toBe('string')
    expect(() => JSON.parse(formatLine('error', 'x', 'y', fields))).not.toThrow()
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
