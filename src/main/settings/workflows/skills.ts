import type {
  CreateSkillRequest,
  DeleteSkillRequest,
  ImportAgentHomeSkillsRequest,
  ImportSkillRequest,
  ImportSkillZipBatchRequest,
  ImportSkillZipRequest,
  SetConversationSkillImportEnabledRequest,
  SetSkillEnabledRequest,
  SetSkillsEnabledRequest,
  UpdateSkillRequest
} from '../../../shared/settings'
import type { SettingsService } from '../service'

type SkillSettingsWorkflowStore = Pick<
  SettingsService,
  | 'setConversationSkillImportEnabled'
  | 'setSkillEnabled'
  | 'setSkillsEnabled'
  | 'createSkill'
  | 'updateSkill'
  | 'deleteSkill'
  | 'importSkill'
  | 'importSkillZip'
  | 'importSkillZipBatch'
  | 'importAgentHomeSkills'
>

type SkillSettingsWorkflowEffects = {
  requestSkillsReload: () => void
  notifySkillCatalogChanged: () => void
  removeTagsForSkill: (id: string) => Promise<void>
}

type WorkflowResult<Method extends keyof SkillSettingsWorkflowStore> = Promise<
  Awaited<ReturnType<SkillSettingsWorkflowStore[Method]>>
>

// Owns only Skill-catalog mutations and their runtime reload signal.
class SkillSettingsWorkflows {
  constructor(
    private readonly settings: SkillSettingsWorkflowStore,
    private readonly effects: SkillSettingsWorkflowEffects
  ) {}

  async setConversationSkillImportEnabled(
    request: SetConversationSkillImportEnabledRequest
  ): WorkflowResult<'setConversationSkillImportEnabled'> {
    const snapshot = await this.settings.setConversationSkillImportEnabled(request.enabled)
    this.effects.requestSkillsReload()
    return snapshot
  }

  async setSkillEnabled(request: SetSkillEnabledRequest): WorkflowResult<'setSkillEnabled'> {
    return this.afterSkillsChanged(() => this.settings.setSkillEnabled(request))
  }

  async setSkillsEnabled(request: SetSkillsEnabledRequest): WorkflowResult<'setSkillsEnabled'> {
    return this.afterSkillsChanged(() => this.settings.setSkillsEnabled(request))
  }

  async createSkill(request: CreateSkillRequest): WorkflowResult<'createSkill'> {
    return this.afterSkillsChanged(() => this.settings.createSkill(request))
  }

  async updateSkill(request: UpdateSkillRequest): WorkflowResult<'updateSkill'> {
    return this.afterSkillsChanged(() => this.settings.updateSkill(request))
  }

  async deleteSkill(request: DeleteSkillRequest): WorkflowResult<'deleteSkill'> {
    const result = await this.settings.deleteSkill(request)
    await this.effects.removeTagsForSkill(request.id).catch(() => undefined)
    this.effects.notifySkillCatalogChanged()
    return result
  }

  async importSkill(request: ImportSkillRequest): WorkflowResult<'importSkill'> {
    return this.afterSkillsChanged(() => this.settings.importSkill(request))
  }

  async importSkillZip(request: ImportSkillZipRequest): WorkflowResult<'importSkillZip'> {
    return this.afterSkillsChanged(() => this.settings.importSkillZip(request))
  }

  async importSkillZipBatch(
    request: ImportSkillZipBatchRequest
  ): WorkflowResult<'importSkillZipBatch'> {
    return this.afterSkillsChanged(() => this.settings.importSkillZipBatch(request))
  }

  async importAgentHomeSkills(
    request: ImportAgentHomeSkillsRequest
  ): WorkflowResult<'importAgentHomeSkills'> {
    const result = await this.settings.importAgentHomeSkills(request)
    if (result.results.some((item) => item.status === 'imported' || item.status === 'updated')) {
      this.effects.notifySkillCatalogChanged()
    }
    return result
  }

  private async afterSkillsChanged<Result>(mutation: () => Promise<Result>): Promise<Result> {
    const result = await mutation()
    this.effects.notifySkillCatalogChanged()
    return result
  }
}

export { SkillSettingsWorkflows }
export type { SkillSettingsWorkflowEffects, SkillSettingsWorkflowStore }
