import { describe, expect, it } from 'vitest'

import {
  PRE_REGISTERED_PERMISSION_IDENTITIES,
  PRE_REGISTERED_PERMISSION_IDENTITY_COUNT
} from './identity-catalog'

describe('permission identity catalog', () => {
  it('contains the closed 36-identity v1 bootstrap inventory', () => {
    expect(PRE_REGISTERED_PERMISSION_IDENTITY_COUNT).toBe(36)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.builtin_tool).toEqual([])
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.customize_mutation).toHaveLength(8)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool).toHaveLength(19)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.execution).toHaveLength(2)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.file_operation).toHaveLength(6)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.skill_operation).toHaveLength(1)
  })

  it('admits both Session Plan capabilities to remembered permission scopes', () => {
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool).toEqual(
      expect.arrayContaining([
        'mcp:open-science-plan/generate_plan',
        'mcp:open-science-plan/update_step_status',
        'mcp:open-science-literature/read_document'
      ])
    )
  })

  it('does not expose internal Reviewer MCP identities', () => {
    expect(JSON.stringify(PRE_REGISTERED_PERMISSION_IDENTITIES)).not.toMatch(/review/i)
  })
})
