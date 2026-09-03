import { notebookEnvironmentApplicationCommandContracts } from '../../shared/notebook'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import type { CallerContext } from '../caller-context'
import type { NotebookEnvironmentLifecycle } from './environment-lifecycle-workflows'

type LifecycleArgs<Method extends keyof NotebookEnvironmentLifecycle> =
  NotebookEnvironmentLifecycle[Method] extends (...args: infer Args) => unknown
    ? Readonly<Args>
    : never

type LifecycleResult<Method extends keyof NotebookEnvironmentLifecycle> =
  NotebookEnvironmentLifecycle[Method] extends (...args: never[]) => infer Result
    ? Awaited<Result>
    : never

const assertLocalCaller = (callerContext: CallerContext, commandName: string): void => {
  if (callerContext.location !== 'local') {
    throw new Error(`Channel only available from the local app: ${commandName}`)
  }
}

const notebookEnvironmentStatusCommand = defineApplicationCommand<
  'notebook-env:status',
  LifecycleArgs<'status'>,
  LifecycleResult<'status'>
>('notebook-env:status')
const notebookEnvironmentProvisionCommand = defineApplicationCommand<
  'notebook-env:provision',
  LifecycleArgs<'provision'>,
  LifecycleResult<'provision'>
>('notebook-env:provision', notebookEnvironmentApplicationCommandContracts.provision)
const notebookEnvironmentRepairCommand = defineApplicationCommand<
  'notebook-env:repair',
  LifecycleArgs<'repair'>,
  LifecycleResult<'repair'>
>('notebook-env:repair', notebookEnvironmentApplicationCommandContracts.repair)
const notebookEnvironmentCancelCommand = defineApplicationCommand<
  'notebook-env:cancel',
  LifecycleArgs<'cancel'>,
  LifecycleResult<'cancel'>
>('notebook-env:cancel', notebookEnvironmentApplicationCommandContracts.cancel)

const notebookEnvironmentApplicationCommands = defineApplicationCommandGroup(
  'notebook-environment',
  [
    notebookEnvironmentStatusCommand,
    notebookEnvironmentProvisionCommand,
    notebookEnvironmentRepairCommand,
    notebookEnvironmentCancelCommand
  ] as const
)

const installNotebookEnvironmentApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  lifecycle: NotebookEnvironmentLifecycle
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(notebookEnvironmentApplicationCommands, {
      'notebook-env:status': () => lifecycle.status(),
      'notebook-env:provision': (invocation) => {
        assertLocalCaller(invocation.callerContext, notebookEnvironmentProvisionCommand.name)
        return lifecycle.provision(invocation.args[0], invocation.args[1])
      },
      'notebook-env:repair': (invocation) => {
        assertLocalCaller(invocation.callerContext, notebookEnvironmentRepairCommand.name)
        return lifecycle.repair(invocation.args[0], invocation.args[1], invocation.args[2])
      },
      'notebook-env:cancel': (invocation) => {
        assertLocalCaller(invocation.callerContext, notebookEnvironmentCancelCommand.name)
        return lifecycle.cancel(invocation.args[0])
      }
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  installNotebookEnvironmentApplicationCommands,
  notebookEnvironmentApplicationCommands,
  notebookEnvironmentCancelCommand,
  notebookEnvironmentProvisionCommand,
  notebookEnvironmentRepairCommand,
  notebookEnvironmentStatusCommand
}
