import type {
  PrepareManuscriptRequest,
  PrepareManuscriptResult,
  QuartoDetection,
  RenderManuscriptRequest,
  RenderManuscriptResult
} from '../../shared/manuscripts'
import { manuscriptApplicationCommandContracts } from '../../shared/manuscripts'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import type { CallerContext } from '../caller-context'
import type { ManuscriptCommandOwner } from './command-owner'

const manuscriptDetectQuartoCommand = defineApplicationCommand<
  'manuscripts:detect-quarto',
  readonly [],
  QuartoDetection
>('manuscripts:detect-quarto', manuscriptApplicationCommandContracts.detectQuarto)
const manuscriptPrepareCommand = defineApplicationCommand<
  'manuscripts:prepare',
  readonly [request: PrepareManuscriptRequest],
  PrepareManuscriptResult
>('manuscripts:prepare', manuscriptApplicationCommandContracts.prepare)
const manuscriptRenderCommand = defineApplicationCommand<
  'manuscripts:render',
  readonly [request: RenderManuscriptRequest],
  RenderManuscriptResult
>('manuscripts:render', manuscriptApplicationCommandContracts.render)
const manuscriptExportCommand = defineApplicationCommand<
  'manuscripts:export',
  readonly [request: RenderManuscriptRequest],
  RenderManuscriptResult
>('manuscripts:export', manuscriptApplicationCommandContracts.export)

const manuscriptApplicationCommands = defineApplicationCommandGroup('manuscripts', [
  manuscriptDetectQuartoCommand,
  manuscriptPrepareCommand,
  manuscriptRenderCommand,
  manuscriptExportCommand
] as const)

const requireLocalCaller = (context: CallerContext): void => {
  if (context.location !== 'local') {
    throw new Error('Manuscript commands are only available to local callers.')
  }
}

const installManuscriptApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: ManuscriptCommandOwner
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(manuscriptApplicationCommands, {
      'manuscripts:detect-quarto': ({ callerContext }) => {
        requireLocalCaller(callerContext)
        return owner.detectQuarto()
      },
      'manuscripts:prepare': ({ callerContext, args }) => {
        requireLocalCaller(callerContext)
        return owner.prepare(args[0])
      },
      'manuscripts:render': ({ callerContext, args, callerLease }) => {
        requireLocalCaller(callerContext)
        return owner.render(args[0], callerLease.signal)
      },
      'manuscripts:export': ({ callerContext, args, callerLease }) => {
        requireLocalCaller(callerContext)
        return owner.render(args[0], callerLease.signal)
      }
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  installManuscriptApplicationCommands,
  manuscriptApplicationCommands,
  manuscriptDetectQuartoCommand,
  manuscriptExportCommand,
  manuscriptPrepareCommand,
  manuscriptRenderCommand
}
