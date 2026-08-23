import type { AgentFrameworkId } from '../../shared/settings'
import type { EffectiveSpecialistSkills } from '../../shared/specialist'
import type { ResolvedAgentBackend } from '../agent-framework'
import { createLogger } from '../logger'
import type {
  ResponsesBridgeSkillCandidate,
  ResponsesBridgeSkillInput
} from '../settings/responses-bridge'
import { AcpSessionPresentationPolicy } from './session-presentation-policy'
const log = createLogger('acp-turn-skill-owner')
const presentation = new AcpSessionPresentationPolicy()
type AcpTurnSkillHooks = Readonly<{
  needForceLoad: (ids: string[]) => Promise<string[]>
  namesForIds: (ids: string[]) => Promise<string[]>
  descriptorsForIds?: (
    ids: string[],
    codexHome: string | undefined
  ) => Promise<ResponsesBridgeSkillInput[]>
  catalogForCodexHome?: (codexHome: string | undefined) => Promise<ResponsesBridgeSkillCandidate[]>
}>
type TurnSkillOutcome = 'completed' | 'failed' | 'cancelled' | 'reload-restored'
type ProviderPreparationInput = Readonly<{
  frameworkId: AgentFrameworkId
  selectionText: string
  promptText: string
  codex?: Readonly<{
    home?: string
    bridgeSkillsAvailable: boolean
    selectSkills: NonNullable<ResolvedAgentBackend['responsesBridgeLease']>['selectSkills']
    signal?: AbortSignal
  }>
}>
type ProviderPreparation = Readonly<{
  text: string
  specialistSkillGuidance?: string
  codexSkillInputs: readonly ResponsesBridgeSkillInput[]
}>
type TurnSkillHandle = Readonly<{
  reloadDecision: Readonly<{ kind: 'continue' | 'reload' }>
  prepareProvider: (input: ProviderPreparationInput) => Promise<ProviderPreparation>
  close: (outcome: TurnSkillOutcome) => void
}>
type Authorization = {
  outcome?: TurnSkillOutcome
  selectedSkillIds: readonly string[]
  scope?: EffectiveSpecialistSkills
}
class AcpTurnSkillOwner {
  private forced: Authorization | undefined
  constructor(
    private readonly options: Readonly<{
      resolveSpecialistSkills?: (id: string) => Promise<EffectiveSpecialistSkills>
      skills?: AcpTurnSkillHooks
      requestSkillsReload: () => void
    }>
  ) {}
  authorize(input: {
    specialistId?: string
    selectedSkillIds?: readonly string[]
    signal?: AbortSignal
  }): TurnSkillHandle | Promise<TurnSkillHandle> {
    const selected = Object.freeze([...(input.selectedSkillIds ?? [])])
    const finish = (
      scope?: EffectiveSpecialistSkills
    ): TurnSkillHandle | Promise<TurnSkillHandle> => {
      if (scope?.kind === 'unavailable') throw new Error(scope.reason)
      if (scope?.kind === 'specialist') {
        const rejected = selected.find(
          (id) =>
            !scope.skillIds.includes(id) &&
            !(id.startsWith('mcp-') && scope.frameworkNames.includes(id))
        )
        if (rejected) {
          throw new Error(`Skill "${rejected}" is not available to the active specialist.`)
        }
      }
      const create = (disabled: string[]): TurnSkillHandle => {
        const needsReload = disabled.length > 0 && !input.signal?.aborted
        const state: Authorization = {
          selectedSkillIds: selected,
          ...(scope ? { scope } : {})
        }
        if (needsReload) this.forced = state
        return Object.freeze({
          reloadDecision: Object.freeze({ kind: needsReload ? 'reload' : 'continue' }),
          prepareProvider: (providerInput) => this.prepareProvider(state, providerInput),
          close: (outcome) => this.close(state, outcome)
        })
      }
      return this.options.skills && selected.length > 0
        ? this.options.skills.needForceLoad([...selected]).then(create)
        : create([])
    }
    if (!input.specialistId || !this.options.resolveSpecialistSkills) return finish()
    return this.options
      .resolveSpecialistSkills(input.specialistId)
      .catch(
        () => ({ kind: 'unavailable', reason: 'The bound specialist is unavailable.' }) as const
      )
      .then(finish)
  }
  backendPreparation(): Readonly<{ forcedSkillIds: readonly string[] }> {
    return Object.freeze({
      forcedSkillIds: Object.freeze([...(this.forced?.selectedSkillIds ?? [])])
    })
  }
  // Mid-turn inject must not force-load disabled Skills: that reconnects the session.
  // Prefix names / attach Codex skill-inputs on the steered prompt instead.
  async presentFollowUp(input: {
    frameworkId: AgentFrameworkId
    text: string
    selectedSkillIds: readonly string[]
    specialistId?: string
    codexHome?: string
  }): Promise<ProviderPreparation> {
    const selected = Object.freeze([...input.selectedSkillIds])
    let scope: EffectiveSpecialistSkills | undefined
    if (input.specialistId && this.options.resolveSpecialistSkills) {
      try {
        scope = await this.options.resolveSpecialistSkills(input.specialistId)
      } catch {
        throw new Error('The bound specialist is unavailable.')
      }
      if (scope.kind === 'unavailable') throw new Error(scope.reason)
      if (scope.kind === 'specialist') {
        const allowedIds = scope.skillIds
        const allowedNames = scope.frameworkNames
        const rejected = selected.find(
          (id) => !allowedIds.includes(id) && !(id.startsWith('mcp-') && allowedNames.includes(id))
        )
        if (rejected) {
          throw new Error(`Skill "${rejected}" is not available to the active specialist.`)
        }
      }
    }
    return this.prepareProvider(
      { selectedSkillIds: selected, ...(scope ? { scope } : {}) },
      {
        frameworkId: input.frameworkId,
        selectionText: input.text,
        promptText: input.text,
        ...(input.frameworkId === 'codex'
          ? {
              codex: {
                home: input.codexHome,
                bridgeSkillsAvailable: false,
                selectSkills: async () => []
              }
            }
          : {})
      }
    )
  }
  private close(state: Authorization, outcome: TurnSkillOutcome): void {
    if (state.outcome) return
    state.outcome = outcome
    if (this.forced !== state) return
    this.forced = undefined
    this.options.requestSkillsReload()
  }
  private async prepareProvider(
    state: Authorization,
    input: ProviderPreparationInput
  ): Promise<ProviderPreparation> {
    const skillNames =
      input.frameworkId !== 'codex' && state.selectedSkillIds.length > 0 && this.options.skills
        ? await this.options.skills.namesForIds([...state.selectedSkillIds])
        : []
    const codexSkillInputs = await this.resolveCodexInputs(state, input)
    const presented = presentation.presentTurnSkills({
      frameworkId: input.frameworkId,
      text: input.promptText,
      skillNames,
      codexSkillInputs
    })
    const guidance =
      input.frameworkId !== 'claude-code' && state.scope?.kind === 'specialist'
        ? `Allowed Specialist Skills for this session:\n${state.scope.frameworkNames.map((name) => `- ${name}`).join('\n')}`
        : undefined
    return Object.freeze({
      ...presented,
      ...(guidance ? { specialistSkillGuidance: guidance } : {}),
      codexSkillInputs: Object.freeze(codexSkillInputs)
    })
  }
  private async resolveCodexInputs(
    state: Authorization,
    input: ProviderPreparationInput
  ): Promise<ResponsesBridgeSkillInput[]> {
    if (input.frameworkId !== 'codex') return []
    if (state.selectedSkillIds.length > 0) {
      return (
        this.options.skills?.descriptorsForIds?.([...state.selectedSkillIds], input.codex?.home) ??
        []
      )
    }
    const codex = input.codex
    if (!codex?.bridgeSkillsAvailable || !this.options.skills?.catalogForCodexHome) return []
    let catalog: ResponsesBridgeSkillCandidate[]
    try {
      catalog = await this.options.skills.catalogForCodexHome(codex.home)
    } catch {
      return this.selectionFailed('catalog-error')
    }
    if (state.scope?.kind === 'specialist') {
      const allowed = new Set(state.scope.frameworkNames)
      catalog = catalog.filter((skill) => allowed.has(skill.name))
    }
    if (catalog.length === 0) return []
    try {
      const selected = await codex.selectSkills(input.selectionText, catalog, codex.signal)
      if (!selected) return []
      const offered = new Set(catalog.map((skill) => `${skill.name}\u0000${skill.path}`))
      return selected.filter((skill) => offered.has(`${skill.name}\u0000${skill.path}`))
    } catch {
      return this.selectionFailed('selector-error')
    }
  }
  private selectionFailed(reason: 'catalog-error' | 'selector-error'): [] {
    log.warn('Codex Skill selection failed', { reason })
    return []
  }
}

const followUpPromptText = (presented: {
  text: string
  specialistSkillGuidance?: string
}): string =>
  presented.specialistSkillGuidance
    ? `${presented.specialistSkillGuidance}\n\n${presented.text}`
    : presented.text

export { AcpTurnSkillOwner, followUpPromptText }
export type { AcpTurnSkillHooks, TurnSkillHandle, TurnSkillOutcome }
