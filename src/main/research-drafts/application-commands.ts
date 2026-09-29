import { researchDraftCommandContracts } from '../../shared/research-draft'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandRegistrar,
  type ApplicationCommandInstallation
} from '../application-command-router'
import type { ResearchDraftService } from './service'
export type ResearchDraftCommandOwner = Pick<ResearchDraftService, 'list' | 'save' | 'act'>
export const researchDraftCommands = {
  list: defineApplicationCommand('research-drafts:list', researchDraftCommandContracts.list),
  save: defineApplicationCommand('research-drafts:save', researchDraftCommandContracts.save),
  act: defineApplicationCommand('research-drafts:act', researchDraftCommandContracts.act)
}
export const researchDraftCommandGroup = defineApplicationCommandGroup(
  'research-drafts',
  Object.values(researchDraftCommands)
)
export const registerResearchDraftCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: ResearchDraftCommandOwner
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(researchDraftCommandGroup, {
      'research-drafts:list': ({ args }) => owner.list(args[0]),
      'research-drafts:save': ({ args }) => owner.save(args[0]),
      'research-drafts:act': ({ args }) => owner.act(args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
