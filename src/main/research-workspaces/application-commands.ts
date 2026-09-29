import { researchWorkspaceCommandContracts } from '../../shared/research-workspace'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandRegistrar,
  type ApplicationCommandInstallation
} from '../application-command-router'
import type { ResearchWorkspaceService } from './service'

export type ResearchWorkspaceCommandOwner = Pick<
  ResearchWorkspaceService,
  | 'get'
  | 'list'
  | 'ensureDiscussion'
  | 'saveView'
  | 'saveQuestionContext'
  | 'getQuestionContext'
  | 'listQuestionContexts'
>
export const researchWorkspaceCommands = {
  get: defineApplicationCommand('research-workspaces:get', researchWorkspaceCommandContracts.get),
  list: defineApplicationCommand(
    'research-workspaces:list',
    researchWorkspaceCommandContracts.list
  ),
  ensureDiscussion: defineApplicationCommand(
    'research-workspaces:ensure-discussion',
    researchWorkspaceCommandContracts.ensureDiscussion
  ),
  saveView: defineApplicationCommand(
    'research-workspaces:save-view',
    researchWorkspaceCommandContracts.saveView
  ),
  saveQuestionContext: defineApplicationCommand(
    'research-workspaces:save-question-context',
    researchWorkspaceCommandContracts.saveQuestionContext
  ),
  getQuestionContext: defineApplicationCommand(
    'research-workspaces:get-question-context',
    researchWorkspaceCommandContracts.getQuestionContext
  ),
  listQuestionContexts: defineApplicationCommand(
    'research-workspaces:list-question-contexts',
    researchWorkspaceCommandContracts.listQuestionContexts
  )
}
export const researchWorkspaceCommandGroup = defineApplicationCommandGroup(
  'research-workspaces',
  Object.values(researchWorkspaceCommands)
)
export const registerResearchWorkspaceCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: ResearchWorkspaceCommandOwner
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(researchWorkspaceCommandGroup, {
      'research-workspaces:get': ({ args }) => owner.get(args[0]),
      'research-workspaces:list': ({ args }) => owner.list(args[0]),
      'research-workspaces:ensure-discussion': ({ args }) => owner.ensureDiscussion(args[0]),
      'research-workspaces:save-view': ({ args }) => owner.saveView(args[0]),
      'research-workspaces:save-question-context': ({ args }) => owner.saveQuestionContext(args[0]),
      'research-workspaces:get-question-context': ({ args }) => owner.getQuestionContext(args[0]),
      'research-workspaces:list-question-contexts': ({ args }) =>
        owner.listQuestionContexts(args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
