import { describe, it, expect } from 'vitest'
import { CONNECTOR_CATALOG } from '@aipoch/connector-builtins/catalog'
import {
  getConnectorTools,
  getDescriptor,
  validateToolArguments,
  ALL_CONNECTOR_IDS
} from './registry'
import { renderSkillDoc } from './skill-doc'

describe('builtin registry host integration', () => {
  it('retains application recovery guidance around package schema errors', () => {
    const tool = getDescriptor('chembl', 'get_assay')!
    expect(() => validateToolArguments(tool, {})).toThrow(
      new Error(
        'connector call rejected: invalid_arguments. Invalid tool arguments for chembl/get_assay: field "assay_chembl_id" is required. Correct the arguments to match the Input schema in the loaded mcp-chembl Skill, then retry the same method once. Do not retry unchanged or bypass host.mcp.'
      )
    )
    expect(() => validateToolArguments({ ...tool }, {})).toThrow(
      new Error('unregistered tool descriptor: chembl/get_assay')
    )
  })

  it('registers every configured builtin exactly once', () => {
    expect([...ALL_CONNECTOR_IDS].sort()).toEqual(CONNECTOR_CATALOG.map((entry) => entry.id).sort())
    const tools = ALL_CONNECTOR_IDS.flatMap(getConnectorTools)
    expect(new Set(tools.map((tool) => `${tool.connector}/${tool.id}`)).size).toBe(tools.length)
  })
  it.each(CONNECTOR_CATALOG)(
    'projects $id public contracts into the application Skill',
    (connector) => {
      const doc = renderSkillDoc(connector.id)
      expect(doc).toContain(`name: mcp-${connector.id}`)
      for (const tool of getConnectorTools(connector.id)) {
        expect(doc).toContain(`### ${tool.id}`)
        expect(doc).toContain(tool.description)
        expect(doc).toContain(tool.returns)
        expect(doc).toContain(tool.example)
        expect(doc).toContain(JSON.stringify(tool.input))
      }
    }
  )
})
