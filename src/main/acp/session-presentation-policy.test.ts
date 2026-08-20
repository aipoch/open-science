import { describe, expect, it, vi } from 'vitest'

import { claudeCodeFramework } from '../agent-framework/claude-code'
import { codexFramework } from '../agent-framework/codex'
import { opencodeFramework } from '../agent-framework/opencode'
import { NOTEBOOK_SYSTEM_PROMPT_APPEND } from '../notebook/mcp-server'
import { SKILL_IMPORT_SYSTEM_PROMPT_APPEND } from '../skills/mcp-server'
import { AcpSessionPresentationPolicy } from './session-presentation-policy'

const TURN_CONTINUITY_APPEND = [
  '<open_science_turn_continuity_instructions>',
  'Do not describe a tool-backed action as future work and then end the turn. If you say you will download, install, run, edit, analyze, or otherwise perform an action that needs a tool, issue the corresponding tool call in this same turn.',
  'If a required tool cannot be used or its operation fails, do not promise another attempt. Clearly state that the turn has stopped, what prevented progress, and what the user can do next.',
  '</open_science_turn_continuity_instructions>'
].join('\n')

const LARGE_DATA_FILE_APPEND = [
  '<open_science_large_file_instructions>',
  'Large attached data files (CSV, TSV, TXT, JSON, FASTA/FASTQ, VCF, and similar tabular or text data) are provided as a file reference plus a short preview, not as full inline content.',
  'Never read, cat, or print such a file in its entirety — a single large read can exceed the request-size limit and break the conversation.',
  'Inspect structure first (columns, row count, a few sample rows), then read only the specific line ranges, rows, or columns you need.',
  'To analyze, filter, or aggregate over a large file, load it in the notebook (e.g. pandas) and compute there instead of reading its contents into the conversation.',
  '</open_science_large_file_instructions>'
].join('\n')

const ARTIFACT_FILE_APPEND = [
  '<open_science_artifact_instructions>',
  'When this turn creates or saves local user-facing files such as images, documents, reports, data exports, XML, SVG, HTML, CSV, PDF, or archives, you MUST save them through the MCP tool `write_artifact_file` from the `open-science-artifacts` server.',
  'When a Connector or MCP tool creates or returns a user-facing file, call `write_artifact_file` in the same turn before telling the user that the result is available.',
  'Do not save generated user-facing files directly into the workspace or current directory unless the user explicitly asks to modify project files.',
  'Pass the filename, MIME type, and either inline content or a local source path to `write_artifact_file`; the app assigns the project, session, Artifact run, and final message location.',
  'If a Notebook, REPL, or shell execution produced the file, also pass `producerRunId` with the exact `runId` returned by the execution that created or last modified it. Omit `producerRunId` only when no Notebook execution produced the file; never use the Artifact run ID as the producer.',
  'Only claim a generated file is available after `write_artifact_file` succeeds. If it fails or is denied, state that the local file may exist but was not saved as an Artifact, and do not present it as downloadable.',
  'After using the tool, mention the generated filename rather than an absolute filesystem path. The app will display the generated file list below your message.',
  'Never write files inside a skill directory — loaded skills are read-only; route any file a skill generates through `write_artifact_file`.',
  '</open_science_artifact_instructions>'
].join('\n')

describe('ACP Session presentation policy', () => {
  const policy = new AcpSessionPresentationPolicy()

  it('returns the exact application appends in stable order when every tool is available', () => {
    const appends = policy.applicationSystemPromptAppends({
      artifacts: true,
      notebook: true,
      skillImport: true
    })

    expect(appends).toEqual([
      TURN_CONTINUITY_APPEND,
      LARGE_DATA_FILE_APPEND,
      ARTIFACT_FILE_APPEND,
      NOTEBOOK_SYSTEM_PROMPT_APPEND,
      SKILL_IMPORT_SYSTEM_PROMPT_APPEND
    ])
    expect(Object.isFrozen(appends)).toBe(true)
  })

  it('keeps unconditional guidance while omitting unavailable tooling and Skill privacy text', () => {
    const appends = policy.applicationSystemPromptAppends({
      artifacts: false,
      notebook: false,
      skillImport: false
    })

    expect(appends).toEqual([TURN_CONTINUITY_APPEND, LARGE_DATA_FILE_APPEND])
    expect(appends.join('\n\n')).not.toContain('<open_science_skill_privacy_instructions>')
  })

  it('builds immutable Claude Session metadata in exact append order and fails closed on Skills', () => {
    const presentation = policy.buildSessionSetup({
      framework: claudeCodeFramework,
      tooling: { artifacts: false, notebook: false, skillImport: false },
      backendSystemPromptAppends: ['Backend connector guidance.'],
      extraSystemPromptAppends: ['Specialist identity.'],
      sessionOptions: { plugins: [{ type: 'local', path: '/app/claude' }] },
      specialistSkills: { kind: 'unavailable', reason: 'disabled' }
    })
    const exactAppend = [
      TURN_CONTINUITY_APPEND,
      LARGE_DATA_FILE_APPEND,
      'Backend connector guidance.',
      'Specialist identity.'
    ].join('\n\n')

    expect(presentation).toEqual({
      metaArg: {
        _meta: {
          claudeCode: {
            emitRawSDKMessages: [{ type: 'assistant' }, { type: 'result' }],
            options: {
              tools: { type: 'preset', preset: 'claude_code' },
              plugins: [{ type: 'local', path: '/app/claude' }],
              settingSources: ['user'],
              disallowedTools: [
                'Agent',
                'Task',
                'Workflow',
                'SendMessage',
                'TeamCreate',
                'TeamDelete'
              ],
              managedSettings: {
                disableAgentView: true,
                disableWorkflows: true,
                workflowKeywordTriggerEnabled: false
              },
              env: {
                CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
                CLAUDE_CODE_DISABLE_WORKFLOWS: '1'
              },
              skills: []
            }
          },
          systemPrompt: { type: 'preset', preset: 'claude_code', append: exactAppend }
        }
      },
      persistentSystemPrompt: exactAppend
    })
    expect(Object.isFrozen(presentation)).toBe(true)
    expect(Object.isFrozen(presentation.metaArg)).toBe(true)
    expect(Object.isFrozen(presentation.metaArg._meta)).toBe(true)
  })

  it('grants an explicit Skill runtime scope only on primary Session setup', () => {
    const buildSessionSetup = vi.fn(() => ({}))
    const framework = { id: 'claude-code' as const, buildSessionSetup }
    const baseInput = {
      framework,
      tooling: { artifacts: false, notebook: false, skillImport: false }
    }

    policy.buildSessionSetup(baseInput)
    expect(buildSessionSetup).toHaveBeenLastCalledWith(
      expect.objectContaining({ skillRuntimeScope: 'all' })
    )

    policy.buildSessionSetup({
      ...baseInput,
      specialistSkills: {
        kind: 'specialist',
        skillIds: ['literature-review'],
        frameworkNames: ['literature-review'],
        missingSkillIds: []
      }
    })
    expect(buildSessionSetup).toHaveBeenLastCalledWith(
      expect.objectContaining({
        skillWhitelist: ['literature-review'],
        skillRuntimeScope: ['literature-review']
      })
    )

    policy.buildSessionSetup({
      ...baseInput,
      specialistSkills: { kind: 'unavailable', reason: 'disabled' }
    })
    expect(buildSessionSetup).toHaveBeenLastCalledWith(
      expect.objectContaining({ skillWhitelist: [], skillRuntimeScope: [] })
    )
  })

  it('excludes stable appends installed persistently but preserves one-off Session appends', () => {
    expect(
      policy.buildSessionSetup({
        framework: codexFramework,
        tooling: { artifacts: true, notebook: true, skillImport: true },
        backendSystemPromptAppends: ['Already installed by the backend.'],
        extraSystemPromptAppends: ['One-off Session guidance.'],
        persistentSystemPrompt: 'Baked Codex developer instructions.'
      })
    ).toEqual({
      metaArg: {},
      promptPrefix: 'One-off Session guidance.',
      persistentSystemPrompt: 'Baked Codex developer instructions.'
    })
  })

  it('returns exact immutable Session append and turn prefix text for a Specialist identity', () => {
    const profile = {
      name: 'RNA-seq Reviewer',
      systemPrompt: '  Focus on batch effects and QC.  '
    }
    const append = [
      '[open-science:specialist-identity]',
      '# Specialist identity — RNA-seq Reviewer',
      '',
      '> The following overrides the Main Agent general identity description for this session.',
      '> App safety rules, tool rules, and workflow instructions still apply and are not replaced.',
      '',
      'Focus on batch effects and QC.'
    ].join('\n')
    const prefix = [
      '[open-science:specialist-identity]',
      '[Specialist: RNA-seq Reviewer]',
      '(This overrides the Main Agent identity for this session.',
      ' App safety rules, tool rules, and workflow instructions still apply.)',
      '',
      'Focus on batch effects and QC.',
      '',
      '---',
      ''
    ].join('\n')

    const claudeIdentity = policy.specialistIdentity('claude-code', profile)
    const codexIdentity = policy.specialistIdentity('codex', profile)
    const opencodeIdentity = policy.specialistIdentity('opencode', profile)

    expect(claudeIdentity).toEqual({ append, prefix: '' })
    expect(codexIdentity).toEqual({ append: '', prefix })
    expect(opencodeIdentity).toEqual(codexIdentity)
    expect(Object.isFrozen(claudeIdentity)).toBe(true)
    expect(Object.isFrozen(codexIdentity)).toBe(true)
  })

  it('orders the OpenCode Specialist identity before exact per-turn Skill guidance', () => {
    expect(
      policy.buildTurnPromptPrefix({
        framework: opencodeFramework,
        tooling: { artifacts: false, notebook: false, skillImport: false },
        persistentSystemPrompt: 'Baked OpenCode instructions.',
        specialistPrefix: 'Specialist identity prefix.',
        specialistSkills: {
          kind: 'specialist',
          skillIds: ['research', 'pubmed'],
          frameworkNames: ['Research', 'mcp-pubmed'],
          missingSkillIds: []
        }
      })
    ).toBe(
      [
        'Specialist identity prefix.',
        'Allowed Specialist Skills for this session:\n- Research\n- mcp-pubmed'
      ].join('\n\n')
    )
  })

  it('uses the same per-turn prefix contract for Codex and no Specialist reminder for Claude', () => {
    const specialistSkills = {
      kind: 'specialist' as const,
      skillIds: ['research'],
      frameworkNames: ['Research'],
      missingSkillIds: []
    }
    const tooling = { artifacts: false, notebook: false, skillImport: false }

    expect(
      policy.buildTurnPromptPrefix({
        framework: codexFramework,
        tooling,
        persistentSystemPrompt: 'Baked Codex instructions.',
        specialistPrefix: 'Codex Specialist identity.',
        specialistSkills
      })
    ).toBe('Codex Specialist identity.\n\nAllowed Specialist Skills for this session:\n- Research')
    expect(
      policy.buildTurnPromptPrefix({
        framework: claudeCodeFramework,
        tooling,
        specialistSkills
      })
    ).toBeUndefined()
  })

  it.each([
    ['OpenCode', opencodeFramework],
    ['Codex Responses', codexFramework],
    ['Codex Bridge', codexFramework]
  ] as const)(
    'keeps the %s Session setup prefix after Specialist identity on every turn',
    (_route, framework) => {
      expect(
        policy.buildTurnPromptPrefix({
          framework,
          tooling: { artifacts: false, notebook: false, skillImport: false },
          specialistPrefix: 'Specialist identity.',
          sessionSetupPromptPrefix: 'Project Agent Context.'
        })
      ).toBe('Specialist identity.\n\nProject Agent Context.')
    }
  )

  it('does not repeat a launcher prefix that is identical during Session setup and turn setup', () => {
    expect(
      policy.buildTurnPromptPrefix({
        framework: {
          ...codexFramework,
          buildSessionSetup: () => ({ promptPrefix: 'Framework guidance.' })
        },
        tooling: { artifacts: false, notebook: false, skillImport: false },
        sessionSetupPromptPrefix: 'Framework guidance.'
      })
    ).toBe('Framework guidance.')
  })

  it('renders exact Specialist handoff continuation text from the original request and result', () => {
    expect(
      policy.continuationText({
        text: 'Analyze the dataset.',
        continuation: {
          kind: 'specialist-handoff',
          originatingTurnToken: 'turn-1',
          targetName: 'Data Analyst',
          completion: { kind: 'returned', value: { rows: 42 } }
        }
      })
    ).toBe(
      [
        'Continue the original user task as Data Analyst. Do not repeat work already shown before the handoff.',
        'Original user request:\nAnalyze the dataset.',
        'Captured outer tool result:\n{"rows":42}'
      ].join('\n\n')
    )
  })

  it('renders Main Agent and thrown handoff outcomes without reinterpreting the error', () => {
    expect(
      policy.continuationText({
        text: 'Continue the analysis.',
        continuation: {
          kind: 'specialist-handoff',
          originatingTurnToken: 'turn-2',
          targetName: null,
          completion: { kind: 'threw', errorMessage: 'switch failed' }
        }
      })
    ).toBe(
      [
        'Continue the original user task as Main Agent. Do not repeat work already shown before the handoff.',
        'Original user request:\nContinue the analysis.',
        'Captured outer tool error:\nswitch failed'
      ].join('\n\n')
    )
  })

  it('preserves current handoff text when a returned value has no JSON representation', () => {
    expect(
      policy.continuationText({
        text: 'Continue the analysis.',
        continuation: {
          kind: 'specialist-handoff',
          originatingTurnToken: 'turn-3',
          targetName: null,
          completion: { kind: 'returned', value: Symbol('result') }
        }
      })
    ).toContain('Captured outer tool result:\nundefined')
  })

  it('keeps Codex Skill paths in immutable private inputs without changing prompt text', () => {
    const presentation = policy.presentTurnSkills({
      frameworkId: 'codex',
      text: 'Summarize the paper.',
      skillNames: ['Research'],
      codexSkillInputs: [{ name: 'research', path: '/data/codex/skills/os-research/SKILL.md' }]
    })

    expect(presentation).toEqual({
      text: 'Summarize the paper.',
      codexSkillInputs: [{ name: 'research', path: '/data/codex/skills/os-research/SKILL.md' }]
    })
    expect(presentation.text).not.toContain('/data/codex')
    expect(Object.isFrozen(presentation)).toBe(true)
    expect(Object.isFrozen(presentation.codexSkillInputs)).toBe(true)
    expect(Object.isFrozen(presentation.codexSkillInputs[0])).toBe(true)
  })

  it.each(['claude-code', 'opencode'] as const)(
    'nudges %s with resolved Skill names and discards Codex-only inputs',
    (frameworkId) => {
      expect(
        policy.presentTurnSkills({
          frameworkId,
          text: 'Summarize the paper.',
          skillNames: ['Research', 'My Skill'],
          codexSkillInputs: [{ name: 'private', path: '/data/codex/skills/private/SKILL.md' }]
        })
      ).toEqual({
        text: 'Use the following skill(s) for this task: Research, My Skill.\n\nSummarize the paper.',
        codexSkillInputs: []
      })
    }
  )
})
