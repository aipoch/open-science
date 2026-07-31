import { describe, expect, it } from 'vitest'

import {
  PRE_REGISTERED_PERMISSION_IDENTITIES,
  PRE_REGISTERED_PERMISSION_IDENTITY_COUNT
} from './identity-catalog'

describe('permission identity catalog', () => {
  it('contains the closed 32-identity v1 bootstrap inventory', () => {
    expect(PRE_REGISTERED_PERMISSION_IDENTITY_COUNT).toBe(32)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.builtin_tool).toEqual([])
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.customize_mutation).toHaveLength(8)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool).toHaveLength(15)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.execution).toHaveLength(2)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.file_operation).toHaveLength(6)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.skill_operation).toHaveLength(1)
  })

  it('does not expose internal Reviewer MCP identities', () => {
    expect(JSON.stringify(PRE_REGISTERED_PERMISSION_IDENTITIES)).not.toMatch(/review/i)
  })
})
