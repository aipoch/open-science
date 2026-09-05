import { describe, expect, it } from 'vitest'

import {
  PRE_REGISTERED_PERMISSION_IDENTITIES,
  PRE_REGISTERED_PERMISSION_IDENTITY_COUNT
} from './identity-catalog'

describe('permission identity catalog', () => {
  it('contains the closed 47-identity bootstrap inventory', () => {
    expect(PRE_REGISTERED_PERMISSION_IDENTITY_COUNT).toBe(47)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.builtin_tool).toEqual([])
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.customize_mutation).toHaveLength(8)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool).toHaveLength(30)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool).toContain(
      'mcp:open-science-notebook/request_network_access'
    )
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.execution).toHaveLength(2)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.file_operation).toHaveLength(6)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.skill_operation).toHaveLength(1)
  })

  it('admits memory queries without granting the memory write tool', () => {
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool).toEqual(
      expect.arrayContaining([
        'mcp:open-science-notebook/list_memory_categories',
        'mcp:open-science-notebook/search_memories'
      ])
    )
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool).not.toContain(
      'mcp:open-science-notebook/remember_memory'
    )
  })

  it('admits both Session Plan capabilities to remembered permission scopes', () => {
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool).toEqual(
      expect.arrayContaining([
        'mcp:open-science-plan/generate_plan',
        'mcp:open-science-plan/update_step_status',
        'mcp:open-science-library/search_library',
        'mcp:open-science-library/read_library_abstract',
        'mcp:open-science-library/read_library_pdf',
        'mcp:open-science-library/format_references',
        'mcp:open-science-library/format_citation_document',
        'mcp:open-science-library/prepare_latex_bundle',
        'mcp:open-science-library/save_to_inbox',
        'mcp:open-science-library/acquire_pdf',
        'mcp:open-science-literature/read_document'
      ])
    )
  })

  it('does not expose internal Reviewer MCP identities', () => {
    expect(JSON.stringify(PRE_REGISTERED_PERMISSION_IDENTITIES)).not.toMatch(/review/i)
  })
})
