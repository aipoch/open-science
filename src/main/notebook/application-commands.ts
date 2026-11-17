import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar,
  type ApplicationInvocation
} from '../application-command-router'
import { canSatisfyHumanApproval, type CallerContext } from '../caller-context'
import { withNotebookUserOperation } from './execution-intent'
import type { NotebookCommandWorkflows } from './notebook-workflows'

type NotebookApplicationCommandDependencies = Readonly<{
  workflows: NotebookCommandWorkflows
  resourceReleaseBlockedReason?: () => string | undefined
  readInputPreview: (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
}>

type WorkflowArgs<Method extends keyof NotebookCommandWorkflows> =
  NotebookCommandWorkflows[Method] extends (...args: infer Args) => unknown ? Readonly<Args> : never

type WorkflowResult<Method extends keyof NotebookCommandWorkflows> =
  NotebookCommandWorkflows[Method] extends (...args: never[]) => infer Result
    ? Awaited<Result>
    : never

const assertLocalCaller = (callerContext: CallerContext, commandName: string): void => {
  if (callerContext.location !== 'local') {
    throw new Error(`Channel only available from the local app: ${commandName}`)
  }
}

const notebookRunIndexCommand = defineApplicationCommand<
  'notebook:run-index',
  WorkflowArgs<'runIndex'>,
  WorkflowResult<'runIndex'>
>('notebook:run-index')

const notebookStateCommand = defineApplicationCommand<
  'notebook:state',
  WorkflowArgs<'state'>,
  WorkflowResult<'state'>
>('notebook:state')
const notebookProjectActivityCommand = defineApplicationCommand<
  'notebook:project-activity',
  WorkflowArgs<'projectActivity'>,
  WorkflowResult<'projectActivity'>
>('notebook:project-activity')
const notebookProjectResourcesCommand = defineApplicationCommand<
  'notebook:project-resources',
  WorkflowArgs<'projectResources'>,
  WorkflowResult<'projectResources'>
>('notebook:project-resources')
const notebookReleaseSessionResourcesCommand = defineApplicationCommand<
  'notebook:release-session-resources',
  readonly [request: WorkflowArgs<'releaseSessionResources'>[0]],
  WorkflowResult<'releaseSessionResources'>
>('notebook:release-session-resources')
const notebookResourceReleaseCommand = defineApplicationCommand<
  'notebook:resource-release',
  WorkflowArgs<'resourceRelease'>,
  WorkflowResult<'resourceRelease'>
>('notebook:resource-release')
const notebookRetryResourceReleaseCommand = defineApplicationCommand<
  'notebook:retry-resource-release',
  readonly [request: WorkflowArgs<'retryResourceRelease'>[0]],
  WorkflowResult<'retryResourceRelease'>
>('notebook:retry-resource-release')

const currentHuman =
  (invocation: ApplicationInvocation<readonly unknown[]>): (() => void) =>
  () => {
    if (
      !canSatisfyHumanApproval(invocation.callerContext) ||
      invocation.callerLease.signal.aborted ||
      !invocation.callerLease.isCurrent()
    )
      throw new Error('Only a current human caller can manage Notebook resources.')
  }
const notebookMemoryPolicyStateCommand = defineApplicationCommand<
  'notebook:memory-policy-state',
  WorkflowArgs<'memoryPolicyState'>,
  WorkflowResult<'memoryPolicyState'>
>('notebook:memory-policy-state')
const notebookProcessMonitorCommand = defineApplicationCommand<
  'notebook:process-monitor',
  WorkflowArgs<'processMonitor'>,
  WorkflowResult<'processMonitor'>
>('notebook:process-monitor')
const notebookTerminateMonitoredProcessCommand = defineApplicationCommand<
  'notebook:terminate-monitored-process',
  WorkflowArgs<'terminateMonitoredProcess'>,
  WorkflowResult<'terminateMonitoredProcess'>
>('notebook:terminate-monitored-process')
const notebookInspectNamespaceCommand = defineApplicationCommand<
  'notebook:inspect-namespace',
  WorkflowArgs<'inspectNamespace'>,
  WorkflowResult<'inspectNamespace'>
>('notebook:inspect-namespace')
const notebookReferenceCommand = defineApplicationCommand<
  'notebook:reference',
  WorkflowArgs<'reference'>,
  WorkflowResult<'reference'>
>('notebook:reference')
const notebookBeginCodeCellCommand = defineApplicationCommand<
  'notebook:begin-code-cell',
  WorkflowArgs<'beginCodeCell'>,
  WorkflowResult<'beginCodeCell'>
>('notebook:begin-code-cell')
const notebookAppendCodeCellCommand = defineApplicationCommand<
  'notebook:append-code-cell',
  WorkflowArgs<'appendCodeCell'>,
  WorkflowResult<'appendCodeCell'>
>('notebook:append-code-cell')
const notebookAbortCodeCellCommand = defineApplicationCommand<
  'notebook:abort-code-cell',
  WorkflowArgs<'abortCodeCell'>,
  WorkflowResult<'abortCodeCell'>
>('notebook:abort-code-cell')
const notebookFinishCodeCellCommand = defineApplicationCommand<
  'notebook:finish-code-cell',
  WorkflowArgs<'finishCodeCell'>,
  WorkflowResult<'finishCodeCell'>
>('notebook:finish-code-cell')
const notebookRunCellCommand = defineApplicationCommand<
  'notebook:run-cell',
  WorkflowArgs<'runCell'>,
  WorkflowResult<'runCell'>
>('notebook:run-cell')
const notebookExecuteCommand = defineApplicationCommand<
  'notebook:execute',
  WorkflowArgs<'execute'>,
  WorkflowResult<'execute'>
>('notebook:execute')
const notebookGetBackgroundRunCommand = defineApplicationCommand<
  'notebook:background-run',
  WorkflowArgs<'getBackgroundRun'>,
  WorkflowResult<'getBackgroundRun'>
>('notebook:background-run')
const notebookCancelBackgroundRunCommand = defineApplicationCommand<
  'notebook:cancel-background-run',
  WorkflowArgs<'cancelBackgroundRun'>,
  WorkflowResult<'cancelBackgroundRun'>
>('notebook:cancel-background-run')
const notebookExportIpynbCommand = defineApplicationCommand<
  'notebook:export-ipynb',
  WorkflowArgs<'exportIpynb'>,
  WorkflowResult<'exportIpynb'>
>('notebook:export-ipynb')
const notebookExportIpynbAllCommand = defineApplicationCommand<
  'notebook:export-ipynb-all',
  WorkflowArgs<'exportIpynbAll'>,
  WorkflowResult<'exportIpynbAll'>
>('notebook:export-ipynb-all')
const notebookRestartCommand = defineApplicationCommand<
  'notebook:restart',
  WorkflowArgs<'restart'>,
  WorkflowResult<'restart'>
>('notebook:restart')
const notebookShutdownCommand = defineApplicationCommand<
  'notebook:shutdown',
  WorkflowArgs<'shutdown'>,
  WorkflowResult<'shutdown'>
>('notebook:shutdown')
const notebookReadInputPreviewCommand = defineApplicationCommand<
  'notebook:read-input-preview',
  readonly [request: ReadArtifactPreviewRequest],
  ArtifactPreviewResult
>('notebook:read-input-preview')

const notebookApplicationCommands = defineApplicationCommandGroup('notebook', [
  notebookRunIndexCommand,
  notebookStateCommand,
  notebookProjectActivityCommand,
  notebookProjectResourcesCommand,
  notebookReleaseSessionResourcesCommand,
  notebookResourceReleaseCommand,
  notebookRetryResourceReleaseCommand,
  notebookMemoryPolicyStateCommand,
  notebookProcessMonitorCommand,
  notebookTerminateMonitoredProcessCommand,
  notebookInspectNamespaceCommand,
  notebookReferenceCommand,
  notebookBeginCodeCellCommand,
  notebookAppendCodeCellCommand,
  notebookAbortCodeCellCommand,
  notebookFinishCodeCellCommand,
  notebookRunCellCommand,
  notebookExecuteCommand,
  notebookGetBackgroundRunCommand,
  notebookCancelBackgroundRunCommand,
  notebookExportIpynbCommand,
  notebookExportIpynbAllCommand,
  notebookRestartCommand,
  notebookShutdownCommand,
  notebookReadInputPreviewCommand
] as const)

const installNotebookApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: NotebookApplicationCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    dependencies.workflows.configureResourceReleaseGuard(
      dependencies.resourceReleaseBlockedReason ?? (() => undefined)
    )
    scope.registerGroup(notebookApplicationCommands, {
      'notebook:project-resources': async (invocation) => {
        const assertCurrent = currentHuman(invocation)
        assertCurrent()
        const result = await dependencies.workflows.projectResources(invocation.args[0])
        assertCurrent()
        return result
      },
      'notebook:release-session-resources': (invocation) =>
        dependencies.workflows.releaseSessionResources(
          invocation.args[0],
          currentHuman(invocation)
        ),
      'notebook:resource-release': async (invocation) => {
        const assertCurrent = currentHuman(invocation)
        assertCurrent()
        const result = await dependencies.workflows.resourceRelease(invocation.args[0])
        assertCurrent()
        return result
      },
      'notebook:retry-resource-release': (invocation) =>
        dependencies.workflows.retryResourceRelease(invocation.args[0], currentHuman(invocation)),
      'notebook:run-index': (invocation) => dependencies.workflows.runIndex(invocation.args[0]),
      'notebook:state': (invocation) => dependencies.workflows.state(invocation.args[0]),
      'notebook:memory-policy-state': (invocation) =>
        dependencies.workflows.memoryPolicyState(invocation.args[0]),
      'notebook:project-activity': (invocation) =>
        dependencies.workflows.projectActivity(invocation.args[0]),
      'notebook:process-monitor': (invocation) => {
        assertLocalCaller(invocation.callerContext, notebookProcessMonitorCommand.name)
        return dependencies.workflows.processMonitor(invocation.args[0])
      },
      'notebook:terminate-monitored-process': (invocation) => {
        assertLocalCaller(invocation.callerContext, notebookTerminateMonitoredProcessCommand.name)
        return dependencies.workflows.terminateMonitoredProcess(invocation.args[0])
      },
      'notebook:inspect-namespace': (invocation) =>
        dependencies.workflows.inspectNamespace(invocation.args[0]),
      'notebook:reference': (invocation) => dependencies.workflows.reference(invocation.args[0]),
      'notebook:begin-code-cell': (invocation) =>
        dependencies.workflows.beginCodeCell(invocation.args[0]),
      'notebook:append-code-cell': (invocation) =>
        dependencies.workflows.appendCodeCell(invocation.args[0]),
      'notebook:abort-code-cell': (invocation) =>
        dependencies.workflows.abortCodeCell(invocation.args[0]),
      'notebook:finish-code-cell': (invocation) =>
        dependencies.workflows.finishCodeCell(invocation.args[0]),
      'notebook:run-cell': (invocation) => dependencies.workflows.runCell(invocation.args[0]),
      'notebook:execute': (invocation) => {
        const request = invocation.args[0]
        if (
          request.source === 'user' &&
          request.inputKind === 'terminal' &&
          canSatisfyHumanApproval(invocation.callerContext)
        ) {
          const assertCurrent = currentHuman(invocation)
          assertCurrent()
          return dependencies.workflows.execute(
            withNotebookUserOperation(request, { assertCurrent })
          )
        }
        return dependencies.workflows.execute(request)
      },
      'notebook:background-run': (invocation) =>
        dependencies.workflows.getBackgroundRun(invocation.args[0]),
      'notebook:cancel-background-run': (invocation) =>
        dependencies.workflows.cancelBackgroundRun(invocation.args[0]),
      'notebook:export-ipynb': (invocation) => {
        assertLocalCaller(invocation.callerContext, notebookExportIpynbCommand.name)
        return dependencies.workflows.exportIpynb(invocation.args[0])
      },
      'notebook:export-ipynb-all': (invocation) => {
        assertLocalCaller(invocation.callerContext, notebookExportIpynbAllCommand.name)
        return dependencies.workflows.exportIpynbAll(invocation.args[0])
      },
      'notebook:restart': (invocation) => dependencies.workflows.restart(invocation.args[0]),
      'notebook:shutdown': (invocation) => dependencies.workflows.shutdown(invocation.args[0]),
      'notebook:read-input-preview': (invocation) =>
        dependencies.readInputPreview(invocation.args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  installNotebookApplicationCommands,
  notebookAppendCodeCellCommand,
  notebookApplicationCommands,
  notebookBeginCodeCellCommand,
  notebookCancelBackgroundRunCommand,
  notebookExecuteCommand,
  notebookExportIpynbAllCommand,
  notebookExportIpynbCommand,
  notebookAbortCodeCellCommand,
  notebookFinishCodeCellCommand,
  notebookGetBackgroundRunCommand,
  notebookInspectNamespaceCommand,
  notebookProjectActivityCommand,
  notebookProjectResourcesCommand,
  notebookReleaseSessionResourcesCommand,
  notebookResourceReleaseCommand,
  notebookRetryResourceReleaseCommand,
  notebookMemoryPolicyStateCommand,
  notebookProcessMonitorCommand,
  notebookTerminateMonitoredProcessCommand,
  notebookReadInputPreviewCommand,
  notebookReferenceCommand,
  notebookRestartCommand,
  notebookRunCellCommand,
  notebookShutdownCommand,
  notebookStateCommand
}
export type { NotebookApplicationCommandDependencies }
