import { join } from 'node:path'

import type { AgentFrameworkId } from '../../shared/settings'
import type { EffectiveSpecialistSkills } from '../../shared/specialist'
import type { ResolvedAgentBackend } from '../agent-framework'
import { createLogger } from '../logger'
import type {
  ResponsesBridgeSkillCandidate,
  ResponsesBridgeSkillInput
} from '../settings/responses-bridge'
import {
  loadSkillDocumentContent,
  OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION
} from '../skills/runtime-mcp-server'
import { AcpSessionPresentationPolicy } from './session-presentation-policy'
import type { SessionCapabilityPolicy } from './session-capability-owner'
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
  catalogForCodeBuddyRoot?: (root: string | undefined) => Promise<ResponsesBridgeSkillCandidate[]>
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
    observeUsage?: Parameters<
      NonNullable<ResolvedAgentBackend['responsesBridgeLease']>['selectSkills']
    >[3]
  }>
  codebuddy?: Readonly<{
    root?: string
    selectorAvailable: boolean
    selectSkills: NonNullable<ResolvedAgentBackend['responsesBridgeLease']>['selectSkills']
    signal?: AbortSignal
    observeUsage?: Parameters<
      NonNullable<ResolvedAgentBackend['responsesBridgeLease']>['selectSkills']
    >[3]
  }>
}>
type ProviderPreparation = Readonly<{
  text: string
  skillScopeGuidance?: string
  codexSkillInputs: readonly ResponsesBridgeSkillInput[]
  skillActivityInputs?: readonly ResponsesBridgeSkillInput[]
  skillRuntimeAllowlist?: readonly string[]
}>
type LoadedCodeBuddySkill = Readonly<{
  name: string
  path: string
  resourceRoot: string
  document: string
}>
const CODEBUDDY_SKILL_RESOURCE_ROOT = '${CODEBUDDY_CONFIG_DIR}/skill-runtime/.claude/skills'
const codeBuddySkillRuntimeRoot = (
  options: Readonly<Record<string, unknown>> | undefined
): string | undefined => {
  const runtime = options?.[OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) return undefined
  const root = (runtime as Record<string, unknown>).root
  return typeof root === 'string' ? root : undefined
}
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
    role?: SessionCapabilityPolicy['role']
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
        if (scope?.kind === 'main') {
          const rejected = selected.find((id) => disabled.includes(id))
          if (rejected) {
            throw new Error(`Skill "${rejected}" is not available to Main Agent.`)
          }
        }
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
    const role = input.role ?? 'primary'
    if (role !== 'primary') {
      if (selected.length > 0) throw new Error('Skills are not available to this session.')
      return finish()
    }
    if (!input.specialistId) return finish({ kind: 'main' })
    if (!this.options.resolveSpecialistSkills) return finish()
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
  // Mid-turn inject must not force-load disabled Skills: that reconnects the session. Main still
  // checks enablement here so a stale or forged chip cannot bypass its current Skill scope.
  // Prefix names / attach Codex skill-inputs on the steered prompt instead.
  async presentFollowUp(input: {
    frameworkId: AgentFrameworkId
    text: string
    selectedSkillIds: readonly string[]
    role?: SessionCapabilityPolicy['role']
    specialistId?: string
    codexHome?: string
    codebuddy?: ProviderPreparationInput['codebuddy']
  }): Promise<ProviderPreparation> {
    const selected = Object.freeze([...input.selectedSkillIds])
    const role = input.role ?? 'primary'
    if (role !== 'primary' && selected.length > 0) {
      throw new Error('Skills are not available to this session.')
    }
    let scope: EffectiveSpecialistSkills | undefined =
      role !== 'primary' ? undefined : input.specialistId ? undefined : { kind: 'main' }
    if (role === 'primary' && input.specialistId && this.options.resolveSpecialistSkills) {
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
    if (scope?.kind === 'main' && selected.length > 0 && this.options.skills) {
      const disabled = await this.options.skills.needForceLoad([...selected])
      const rejected = selected.find((id) => disabled.includes(id))
      if (rejected) throw new Error(`Skill "${rejected}" is not available to Main Agent.`)
    }
    if (input.frameworkId === 'codebuddy' && selected.length === 0) {
      return Object.freeze({ text: input.text, codexSkillInputs: Object.freeze([]) })
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
          : {}),
        ...(input.frameworkId === 'codebuddy' && input.codebuddy
          ? { codebuddy: input.codebuddy }
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
    const selectedCodeBuddySkillNames = await this.resolveCodeBuddyNames(state, input, skillNames)
    const loadedCodeBuddySkills = await this.loadCodeBuddySkills(input, selectedCodeBuddySkillNames)
    const codeBuddySkillNames = loadedCodeBuddySkills.map(({ name }) => name)
    const presentedSkillNames = input.frameworkId === 'codebuddy' ? codeBuddySkillNames : skillNames
    const presented = presentation.presentTurnSkills({
      frameworkId: input.frameworkId,
      text: input.promptText,
      skillNames: presentedSkillNames,
      codexSkillInputs
    })
    const scopeGuidance =
      input.frameworkId === 'claude-code'
        ? undefined
        : state.scope?.kind === 'specialist'
          ? [
              '<open_science_specialist_skill_scope>',
              'Current Specialist Skill discovery is limited to the following exact list. It supersedes and revokes every earlier Specialist Skill or Connector scope in this conversation. This list does not grant tool or Connector permissions.',
              ...state.scope.frameworkNames.map((name) => `- ${name}`),
              '</open_science_specialist_skill_scope>'
            ].join('\n')
          : state.scope?.kind === 'main'
            ? [
                '<open_science_main_agent_scope>',
                'Current agent: Main Agent. Any earlier Specialist identity and Specialist-specific Skill or Connector scope in this conversation is no longer active. Use only capabilities available in the current Main Agent runtime.',
                '</open_science_main_agent_scope>'
              ].join('\n')
            : undefined
    const codeBuddyGuidance =
      input.frameworkId === 'codebuddy'
        ? [
            '<open_science_codebuddy_skill_route>',
            'This turn replaces every earlier CodeBuddy Skill route. The exact Skill documents listed below are already loaded by Open Science for this turn.',
            ...(codeBuddySkillNames.length > 0
              ? [
                  'Follow these documents before any Notebook or Connector call. Do not call `mcp__skills__load_skill`; the documents are already loaded.',
                  'Do not use Notebook `host.skills` to load, read, list, or discover routed Skills.',
                  'Use only the `host.mcp` Connector names and methods documented below; do not guess Connector names or methods.',
                  'Resolve every relative reference, script, or asset path in a loaded document against its `resource-root`. Keep the environment-backed root expression literal in local tool calls; do not print or resolve `CODEBUDDY_CONFIG_DIR`.',
                  ...loadedCodeBuddySkills.flatMap(({ name, resourceRoot, document }) => [
                    `<open_science_loaded_skill name="${name}" resource-root="${resourceRoot}">`,
                    document,
                    '</open_science_loaded_skill>'
                  ])
                ]
              : [
                  '- (none)',
                  'No Skill is routed for this turn. Do not call `mcp__skills__load_skill`, use Notebook `host.skills`, or guess Connector names or methods.'
                ]),
            '</open_science_codebuddy_skill_route>'
          ].join('\n')
        : undefined
    const guidance = [scopeGuidance, codeBuddyGuidance]
      .filter((value): value is string => Boolean(value))
      .join('\n\n')
    return Object.freeze({
      ...presented,
      ...(guidance ? { skillScopeGuidance: guidance } : {}),
      codexSkillInputs: Object.freeze(codexSkillInputs),
      skillActivityInputs: Object.freeze(
        input.frameworkId === 'codebuddy'
          ? loadedCodeBuddySkills.map(({ name, path }) => ({ name, path }))
          : codexSkillInputs
      ),
      ...(input.frameworkId === 'codebuddy'
        ? {
            // CodeBuddy does not provide a forced tool-choice seam. The selected documents are
            // injected above, so remove the model-callable loader before dispatch.
            skillRuntimeAllowlist: Object.freeze([])
          }
        : {})
    })
  }

  private async loadCodeBuddySkills(
    input: ProviderPreparationInput,
    names: readonly string[]
  ): Promise<LoadedCodeBuddySkill[]> {
    if (input.frameworkId !== 'codebuddy' || names.length === 0) return []
    const root = input.codebuddy?.root
    if (!root) return this.selectionFailed('document-error', 'CodeBuddy')
    const allowedNames = new Set(names)
    try {
      return await Promise.all(
        names.map(async (name) => {
          const resourceRoot = `${CODEBUDDY_SKILL_RESOURCE_ROOT}/${name}`
          return {
            name,
            path: join(root, '.claude', 'skills', name, 'SKILL.md'),
            resourceRoot,
            document: (await loadSkillDocumentContent({ root, allowedNames }, name)).replace(
              /\$\{CLAUDE_SKILL_DIR\}/g,
              resourceRoot
            )
          }
        })
      )
    } catch {
      return this.selectionFailed('document-error', 'CodeBuddy')
    }
  }

  private async resolveCodeBuddyNames(
    state: Authorization,
    input: ProviderPreparationInput,
    explicitNames: readonly string[]
  ): Promise<string[]> {
    if (input.frameworkId !== 'codebuddy') return []
    if (state.selectedSkillIds.length > 0) {
      return [...explicitNames]
    }
    const codebuddy = input.codebuddy
    if (!codebuddy?.selectorAvailable || !this.options.skills?.catalogForCodeBuddyRoot) {
      return []
    }
    let catalog: ResponsesBridgeSkillCandidate[]
    try {
      catalog = await this.options.skills.catalogForCodeBuddyRoot(codebuddy.root)
    } catch {
      return this.selectionFailed('catalog-error', 'CodeBuddy')
    }
    if (state.scope?.kind === 'specialist') {
      const allowed = new Set(state.scope.frameworkNames)
      catalog = catalog.filter((skill) => allowed.has(skill.name))
    }
    if (catalog.length === 0) return []
    try {
      let selected = await codebuddy.selectSkills(
        input.selectionText,
        catalog,
        codebuddy.signal,
        codebuddy.observeUsage
      )
      if (!selected) return []
      // A valid empty response can still be a semantic false negative. CodeBuddy has no native
      // Skill discovery fallback, so require a second independent empty verdict before continuing.
      if (selected.length === 0 && !codebuddy.signal?.aborted) {
        selected = await codebuddy.selectSkills(
          `${input.selectionText}\n\n<open_science_skill_route_verification>The first routing pass selected no Skill. Re-evaluate the catalog specifically for any capability that could materially help execute the request; keep the selection empty only when none applies.</open_science_skill_route_verification>`,
          catalog,
          codebuddy.signal,
          codebuddy.observeUsage
        )
        if (!selected) return []
      }
      const offered = new Set(catalog.map((skill) => `${skill.name}\u0000${skill.path}`))
      if (selected.some((skill) => !offered.has(`${skill.name}\u0000${skill.path}`))) {
        return this.selectionFailed('selector-error', 'CodeBuddy')
      }
      return selected.map(({ name }) => name)
    } catch {
      return this.selectionFailed('selector-error', 'CodeBuddy')
    }
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
      return this.selectionFailed('catalog-error', 'Codex')
    }
    if (state.scope?.kind === 'specialist') {
      const allowed = new Set(state.scope.frameworkNames)
      catalog = catalog.filter((skill) => allowed.has(skill.name))
    }
    if (catalog.length === 0) return []
    try {
      const selected = codex.observeUsage
        ? await codex.selectSkills(input.selectionText, catalog, codex.signal, codex.observeUsage)
        : await codex.selectSkills(input.selectionText, catalog, codex.signal)
      if (!selected) return []
      const offered = new Set(catalog.map((skill) => `${skill.name}\u0000${skill.path}`))
      return selected.filter((skill) => offered.has(`${skill.name}\u0000${skill.path}`))
    } catch {
      return this.selectionFailed('selector-error', 'Codex')
    }
  }
  private selectionFailed(
    reason: 'catalog-error' | 'selector-error' | 'document-error',
    framework: 'Codex' | 'CodeBuddy'
  ): [] {
    log.warn(`${framework} Skill selection failed`, { reason })
    if (framework === 'CodeBuddy') {
      throw new Error(`CodeBuddy Skill routing failed (${reason}).`)
    }
    return []
  }
}

const followUpPromptText = (presented: { text: string; skillScopeGuidance?: string }): string =>
  presented.skillScopeGuidance
    ? `${presented.skillScopeGuidance}\n\n${presented.text}`
    : presented.text

export { AcpTurnSkillOwner, codeBuddySkillRuntimeRoot, followUpPromptText }
export type { AcpTurnSkillHooks, TurnSkillHandle, TurnSkillOutcome }
