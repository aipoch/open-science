import type {
  AgentHomeSkillRef,
  AgentHomeSkillView,
  CreateSkillRequest,
  ImportAgentHomeSkillsResult,
  ImportSkillResult,
  ImportSkillZipBatchResult,
  ScanRepoResult,
  SkillBundlePreviewResult,
  SkillImportPreviewContent,
  SkillView,
  UpdateSkillRequest
} from '../../../shared/settings'

export type SettingsSkillsState = { skills: SkillView[] }

export type SettingsSkillsActions = {
  loadSkills: () => Promise<void>
  setSkillEnabled: (id: string, enabled: boolean) => Promise<void>
  createSkill: (request: CreateSkillRequest) => Promise<void>
  updateSkill: (request: UpdateSkillRequest) => Promise<void>
  deleteSkill: (id: string) => Promise<void>
  importSkill: (url: string) => Promise<ImportSkillResult>
  importSkillZip: (
    dataBase64: string,
    opts?: { subPath?: string; replaceId?: string }
  ) => Promise<ImportSkillResult>
  importSkillZipBatch: (
    dataBase64: string,
    items: { subPath: string; replaceId?: string }[]
  ) => Promise<ImportSkillZipBatchResult>
  previewSkillZip: (dataBase64: string) => Promise<SkillBundlePreviewResult>
  previewGitHubSkill: (url: string) => Promise<SkillImportPreviewContent>
  scanRepoSkills: (repo: string) => Promise<ScanRepoResult>
  listAgentHomeSkills: () => Promise<AgentHomeSkillView[]>
  previewAgentHomeSkill: (skill: AgentHomeSkillRef) => Promise<SkillImportPreviewContent>
  importAgentHomeSkills: (skills: AgentHomeSkillRef[]) => Promise<ImportAgentHomeSkillsResult>
}

type SettingsSkillsCommands = Pick<
  Window['api']['settings'],
  | 'listSkills'
  | 'setSkillEnabled'
  | 'createSkill'
  | 'updateSkill'
  | 'deleteSkill'
  | 'importSkill'
  | 'importSkillZip'
  | 'importSkillZipBatch'
  | 'previewSkillZip'
  | 'previewGitHubSkill'
  | 'scanRepoSkills'
  | 'listAgentHomeSkills'
  | 'previewAgentHomeSkill'
  | 'importAgentHomeSkills'
>

type SettingsSkillsSliceOptions = {
  getState: () => SettingsSkillsState
  setState: (patch: Partial<SettingsSkillsState>) => void
  getCommands: () => SettingsSkillsCommands
}

export const createInitialSettingsSkillsState = (): SettingsSkillsState => ({ skills: [] })

// Owns the renderer Skill catalog projection and its command settlement. Preview-only commands keep
// their detail state with callers, while catalog-returning imports reconcile this single projection.
export const createSettingsSkillsSlice = ({
  getState,
  setState,
  getCommands
}: SettingsSkillsSliceOptions): SettingsSkillsActions => {
  const reconcileCatalog = async (command: () => Promise<SkillView[]>): Promise<void> => {
    setState({ skills: await command() })
  }

  const reconcileImport = async <Result extends { skills: SkillView[] }>(
    command: () => Promise<Result>
  ): Promise<Result> => {
    const result = await command()
    setState({ skills: result.skills })
    return result
  }

  return {
    loadSkills: () => reconcileCatalog(() => getCommands().listSkills()),
    setSkillEnabled: async (id, enabled) => {
      setState({
        skills: getState().skills.map((skill) => (skill.id === id ? { ...skill, enabled } : skill))
      })
      await reconcileCatalog(() => getCommands().setSkillEnabled({ id, enabled }))
    },
    createSkill: (request) => reconcileCatalog(() => getCommands().createSkill(request)),
    updateSkill: (request) => reconcileCatalog(() => getCommands().updateSkill(request)),
    deleteSkill: (id) => reconcileCatalog(() => getCommands().deleteSkill({ id })),
    importSkill: (url) => reconcileImport(() => getCommands().importSkill({ url })),
    importSkillZip: (dataBase64, opts) =>
      reconcileImport(() =>
        getCommands().importSkillZip({
          dataBase64,
          subPath: opts?.subPath,
          replaceId: opts?.replaceId
        })
      ),
    importSkillZipBatch: (dataBase64, items) =>
      reconcileImport(() => getCommands().importSkillZipBatch({ dataBase64, items })),
    previewSkillZip: async (dataBase64) => getCommands().previewSkillZip({ dataBase64 }),
    previewGitHubSkill: async (url) => getCommands().previewGitHubSkill({ url }),
    scanRepoSkills: async (repo) => getCommands().scanRepoSkills({ repo }),
    listAgentHomeSkills: async () => getCommands().listAgentHomeSkills(),
    previewAgentHomeSkill: async (skill) => getCommands().previewAgentHomeSkill(skill),
    importAgentHomeSkills: (skills) =>
      reconcileImport(() => getCommands().importAgentHomeSkills({ skills }))
  }
}
