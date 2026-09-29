import { researchSubmissionCommandContracts } from '../../shared/research-submission'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandRegistrar,
  type ApplicationCommandInstallation
} from '../application-command-router'
import type { RuntimeWriterOwner } from '../session-persistence/runtime-writer'
import type { ResearchSubmissionService } from './service'

export const researchSubmissionCommands = {
  enqueue: defineApplicationCommand(
    'research-submissions:enqueue',
    researchSubmissionCommandContracts.enqueue
  ),
  list: defineApplicationCommand(
    'research-submissions:list',
    researchSubmissionCommandContracts.list
  ),
  claim: defineApplicationCommand(
    'research-submissions:claim',
    researchSubmissionCommandContracts.claim
  ),
  finish: defineApplicationCommand(
    'research-submissions:finish',
    researchSubmissionCommandContracts.finish
  ),
  act: defineApplicationCommand('research-submissions:act', researchSubmissionCommandContracts.act)
}
export const researchSubmissionCommandGroup = defineApplicationCommandGroup(
  'research-submissions',
  Object.values(researchSubmissionCommands)
)
export type ResearchSubmissionCommandDependencies = {
  service: ResearchSubmissionService
  writer: Pick<RuntimeWriterOwner, 'commit'>
  withWrite: <T>(operation: () => Promise<T>) => Promise<T>
}
export const registerResearchSubmissionCommands = (
  registrar: ApplicationCommandRegistrar,
  { service, writer, withWrite }: ResearchSubmissionCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(researchSubmissionCommandGroup, {
      'research-submissions:enqueue': ({ args }) => withWrite(() => service.enqueue(args[0])),
      'research-submissions:list': ({ args }) => withWrite(() => service.list(args[0])),
      'research-submissions:claim': ({ args, callerContext }) =>
        writer.commit(callerContext.lifecycleClientId, args[0].runtimeWriterToken, () =>
          withWrite(() => service.claim(callerContext.lifecycleClientId))
        ),
      'research-submissions:finish': ({ args, callerContext }) =>
        writer.commit(callerContext.lifecycleClientId, args[0].runtimeWriterToken, () =>
          withWrite(() => service.finish(callerContext.lifecycleClientId, args[0]))
        ),
      'research-submissions:act': ({ args }) => withWrite(() => service.act(args[0]))
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
