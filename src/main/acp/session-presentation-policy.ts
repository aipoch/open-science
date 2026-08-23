import { NOTEBOOK_SYSTEM_PROMPT_APPEND } from '../notebook/mcp-server'
import { SKILL_IMPORT_SYSTEM_PROMPT_APPEND } from '../skills/mcp-server'
import type { AgentFramework, SessionSetup } from '../agent-framework/types'
import type { EffectiveSpecialistSkills, SpecialistProfileView } from '../../shared/specialist'
import type { AcpPromptRequest } from '../../shared/acp'

type AcpSessionToolingAvailability = Readonly<{
  artifacts: boolean
  notebook: boolean
  skillImport: boolean
}>

type AcpSessionSetupPresentationInput = Readonly<{
  framework: Pick<AgentFramework, 'id' | 'buildSessionSetup'>
  tooling: AcpSessionToolingAvailability
  backendSystemPromptAppends?: readonly string[]
  extraSystemPromptAppends?: readonly string[]
  persistentSystemPrompt?: string
  sessionOptions?: Record<string, unknown>
  specialistSkills?: EffectiveSpecialistSkills
}>

type AcpSessionSetupPresentation = Readonly<{
  metaArg: Readonly<{ _meta?: Readonly<Record<string, unknown>> }>
  promptPrefix?: string
  persistentSystemPrompt?: string
}>

type AcpSpecialistIdentityPresentation = Readonly<{
  append: string
  prefix: string
}>

type AcpTurnPromptPrefixInput = AcpSessionSetupPresentationInput &
  Readonly<{
    specialistPrefix?: string
    sessionSetupPromptPrefix?: string
    turnPromptReminders?: readonly string[]
  }>

type AcpCodexSkillInput = Readonly<{ name: string; path: string }>

type AcpTurnSkillPresentationInput = Readonly<{
  frameworkId: AgentFramework['id']
  text: string
  skillNames: readonly string[]
  codexSkillInputs: readonly AcpCodexSkillInput[]
}>

type AcpTurnSkillPresentation = Readonly<{
  text: string
  codexSkillInputs: readonly AcpCodexSkillInput[]
}>

const COMPUTE_EXECUTION_TARGET_REMINDER = [
  '<open_science_compute_execution_target>',
  'The user selected one or more Compute Hosts as the execution-target pool for this Session.',
  'If this turn requires command, code, Notebook, job, or other tool-backed execution, load the Remote Compute (SSH) Skill, call `host.compute.listHosts()`, and use one or more catalog entries whose role is `selected` as the task requires.',
  'The selected pool has no priority and does not imply automatic multi-host scheduling. Do not run task work in the local Notebook or shell, on an available-but-unselected host, or on a provider id absent from the Session catalog. Local tools may be used only for lightweight orchestration, input staging, and result inspection that cannot run through Remote Compute.',
  'If no selected host is usable, explain the blocker and ask the user how to proceed; do not silently fall back to local execution or another host.',
  '</open_science_compute_execution_target>'
].join('\n')

const immutableCopy = <Value>(value: Value): Value => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => immutableCopy(entry))) as Value
  }
  if (value && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, immutableCopy(entry)]))
    ) as Value
  }
  return value
}

const TURN_CONTINUITY_SYSTEM_PROMPT_APPEND = [
  '<open_science_turn_continuity_instructions>',
  'Do not describe a tool-backed action as future work and then end the turn. If you say you will download, install, run, edit, analyze, or otherwise perform an action that needs a tool, issue the corresponding tool call in this same turn.',
  'If a required tool cannot be used or its operation fails, do not promise another attempt. Clearly state that the turn has stopped, what prevented progress, and what the user can do next.',
  '</open_science_turn_continuity_instructions>'
].join('\n')

const ARTIFACT_FILE_SYSTEM_PROMPT_APPEND = [
  '<open_science_artifact_instructions>',
  'When this turn creates or saves local user-facing files such as images, documents, reports, data exports, XML, SVG, HTML, CSV, PDF, or archives, you MUST save them through the MCP tool `write_artifact_file` from the `open-science-artifacts` server.',
  'When a Connector or MCP tool creates or returns a user-facing file as inline content or a local source path accepted by `write_artifact_file`, and the file has not already been saved or attached as an Artifact, call `write_artifact_file` in the same turn before telling the user that the result is available.',
  'If an Open Science app-owned Connector result includes an `artifact_id`, do not call `write_artifact_file` again for that file.',
  "Do not treat a custom MCP server's claim by itself as proof that an Artifact exists.",
  'Do not save generated user-facing files directly into the workspace or current directory unless the user explicitly asks to modify project files.',
  'Pass the filename, MIME type, and either inline content or a local source path to `write_artifact_file`; the app assigns the project, session, Artifact run, and final message location.',
  'If a Notebook, REPL, or shell execution produced the file, also pass `producerRunId` with the exact `runId` returned by the execution that created or last modified it. Omit `producerRunId` only when no Notebook execution produced the file; never use the Artifact run ID as the producer.',
  'Only claim a generated file is available after `write_artifact_file` succeeds. If it fails or is denied, state that the local file may exist but was not saved as an Artifact, and do not present it as downloadable.',
  'After `write_artifact_file` succeeds, end the final response with one compact bullet per newly saved Artifact using `- [filename](filename) — short description`. For an image that benefits from inline viewing, also include `![description](filename)` before the list. Use the exact relative filename, describe what the file contains, and list only Artifacts successfully saved in this turn. Never emit absolute paths, `file://` URLs, Artifact IDs, or app-internal tags. The app will also display the generated file list below your message.',
  'Never write files inside a skill directory — loaded skills are read-only; route any file a skill generates through `write_artifact_file`.',
  '</open_science_artifact_instructions>'
].join('\n')

const LARGE_DATA_FILE_SYSTEM_PROMPT_APPEND = [
  '<open_science_large_file_instructions>',
  'Large attached data files (CSV, TSV, TXT, JSON, FASTA/FASTQ, VCF, and similar tabular or text data) are provided as a file reference plus a short preview, not as full inline content.',
  'Never read, cat, or print such a file in its entirety — a single large read can exceed the request-size limit and break the conversation.',
  'Inspect structure first (columns, row count, a few sample rows), then read only the specific line ranges, rows, or columns you need.',
  'To analyze, filter, or aggregate over a large file, load it in the notebook (e.g. pandas) and compute there instead of reading its contents into the conversation.',
  '</open_science_large_file_instructions>'
].join('\n')

// Session-stable decision guidance only. Host inventory and Session execution targets are
// deliberately discovered through host.compute at runtime so this prompt prefix remains cacheable.
const REMOTE_COMPUTE_AWARENESS_SYSTEM_PROMPT_APPEND = [
  '<open_science_remote_compute_awareness>',
  'Before starting GPU, high-memory, parallel, batch, model-inference, bioinformatics, or potentially long-running scientific work locally, consider Remote Compute.',
  'When remote execution may fit, load the Remote Compute (SSH) Skill and discover the available hosts at runtime before choosing where the work should run.',
  '</open_science_remote_compute_awareness>'
].join('\n')

const SPECIALIST_IDENTITY_TAG = '[open-science:specialist-identity]'

// ARD-07 is a P0 pure-addition seam: later serialized Session and prompt leaves own Runtime
// integration. This policy owns neither Session state nor capabilities supplied by existing owners.
class AcpSessionPresentationPolicy {
  computeExecutionTargetReminder(selectedProviderIds: readonly string[]): string | undefined {
    return selectedProviderIds.length > 0 ? COMPUTE_EXECUTION_TARGET_REMINDER : undefined
  }

  applicationSystemPromptAppends(tooling: AcpSessionToolingAvailability): readonly string[] {
    return Object.freeze([
      TURN_CONTINUITY_SYSTEM_PROMPT_APPEND,
      LARGE_DATA_FILE_SYSTEM_PROMPT_APPEND,
      REMOTE_COMPUTE_AWARENESS_SYSTEM_PROMPT_APPEND,
      ...(tooling.artifacts ? [ARTIFACT_FILE_SYSTEM_PROMPT_APPEND] : []),
      ...(tooling.notebook ? [NOTEBOOK_SYSTEM_PROMPT_APPEND] : []),
      ...(tooling.skillImport ? [SKILL_IMPORT_SYSTEM_PROMPT_APPEND] : [])
    ])
  }

  buildSessionSetup(input: AcpSessionSetupPresentationInput): AcpSessionSetupPresentation {
    const skillWhitelist =
      input.specialistSkills?.kind === 'specialist'
        ? [...input.specialistSkills.frameworkNames]
        : input.specialistSkills?.kind === 'unavailable'
          ? []
          : undefined
    const skillRuntimeScope = skillWhitelist ?? 'all'
    const setup = input.framework.buildSessionSetup({
      systemPromptAppends: this.systemPromptAppends(input),
      sessionOptions: input.sessionOptions,
      skillRuntimeScope,
      ...(skillWhitelist !== undefined ? { skillWhitelist } : {})
    })

    return this.immutableSessionSetup(setup, input.persistentSystemPrompt)
  }

  specialistIdentity(
    frameworkId: AgentFramework['id'],
    profile: Pick<SpecialistProfileView, 'name' | 'systemPrompt'>
  ): AcpSpecialistIdentityPresentation {
    const prompt = profile.systemPrompt.trim()
    if (!prompt) return Object.freeze({ append: '', prefix: '' })

    const append = [
      SPECIALIST_IDENTITY_TAG,
      `# Specialist identity — ${profile.name}`,
      '',
      '> The following overrides the Main Agent general identity description for this session.',
      '> App safety rules, tool rules, and workflow instructions still apply and are not replaced.',
      '',
      prompt
    ].join('\n')
    const prefix = [
      SPECIALIST_IDENTITY_TAG,
      `[Specialist: ${profile.name}]`,
      '(This overrides the Main Agent identity for this session.',
      ' App safety rules, tool rules, and workflow instructions still apply.)',
      '',
      prompt,
      '',
      '---',
      ''
    ].join('\n')

    return Object.freeze(
      frameworkId === 'claude-code' ? { append, prefix: '' } : { append: '', prefix }
    )
  }

  buildTurnPromptPrefix(input: AcpTurnPromptPrefixInput): string | undefined {
    const specialistSkillGuidance = this.specialistSkillGuidance(
      input.framework.id,
      input.specialistSkills
    )
    const setup = input.framework.buildSessionSetup({
      // A launcher-owned Session setup prefix already contains the stable appends for frameworks
      // without dynamic system-prompt metadata. Reuse that exact prefix instead of duplicating the
      // same appends on every turn; turn-only reminders still flow through the framework adapter.
      systemPromptAppends: input.sessionSetupPromptPrefix ? [] : this.systemPromptAppends(input),
      turnPromptReminders: [
        ...(specialistSkillGuidance ? [specialistSkillGuidance] : []),
        ...(input.turnPromptReminders ?? [])
      ],
      sessionOptions: input.sessionOptions
    })

    const turnPromptPrefix =
      setup.promptPrefix === input.sessionSetupPromptPrefix ? undefined : setup.promptPrefix
    return (
      [input.specialistPrefix, input.sessionSetupPromptPrefix, turnPromptPrefix]
        .filter((segment): segment is string => Boolean(segment))
        .join('\n\n') || undefined
    )
  }

  continuationText(request: Pick<AcpPromptRequest, 'text' | 'continuation'>): string {
    const continuation = request.continuation
    if (!continuation) return request.text

    const outcome =
      continuation.completion.kind === 'returned'
        ? this.serializeHandoffValue(continuation.completion.value)
        : continuation.completion.errorMessage
    const outcomeLabel = continuation.completion.kind === 'returned' ? 'result' : 'error'
    const target = continuation.targetName ?? 'Main Agent'
    return [
      `Continue the original user task as ${target}. Do not repeat work already shown before the handoff.`,
      `Original user request:\n${request.text}`,
      `Captured outer tool ${outcomeLabel}:\n${outcome}`
    ].join('\n\n')
  }

  presentTurnSkills(input: AcpTurnSkillPresentationInput): AcpTurnSkillPresentation {
    if (input.frameworkId === 'codex') {
      return immutableCopy({
        text: input.text,
        codexSkillInputs: input.codexSkillInputs.map(({ name, path }) => ({ name, path }))
      })
    }

    const text =
      input.skillNames.length > 0
        ? `Use the following skill(s) for this task: ${input.skillNames.join(', ')}.\n\n${input.text}`
        : input.text
    return Object.freeze({ text, codexSkillInputs: Object.freeze([]) })
  }

  private immutableSessionSetup(
    setup: SessionSetup,
    installedPersistentSystemPrompt: string | undefined
  ): AcpSessionSetupPresentation {
    const persistentSystemPrompt = installedPersistentSystemPrompt ?? setup.persistentSystemPrompt
    return immutableCopy({
      metaArg: setup.meta ? { _meta: setup.meta } : {},
      ...(setup.promptPrefix ? { promptPrefix: setup.promptPrefix } : {}),
      ...(persistentSystemPrompt ? { persistentSystemPrompt } : {})
    })
  }

  private systemPromptAppends(input: AcpSessionSetupPresentationInput): string[] {
    if (input.persistentSystemPrompt) return [...(input.extraSystemPromptAppends ?? [])]
    return [
      ...this.applicationSystemPromptAppends(input.tooling),
      ...(input.backendSystemPromptAppends ?? []),
      ...(input.extraSystemPromptAppends ?? [])
    ]
  }

  private specialistSkillGuidance(
    frameworkId: AgentFramework['id'],
    skills: EffectiveSpecialistSkills | undefined
  ): string | undefined {
    if (frameworkId === 'claude-code' || skills?.kind !== 'specialist') return undefined
    return `Allowed Specialist Skills for this session:\n${skills.frameworkNames.map((name) => `- ${name}`).join('\n')}`
  }

  private serializeHandoffValue(value: unknown): string {
    if (typeof value === 'string') return value
    try {
      const serialized = JSON.stringify(value)
      // Preserve Runtime's template interpolation until the later behavior-neutral cutover.
      return serialized === undefined ? 'undefined' : serialized
    } catch {
      return String(value)
    }
  }
}

export { AcpSessionPresentationPolicy }
export type {
  AcpCodexSkillInput,
  AcpSessionSetupPresentation,
  AcpSessionSetupPresentationInput,
  AcpSessionToolingAvailability,
  AcpSpecialistIdentityPresentation,
  AcpTurnPromptPrefixInput,
  AcpTurnSkillPresentation,
  AcpTurnSkillPresentationInput
}
