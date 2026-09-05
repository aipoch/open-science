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
  it('keeps the app MCP inventory aligned with the remembered-permission catalog', () => {
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool.toSorted()).toEqual(
      appMcpToolIdentities()
        .map((identity) => `mcp:${identity}`)
        .toSorted()
    )
  })

  it('documents generation, recovery, and approval without repeating the tool schema', () => {
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'generation supplies all four Plan fields (`task_summary`, `phases`, `desired_outputs`, and `feasibility`) in one call'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'call `generate_plan` again with only `decision: "approved"` or `decision: "rejected"`'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'Never call `update_step_status` while approval is pending'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).not.toContain(
      'delegations: [{ name, steps: [{ title, description }] }]'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).not.toContain(
      'verify that no phase, delegation, or step is only partially shaped'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('repair each reported path')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('do not repeat an unchanged invalid call')
  })

  it('keeps Plan-first guidance focused on turn-specific preparation', () => {
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).toContain('Plan mode (ACTIVE')
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).toContain('Review the Skills available')
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).toContain('Assess feasibility')
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).toContain('Clarify requirements')
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).toContain('Identify desired outputs')
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).toContain('complete revised plan')
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).not.toContain(
      'The plan is presented to the user for review'
    )
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).not.toContain('Only after the user approves the plan')
    expect(PLAN_FIRST_TURN_PROMPT_REMINDER).not.toContain(
      'Do NOT run code without an approved plan'
    )
  })

  it('states the feedback-to-decision policy once in stable Plan guidance', () => {
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND.match(/kind: feedback/g)).toHaveLength(1)
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'for ambiguous or conditional language, do not infer a decision'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('is active Plan context')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain('current durable Message Branch')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).not.toContain('execution authority')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).not.toContain('bind it to the current interaction')
  })

  it('defines when later Messages replace or continue an approved Plan', () => {
    const ownershipRule =
      'The originating Conversation Turn retains ownership of the Plan; related later ordinary or application Attempts on the same durable Message Branch receive it only as active context.'
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(ownershipRule)
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'The latest explicit user Message takes precedence over the active Plan. Treat application Messages as contextual events and judge how they relate to the approved steps without letting them override user intent.'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'If it changes the goal, desired outputs, risks, or material scope, generate a replacement Plan revision and wait for approval before doing the changed work.'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'Routine execution details and progress updates within the approved scope do not require another approval.'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND.indexOf(ownershipRule)).toBeLessThan(
      SESSION_PLAN_SYSTEM_PROMPT_APPEND.indexOf(
        'The latest explicit user Message takes precedence over the active Plan. Treat application Messages as contextual events and judge how they relate to the approved steps without letting them override user intent.'
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
      expect(guidance).toContain('discover applicable skills before generating')
      expect(guidance).toContain(generateTool)
      expect(guidance).toContain(updateTool)
      expect(guidance).toContain('repair each reported path')
      expect(guidance).not.toContain('delegations: [{ name, steps:')
      expect(guidance).toContain('not for simple lookups')
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
