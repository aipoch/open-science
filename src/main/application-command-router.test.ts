import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import { ApplicationCommandError } from '../shared/application-command-contract'
import { createCallerContext, type CallerContext } from './caller-context'
import {
  createApplicationCommandRouter,
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCallerLease,
  type ApplicationInvocation
} from './application-command-router'

const readValue = defineApplicationCommand<'sample.read', readonly [id: string], string>(
  'sample.read'
)
const writeValue = defineApplicationCommand<
  'sample.write',
  readonly [id: string, value: string],
  boolean
>('sample.write')
const sampleCommands = defineApplicationCommandGroup('sample', [readValue, writeValue] as const)

const caller = (overrides: Partial<CallerContext> = {}): CallerContext =>
  createCallerContext({
    clientId: 'web-client',
    lifecycleClientId: 'web:web-client',
    leaseId: 'lease-1',
    surface: 'web',
    location: 'remote',
    principalKind: 'automation',
    actionOrigin: 'automation',
    ...overrides
  })

const lease = (overrides: Partial<ApplicationCallerLease> = {}): ApplicationCallerLease =>
  Object.freeze({
    leaseId: 'lease-1',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true,
    ...overrides
  })

const invocation = <Args extends readonly unknown[]>(
  args: Args,
  options: Readonly<{
    callerContext?: CallerContext
    callerLease?: ApplicationCallerLease
  }> = {}
): ApplicationInvocation<Args> =>
  Object.freeze({
    callerContext: options.callerContext ?? caller(),
    callerLease: options.callerLease ?? lease(),
    args
  })

describe('application command router', () => {
  it('registers a typed group atomically and dispatches late registrations', async () => {
    const router = createApplicationCommandRouter()
    const scope = router.registrar.createScope()
    const read = vi.fn()
    const write = vi.fn()

    expect(router.dispatcher.commandNames()).toEqual([])
    scope.registerGroup(sampleCommands, {
      'sample.read': (invocation) => {
        expectTypeOf(invocation).toEqualTypeOf<ApplicationInvocation<readonly [id: string]>>()
        read(invocation)
        return `value:${invocation.args[0]}`
      },
      'sample.write': async (invocation) => {
        expectTypeOf(invocation.args).toEqualTypeOf<readonly [id: string, value: string]>()
        expectTypeOf(invocation.callerContext).toEqualTypeOf<CallerContext>()
        write(invocation)
        return true
      }
    })

    expect(router.dispatcher.commandNames()).toEqual(['sample.read', 'sample.write'])
    await expect(router.dispatcher.invoke(readValue, invocation(['one'] as const))).resolves.toBe(
      'value:one'
    )
    await expect(
      router.dispatcher.invoke(writeValue, invocation(['one', 'next'] as const))
    ).resolves.toBe(true)
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ args: ['one'] }))
  })

  it('exposes an immutable copy of a mutable command list', () => {
    const mutableCommands = [readValue]
    const group = defineApplicationCommandGroup('mutable-input', mutableCommands)
    type CommandsAreMutable = typeof group.commands extends unknown[] ? true : false

    expectTypeOf<CommandsAreMutable>().toEqualTypeOf<false>()
    mutableCommands.push(writeValue as never)
    expect(group.commands).toEqual([readValue])
    expect(Object.isFrozen(group.commands)).toBe(true)
  })

  it('preflights an entire group before rejecting a duplicate or missing handler', () => {
    const router = createApplicationCommandRouter()
    const first = router.registrar.createScope()
    first.registerGroup(defineApplicationCommandGroup('first', [readValue] as const), {
      'sample.read': vi.fn()
    })
    const second = router.registrar.createScope()

    expect(() =>
      second.registerGroup(sampleCommands, {
        'sample.read': vi.fn(),
        'sample.write': vi.fn()
      })
    ).toThrow('Application command is already registered: sample.read')
    expect(router.dispatcher.commandNames()).toEqual(['sample.read'])

    expect(() =>
      second.registerGroup(
        defineApplicationCommandGroup('missing', [writeValue] as const),
        {} as never
      )
    ).toThrow('Application command handler is missing: sample.write')
    expect(router.dispatcher.commandNames()).toEqual(['sample.read'])
  })

  it('rejects inherited handlers and retains the handler validated during preflight', async () => {
    const router = createApplicationCommandRouter()
    const inherited = router.registrar.createScope()
    const inheritedHandlers = Object.create({ 'sample.write': vi.fn() })

    expect(() =>
      inherited.registerGroup(
        defineApplicationCommandGroup('inherited', [writeValue] as const),
        inheritedHandlers
      )
    ).toThrow('Application command handler is missing: sample.write')

    const validatedHandler = vi.fn(() => 'value')
    const handlers: Record<string, unknown> = {}
    const readHandler = vi.fn(() => validatedHandler)
    Object.defineProperty(handlers, 'sample.read', { enumerable: true, get: readHandler })
    const registered = router.registrar.createScope()
    registered.registerGroup(
      defineApplicationCommandGroup('validated', [readValue] as const),
      handlers as never
    )

    await expect(router.dispatcher.invoke(readValue, invocation(['one'] as const))).resolves.toBe(
      'value'
    )
    expect(readHandler).toHaveBeenCalledOnce()
    expect(validatedHandler).toHaveBeenCalledOnce()
  })

  it('keeps scopes isolated across rollback, uninstall, and concurrent late registration', () => {
    const router = createApplicationCommandRouter()
    const first = router.registrar.createScope()
    first.registerGroup(defineApplicationCommandGroup('first', [readValue] as const), {
      'sample.read': vi.fn()
    })
    const firstInstallation = first.complete()
    const second = router.registrar.createScope()
    second.registerGroup(defineApplicationCommandGroup('second', [writeValue] as const), {
      'sample.write': vi.fn()
    })

    firstInstallation.uninstall()
    firstInstallation.uninstall()
    expect(router.dispatcher.commandNames()).toEqual(['sample.write'])

    second.rollback()
    second.rollback()
    expect(router.dispatcher.commandNames()).toEqual([])
  })

  it('rejects unknown commands before consulting caller freshness', async () => {
    const isAuthorizationCurrent = vi.fn(() => false)
    const router = createApplicationCommandRouter()

    await expect(
      router.dispatcher.invoke(
        readValue,
        invocation(['one'] as const, { callerContext: caller({ isAuthorizationCurrent }) })
      )
    ).rejects.toThrow('Unknown application command: sample.read')
    expect(isAuthorizationCurrent).not.toHaveBeenCalled()

    const scope = router.registrar.createScope()
    scope.registerGroup(defineApplicationCommandGroup('read', [readValue] as const), {
      'sample.read': vi.fn()
    })
    const forgedRead = defineApplicationCommand<'sample.read', readonly [number], number>(
      'sample.read'
    )
    await expect(router.dispatcher.invoke(forgedRead, invocation([1] as const))).rejects.toThrow(
      'Unknown application command: sample.read'
    )
  })

  it('fails closed for stale authorization, mismatched leases, and stale generations', async () => {
    const handler = vi.fn(() => 'value')
    const router = createApplicationCommandRouter()
    const scope = router.registrar.createScope()
    scope.registerGroup(defineApplicationCommandGroup('read', [readValue] as const), {
      'sample.read': handler
    })

    await expect(
      router.dispatcher.invoke(
        readValue,
        invocation(['one'] as const, {
          callerContext: caller({ isAuthorizationCurrent: () => false })
        })
      )
    ).rejects.toThrow('Caller authorization is no longer current.')
    await expect(
      router.dispatcher.invoke(
        readValue,
        invocation(['one'] as const, { callerLease: lease({ leaseId: 'other' }) })
      )
    ).rejects.toThrow('Caller lease does not match caller context.')
    await expect(
      router.dispatcher.invoke(
        readValue,
        invocation(['one'] as const, { callerLease: lease({ isCurrent: () => false }) })
      )
    ).rejects.toThrow('Caller lease is no longer current.')
    const releasedLease = new AbortController()
    releasedLease.abort()
    await expect(
      router.dispatcher.invoke(
        readValue,
        invocation(['one'] as const, { callerLease: lease({ signal: releasedLease.signal }) })
      )
    ).rejects.toThrow('Caller lease is no longer current.')
    expect(handler).not.toHaveBeenCalled()
  })

  it('lets in-flight work observe lease release and finish after uninstall', async () => {
    let resolve!: (value: string) => void
    const pending = new Promise<string>((complete) => (resolve = complete))
    const release = new AbortController()
    const onRelease = vi.fn()
    const router = createApplicationCommandRouter()
    const scope = router.registrar.createScope()
    scope.registerGroup(defineApplicationCommandGroup('read', [readValue] as const), {
      'sample.read': ({ callerLease }) => {
        callerLease.signal.addEventListener('abort', onRelease, { once: true })
        return pending
      }
    })
    const installation = scope.complete()

    const result = router.dispatcher.invoke(
      readValue,
      invocation(['one'] as const, { callerLease: lease({ signal: release.signal }) })
    )
    installation.uninstall()
    release.abort()
    release.abort()
    resolve('complete')

    await expect(result).resolves.toBe('complete')
    expect(onRelease).toHaveBeenCalledOnce()
    await expect(router.dispatcher.invoke(readValue, invocation(['two'] as const))).rejects.toThrow(
      'Unknown application command: sample.read'
    )
  })

  it('keeps a replacement lease generation independent from a released signal', async () => {
    const handler = vi.fn(() => 'value')
    const previous = new AbortController()
    const replacement = new AbortController()
    const router = createApplicationCommandRouter()
    const scope = router.registrar.createScope()
    scope.registerGroup(defineApplicationCommandGroup('read', [readValue] as const), {
      'sample.read': handler
    })

    await expect(
      router.dispatcher.invoke(
        readValue,
        invocation(['one'] as const, {
          callerLease: lease({ generation: 1, signal: previous.signal })
        })
      )
    ).resolves.toBe('value')
    previous.abort()
    await expect(
      router.dispatcher.invoke(
        readValue,
        invocation(['two'] as const, {
          callerLease: lease({ generation: 2, signal: replacement.signal })
        })
      )
    ).resolves.toBe('value')
    expect(replacement.signal.aborted).toBe(false)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('disposes scopes in reverse order and aggregates cleanup failures', () => {
    const order: string[] = []
    const router = createApplicationCommandRouter()
    const first = router.registrar.createScope()
    first.registerGroup(defineApplicationCommandGroup('first', [readValue] as const), {
      'sample.read': vi.fn()
    })
    first.complete(() => {
      order.push('first')
      throw new Error('first cleanup')
    })
    const second = router.registrar.createScope()
    second.registerGroup(defineApplicationCommandGroup('second', [writeValue] as const), {
      'sample.write': vi.fn()
    })
    second.complete(() => {
      order.push('second')
      throw new Error('second cleanup')
    })

    expect(() => router.dispose()).toThrow(
      new AggregateError(
        [expect.anything(), expect.anything()],
        'Application command cleanup failed.'
      )
    )
    expect(order).toEqual(['second', 'first'])
    expect(() => router.dispose()).not.toThrow()
    expect(() => router.registrar.createScope()).toThrow('Application command router is disposed.')
  })

  it('rejects settling a pre-created scope after router disposal', () => {
    const cleanup = vi.fn()
    const router = createApplicationCommandRouter()
    const scope = router.registrar.createScope()

    router.dispose()

    expect(() => scope.complete(cleanup)).toThrow('Application command router is disposed.')
    expect(() => scope.rollback()).toThrow('Application command router is disposed.')
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('reports privacy-safe rejection diagnostics without allowing diagnostics to mask errors', async () => {
    const diagnostics: unknown[] = []
    const onDiagnostic = vi.fn((diagnostic) => {
      diagnostics.push(diagnostic)
      throw new Error('diagnostic failed')
    })
    const privateError = new Error('private handler detail')
    const router = createApplicationCommandRouter(onDiagnostic)
    const scope = router.registrar.createScope()
    scope.registerGroup(defineApplicationCommandGroup('read', [readValue] as const), {
      'sample.read': () => Promise.reject(privateError)
    })

    await expect(router.dispatcher.invoke(readValue, invocation(['secret'] as const))).rejects.toBe(
      privateError
    )
    expect(diagnostics).toEqual([{ code: 'handler-rejected', commandName: 'sample.read' }])
    expect(JSON.stringify(diagnostics)).not.toContain('secret')
    expect(JSON.stringify(diagnostics)).not.toContain('web-client')
    expect(JSON.stringify(diagnostics)).not.toContain('lease-1')
    expect(JSON.stringify(diagnostics)).not.toContain('private handler detail')
  })

  it('validates contracted arguments and results at the command interface', async () => {
    const args = ['project-1'] as const
    const result = { id: 'project-1' }
    const argsCodec = { parse: vi.fn((value: unknown) => value as typeof args) }
    const resultCodec = { parse: vi.fn((value: unknown) => value as typeof result) }
    const command = defineApplicationCommand<'projects:get', readonly [id: string], typeof result>(
      'projects:get',
      { args: argsCodec, result: resultCodec }
    )
    const handler = vi.fn(() => result)
    const router = createApplicationCommandRouter()
    const scope = router.registrar.createScope()
    scope.registerGroup(defineApplicationCommandGroup('projects', [command] as const), {
      'projects:get': handler
    })

    await expect(router.dispatcher.invoke(command, invocation(args))).resolves.toBe(result)
    expect(argsCodec.parse).toHaveBeenCalledWith(args)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ args }))
    expect(resultCodec.parse).toHaveBeenCalledWith(result)
    expect(Object.isFrozen(command.contract)).toBe(true)
  })

  it.each([
    {
      failure: 'arguments',
      expectedCode: 'invalid-command-arguments',
      argsCodec: {
        parse: (): readonly [string] => {
          throw new Error('private argument detail')
        }
      },
      resultCodec: { parse: (value: unknown) => value as string }
    },
    {
      failure: 'result',
      expectedCode: 'invalid-command-result',
      argsCodec: { parse: (value: unknown) => value as readonly [string] },
      resultCodec: {
        parse: (): string => {
          throw new Error('private result detail')
        }
      }
    }
  ] as const)(
    'rejects invalid contracted $failure without leaking codec details',
    async ({ expectedCode, argsCodec, resultCodec }) => {
      const diagnostics: unknown[] = []
      const handler = vi.fn(() => 'value')
      const command = defineApplicationCommand<'projects:get', readonly [string], string>(
        'projects:get',
        { args: argsCodec, result: resultCodec }
      )
      const router = createApplicationCommandRouter((diagnostic) => diagnostics.push(diagnostic))
      const scope = router.registrar.createScope()
      scope.registerGroup(defineApplicationCommandGroup('projects', [command] as const), {
        'projects:get': handler
      })

      const dispatched = router.dispatcher.invoke(command, invocation(['project-1'] as const))

      const error = await dispatched.catch((error) => error)
      expect(error).toBeInstanceOf(ApplicationCommandError)
      expect(error).toMatchObject({ code: expectedCode })
      expect(JSON.stringify(error)).not.toContain('private')
      expect(diagnostics).toEqual([{ code: expectedCode, commandName: 'projects:get' }])
      expect(handler).toHaveBeenCalledTimes(expectedCode === 'invalid-command-result' ? 1 : 0)
    }
  )
})
