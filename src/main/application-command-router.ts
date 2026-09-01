import {
  ApplicationCommandError,
  type ApplicationCommandContract
} from '../shared/application-command-contract'
import type { CallerContext } from './caller-context'

declare const applicationCommandTypes: unique symbol

type Awaitable<Value> = Value | PromiseLike<Value>

type AnyApplicationCommand = Readonly<{
  name: string
  contract?: ApplicationCommandContract<readonly unknown[], unknown>
}>

export type ApplicationCommand<
  Name extends string,
  Args extends readonly unknown[],
  Result
> = Readonly<{
  name: Name
  contract?: ApplicationCommandContract<Args, Result>
  [applicationCommandTypes]?: Readonly<{ args: Args; result: Result }>
}>

type CommandArgs<Command> =
  Command extends ApplicationCommand<string, infer Args, unknown> ? Args : never

type CommandResult<Command> =
  Command extends ApplicationCommand<string, readonly unknown[], infer Result> ? Result : never

export type ApplicationCallerLease = Readonly<{
  leaseId: string
  generation: number
  signal: AbortSignal
  isCurrent: () => boolean
}>

export type ApplicationInvocation<Args extends readonly unknown[]> = Readonly<{
  callerContext: CallerContext
  callerLease: ApplicationCallerLease
  args: Args
}>

export type ApplicationCommandHandler<Args extends readonly unknown[], Result> = (
  invocation: ApplicationInvocation<Args>
) => Awaitable<Result>

export type ApplicationCommandGroup<
  Name extends string,
  Commands extends readonly AnyApplicationCommand[]
> = Readonly<{
  name: Name
  commands: Readonly<Commands>
}>

export type ApplicationCommandHandlers<Commands extends readonly AnyApplicationCommand[]> = {
  readonly [Name in Commands[number]['name']]: Extract<
    Commands[number],
    Readonly<{ name: Name }>
  > extends ApplicationCommand<string, infer Args, infer Result>
    ? ApplicationCommandHandler<Args, Result>
    : never
}

export type ApplicationCommandInstallation = Readonly<{
  uninstall: () => void
}>

export type ApplicationCommandRegistrationScope = Readonly<{
  registerGroup: <Group extends ApplicationCommandGroup<string, readonly AnyApplicationCommand[]>>(
    group: Group,
    handlers: ApplicationCommandHandlers<Group['commands']>
  ) => void
  complete: (cleanup?: () => void) => ApplicationCommandInstallation
  rollback: () => void
}>

export type ApplicationCommandRegistrar = Readonly<{
  createScope: () => ApplicationCommandRegistrationScope
}>

export type ApplicationCommandDispatcher = Readonly<{
  invoke: <Command extends AnyApplicationCommand>(
    command: Command,
    invocation: ApplicationInvocation<CommandArgs<Command>>
  ) => Promise<CommandResult<Command>>
  commandNames: () => readonly string[]
}>

export type ApplicationCommandDiagnosticCode =
  | 'unknown-command'
  | 'authorization-stale'
  | 'lease-mismatch'
  | 'lease-stale'
  | 'invalid-command-arguments'
  | 'invalid-command-result'
  | 'handler-rejected'
  | 'router-disposed'

export type ApplicationCommandDiagnostic = Readonly<{
  code: ApplicationCommandDiagnosticCode
  commandName: string
}>

export type ApplicationCommandRouter = Readonly<{
  registrar: ApplicationCommandRegistrar
  dispatcher: ApplicationCommandDispatcher
  dispose: () => void
}>

type RegisteredHandler = (
  invocation: ApplicationInvocation<readonly unknown[]>
) => Awaitable<unknown>

type RegisteredCommand = Readonly<{
  command: AnyApplicationCommand
  registrationToken: symbol
  handler: RegisteredHandler
}>

type ScopeState = {
  registrations: Array<Readonly<{ commandName: string; registrationToken: symbol }>>
  settled: boolean
  active: boolean
  cleanup?: () => void
  cleanupCalled: boolean
}

export const defineApplicationCommand = <
  const Name extends string,
  Args extends readonly unknown[],
  Result
>(
  name: Name,
  contract?: ApplicationCommandContract<Args, Result>
): ApplicationCommand<Name, Args, Result> =>
  Object.freeze(
    contract ? { name, contract: Object.freeze({ ...contract }) } : { name }
  ) as ApplicationCommand<Name, Args, Result>

export const defineApplicationCommandGroup = <
  const Name extends string,
  const Commands extends readonly AnyApplicationCommand[]
>(
  name: Name,
  commands: Commands
): ApplicationCommandGroup<Name, Commands> =>
  Object.freeze({ name, commands: Object.freeze([...commands]) as unknown as Readonly<Commands> })

export const createApplicationCommandRouter = (
  onDiagnostic?: (diagnostic: ApplicationCommandDiagnostic) => void
): ApplicationCommandRouter => {
  const commands = new Map<string, RegisteredCommand>()
  const scopes: ScopeState[] = []
  let disposed = false

  const report = (code: ApplicationCommandDiagnosticCode, commandName: string): void => {
    try {
      onDiagnostic?.(Object.freeze({ code, commandName }))
    } catch {
      // Diagnostics must never mask or replace the command result.
    }
  }

  const removeScope = (state: ScopeState, runCleanup: boolean): void => {
    if (!state.active) return
    state.active = false
    for (const registration of [...state.registrations].reverse()) {
      const current = commands.get(registration.commandName)
      if (current?.registrationToken === registration.registrationToken) {
        commands.delete(registration.commandName)
      }
    }
    if (!runCleanup || state.cleanupCalled || !state.cleanup) return
    state.cleanupCalled = true
    state.cleanup()
  }

  const createScope = (): ApplicationCommandRegistrationScope => {
    if (disposed) throw new Error('Application command router is disposed.')
    const state: ScopeState = {
      registrations: [],
      settled: false,
      active: true,
      cleanupCalled: false
    }
    scopes.push(state)

    return Object.freeze({
      registerGroup: (group, handlers): void => {
        if (disposed) throw new Error('Application command router is disposed.')
        if (state.settled) throw new Error('Application command registration scope is settled.')

        const registrations: Array<
          Readonly<{ command: AnyApplicationCommand; handler: RegisteredHandler }>
        > = []
        const groupNames = new Set<string>()
        const runtimeHandlers = handlers as unknown as Readonly<Record<string, RegisteredHandler>>
        for (const command of group.commands) {
          if (groupNames.has(command.name) || commands.has(command.name)) {
            throw new Error(`Application command is already registered: ${command.name}`)
          }
          if (!Object.hasOwn(runtimeHandlers, command.name)) {
            throw new Error(`Application command handler is missing: ${command.name}`)
          }
          const handler = runtimeHandlers[command.name]
          if (typeof handler !== 'function') {
            throw new Error(`Application command handler is missing: ${command.name}`)
          }
          groupNames.add(command.name)
          registrations.push({ command, handler })
        }

        for (const { command, handler } of registrations) {
          const registrationToken = Symbol(`${group.name}:${command.name}`)
          commands.set(command.name, {
            command,
            registrationToken,
            handler
          })
          state.registrations.push({ commandName: command.name, registrationToken })
        }
      },
      complete: (cleanup): ApplicationCommandInstallation => {
        if (disposed) throw new Error('Application command router is disposed.')
        if (state.settled) throw new Error('Application command registration scope is settled.')
        state.settled = true
        state.cleanup = cleanup
        return Object.freeze({ uninstall: () => removeScope(state, true) })
      },
      rollback: (): void => {
        if (disposed) throw new Error('Application command router is disposed.')
        if (state.settled) return
        state.settled = true
        removeScope(state, false)
      }
    })
  }

  const invoke: ApplicationCommandDispatcher['invoke'] = async (command, invocation) => {
    if (disposed) {
      report('router-disposed', command.name)
      throw new Error('Application command router is disposed.')
    }
    const registered = commands.get(command.name)
    if (!registered || registered.command !== command) {
      report('unknown-command', command.name)
      throw new Error(`Unknown application command: ${command.name}`)
    }
    if (!invocation.callerContext.isAuthorizationCurrent()) {
      report('authorization-stale', command.name)
      throw new Error('Caller authorization is no longer current.')
    }
    if (invocation.callerLease.leaseId !== invocation.callerContext.leaseId) {
      report('lease-mismatch', command.name)
      throw new Error('Caller lease does not match caller context.')
    }
    if (invocation.callerLease.signal.aborted || !invocation.callerLease.isCurrent()) {
      report('lease-stale', command.name)
      throw new Error('Caller lease is no longer current.')
    }

    let handlerInvocation = invocation as ApplicationInvocation<readonly unknown[]>
    if (registered.command.contract) {
      try {
        handlerInvocation = Object.freeze({
          ...invocation,
          args: registered.command.contract.args.parse(invocation.args)
        })
      } catch {
        report('invalid-command-arguments', command.name)
        throw new ApplicationCommandError(
          'invalid-command-arguments',
          `Invalid arguments for application command: ${command.name}`
        )
      }
    }

    let result: unknown
    try {
      result = await registered.handler(handlerInvocation)
    } catch (error) {
      report('handler-rejected', command.name)
      throw error
    }

    if (registered.command.contract) {
      try {
        return registered.command.contract.result.parse(result) as CommandResult<typeof command>
      } catch {
        report('invalid-command-result', command.name)
        throw new ApplicationCommandError(
          'invalid-command-result',
          `Invalid result for application command: ${command.name}`
        )
      }
    }
    return result as CommandResult<typeof command>
  }

  return Object.freeze({
    registrar: Object.freeze({ createScope }),
    dispatcher: Object.freeze({
      invoke,
      commandNames: (): readonly string[] => [...commands.keys()].sort()
    }),
    dispose: (): void => {
      if (disposed) return
      disposed = true
      const failures: unknown[] = []
      for (const state of [...scopes].reverse()) {
        try {
          removeScope(state, state.settled)
        } catch (error) {
          failures.push(error)
        }
      }
      commands.clear()
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Application command cleanup failed.')
      }
    }
  })
}
