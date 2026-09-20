import { describe, expect, it } from 'vitest'

import { PRE_REGISTERED_PERMISSION_IDENTITIES } from '../permission-grants/identity-catalog'
import {
  PLAN_FIRST_TURN_PROMPT_REMINDER,
  SESSION_PLAN_SYSTEM_PROMPT_APPEND
} from '../session-plan/guidance'
import {
  appMcpToolIdentities,
  appMcpServerAliases,
  renderAppMcpToolReferences,
  resolveCanonicalMcpToolIdentity
} from './app-mcp-names'

const APP_MCP_CODEC_CASES = appMcpToolIdentities().flatMap((identity) => {
  const separator = identity.indexOf('/')
  const server = identity.slice(0, separator)
  const tool = identity.slice(separator + 1)
  const safeServer = server.replace(/[^a-zA-Z0-9_]/g, '_')
  return [
    [server, `mcp__${safeServer}__${tool}`, identity],
    [server, `mcp.${server}.${tool}`, identity],
    [server, `${safeServer}_${tool}`, identity]
  ] as const
})

describe('resolveCanonicalMcpToolIdentity', () => {
  it.each([
    ['claude-code', 'mcp__open-science-notebook__'],
    ['codebuddy', 'mcp__open_science_notebook__'],
    ['opencode', 'open_science_notebook_'],
    ['codex', '']
  ] as const)('renders the memory query references for %s', (frameworkId, prefix) => {
    expect(
      renderAppMcpToolReferences(frameworkId, 'Use list_memory_categories then search_memories.')
    ).toBe(`Use ${prefix}list_memory_categories then ${prefix}search_memories.`)
  })

  it('keeps the app MCP inventory aligned with the remembered-permission catalog', () => {
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool.toSorted()).toEqual(
      appMcpToolIdentities()
        .map((identity) => `mcp:${identity}`)
        .toSorted()
    )
  })

  it('documents preparation, generation, recovery, and approval in shared guidance', () => {
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('assess available data, methods, and tools')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('if low, ask whether the user wants')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'Clarify only unresolved choices that materially change'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('deliverables already specified')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'Generate `task_summary`, `phases`, `desired_outputs`, and `feasibility` together'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'call `generate_plan` with only `decision: "approved"` or `decision: "rejected"`'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'Never call `update_step_status` while approval is pending'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'coherent, independently verifiable work unit with a meaningful stopping point'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'a sequential, actionable description of one to three sentences'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'work, concrete deliverable or finding, and completion check'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'A revision must be complete and preserve unchanged phases, delegations, and steps.'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).not.toContain(
      'delegations: [{ name, steps: [{ title, description }] }]'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).not.toContain(
      'verify that no phase, delegation, or step is only partially shaped'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('repair each reported path')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('do not repeat an unchanged invalid call')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('whether submission completed is unknown')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'does not prove submission, approval, or Provider pause'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).not.toContain(
      'retains the pending Plan and pauses the Provider turn'
    )
  })

  it('keeps Plan-first guidance limited to its turn-specific mandate', () => {
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).toContain('Plan mode (ACTIVE')
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).toContain(
      'even if you would otherwise judge a Plan optional'
    )
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).toContain('wait for approval before execution starts')
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).not.toContain('Assess feasibility')
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).not.toContain('Clarify requirements')
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).not.toContain('desired_outputs')
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).not.toContain('complete revised Plan')
  })

  it('requires timely status updates only for observed step transitions', () => {
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'after work starts and when completion, irreversible blockage, or skipping is known'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('not per tool action')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'before moving to a later independent unit or ending the turn'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('promised check passes')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('result is available as agreed')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'Artifact publication is required only when that step promises it'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('delivery may be a separate step')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'Use skipped only for unnecessary work that has not started and whose dependencies are satisfied'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'A terminal-status no-op does not update notes'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'Waiting for user input or a pending external result pauses work without changing the step to blocked'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'do not force unfinished work into a terminal status merely to end the current turn'
    )
  })

  it('states the feedback-to-decision policy once in stable Plan guidance', () => {
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND.match(/kind: feedback/g)).toHaveLength(1)
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'for ambiguous or conditional language, do not infer a decision'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('is active Plan context')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('`lifecycle: approved` or `in_progress`')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('current durable Message Branch')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).not.toContain('execution authority')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).not.toContain('bind it to the current interaction')
  })

  it('defines when later Messages replace or continue an approved Plan', () => {
    const ownershipRule = 'The originating Conversation Turn owns the Plan'
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(ownershipRule)
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'The latest explicit user Message takes precedence. Treat application Messages as context for approved steps, never as overrides of user intent.'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'When an approved Plan needs revision, generate a complete replacement Plan and await approval before changed work'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'Changes to the goal, desired outputs, risks, or material scope require revision'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'A distinct replacement Plan supersedes the current Plan; it does not create multiple resumable Plans.'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'approved-scope execution details and progress do not'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND.indexOf(ownershipRule)).toBeLessThan(
      SESSION_PLAN_SYSTEM_PROMPT_APPEND.indexOf(
        'The latest explicit user Message takes precedence. Treat application Messages as context for approved steps, never as overrides of user intent.'
      )
    )
  })

  it('keeps Conversation Turn completion independent from Session Plan status', () => {
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).not.toContain('Do not call `end_turn`')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).not.toContain('do not end the turn')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'If an irreversible blocker makes later steps unreachable'
    )
  })

  it.each([
    [
      'claude-code',
      'mcp__open-science-plan__generate_plan',
      'mcp__open-science-plan__update_step_status'
    ],
    ['codex', 'generate_plan', 'update_step_status'],
    ['opencode', 'open_science_plan_generate_plan', 'open_science_plan_update_step_status']
  ] as const)(
    'renders the same planning policy with callable names for %s',
    (frameworkId, generateTool, updateTool) => {
      const guidance = renderAppMcpToolReferences(frameworkId, SESSION_PLAN_SYSTEM_PROMPT_APPEND)

      expect(guidance).toContain('genuinely multi-stage')
      expect(guidance).toContain('discover applicable skills')
      expect(guidance).toContain('if low, ask')
      expect(guidance).toContain('already specified')
      expect(guidance).toContain(generateTool)
      expect(guidance).toContain(updateTool)
      expect(guidance).toContain('repair each reported path')
      expect(guidance).toContain('independently verifiable work unit')
      expect(guidance).toContain('before moving to a later independent unit')
      expect(guidance).not.toContain('delegations: [{ name, steps:')
      expect(guidance).toContain('skip straightforward tasks')
      expect(guidance).not.toContain('get_active_plan')
      expect(guidance).not.toContain('Plan mode')
    }
  )

  it.each(['codex', 'claude-code', 'opencode'] as const)(
    'does not reinterpret the Host SDK sendFrameMessage method as an MCP tool for %s',
    (frameworkId) => {
      const guidance = "Use await host.sendFrameMessage('parent', message)."

      expect(renderAppMcpToolReferences(frameworkId, guidance)).toBe(guidance)
    }
  )

  it.each([
    'mcp__open-science-notebook__ask_user_question',
    'mcp.open-science-notebook.ask_user_question',
    'open_science_notebook_ask_user_question'
  ])('normalizes a configured user-choice alias %s', (reportedName) => {
    expect(resolveCanonicalMcpToolIdentity(reportedName, ['open-science-notebook'])).toBe(
      'open-science-notebook/ask_user_question'
    )
  })

  it.each([
    'mcp__open-science-notebook__notebook_execute',
    'mcp.open-science-notebook.notebook_execute',
    'open_science_notebook_notebook_execute'
  ])('normalizes a configured framework alias %s', (reportedName) => {
    expect(resolveCanonicalMcpToolIdentity(reportedName, ['open-science-notebook'])).toBe(
      'open-science-notebook/notebook_execute'
    )
  })

  it('does not turn an unregistered Claude MCP prefix into durable identity', () => {
    expect(
      resolveCanonicalMcpToolIdentity('mcp__reported-only__dangerous_tool', [])
    ).toBeUndefined()
  })

  it.each(APP_MCP_CODEC_CASES)(
    'maps every registered app MCP identity from %s using provider name %s',
    (server, reportedName, identity) => {
      expect(resolveCanonicalMcpToolIdentity(reportedName, [server])).toBe(identity)
    }
  )

  it('normalizes framework-safe aliases for configured dynamic servers', () => {
    expect(appMcpServerAliases('custom-server')).toEqual(['custom-server', 'custom_server'])
    expect(resolveCanonicalMcpToolIdentity('mcp__custom_server__lookup', ['custom-server'])).toBe(
      'custom-server/lookup'
    )
    expect(resolveCanonicalMcpToolIdentity('mcp.custom_server.lookup', ['custom-server'])).toBe(
      'custom-server/lookup'
    )
    expect(resolveCanonicalMcpToolIdentity('custom_server_lookup', ['custom-server'])).toBe(
      'custom-server/lookup'
    )
  })

  it('rejects a sanitized dynamic server alias when configured names collide', () => {
    expect(
      resolveCanonicalMcpToolIdentity('mcp__custom_server__lookup', [
        'custom-server',
        'custom_server'
      ])
    ).toBeUndefined()
  })
})
