import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import type { CallerContext } from '../caller-context'
import type { NotebookCommandWorkflows } from './notebook-workflows'

type NotebookApplicationCommandDependencies = Readonly<{
  workflows: NotebookCommandWorkflows
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

const notebookStateCommand = defineApplicationCommand<
  'notebook:state',
  WorkflowArgs<'state'>,
  WorkflowResult<'state'>
>('notebook:state')
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
  notebookStateCommand,
  notebookInspectNamespaceCommand,
  notebookReferenceCommand,
  notebookBeginCodeCellCommand,
  notebookAppendCodeCellCommand,
  notebookAbortCodeCellCommand,
  notebookFinishCodeCellCommand,
  notebookRunCellCommand,
  notebookExecuteCommand,
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
    scope.registerGroup(notebookApplicationCommands, {
      'notebook:state': (invocation) => dependencies.workflows.state(invocation.args[0]),
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
      'notebook:execute': (invocation) => dependencies.workflows.execute(invocation.args[0]),
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
  notebookExecuteCommand,
  notebookExportIpynbAllCommand,
  notebookExportIpynbCommand,
  notebookAbortCodeCellCommand,
  notebookFinishCodeCellCommand,
  notebookInspectNamespaceCommand,
  notebookReadInputPreviewCommand,
  notebookReferenceCommand,
  notebookRestartCommand,
  notebookRunCellCommand,
  notebookShutdownCommand,
  notebookStateCommand
}
export type { NotebookApplicationCommandDependencies }
