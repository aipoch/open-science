import { describe, it, expect } from 'vitest'
import { CONNECTOR_CATALOG } from './catalog'
import {
  getConnectorTools,
  getDescriptor,
  validateToolArguments,
  ALL_CONNECTOR_IDS
} from './registry'
import { renderSkillDoc } from './skill-doc'

describe('builtin registry host integration', () => {
  it('routes scientific APIs through native descriptors and keeps analysis outside the connector surface', () => {
    for (const id of ['research-datasets', 'europepmc', 'chea3', 'biodbnet', 'ctd']) {
      expect(ALL_CONNECTOR_IDS).toContain(id)
      expect(CONNECTOR_CATALOG.find((entry) => entry.id === id)?.defaultEnabled).toBe(false)
      const tools = getConnectorTools(id)
      expect(tools.length).toBeGreaterThan(0)
      expect(
        tools.some((tool) => ['import_data', 'query_local', 'get_job'].includes(tool.id))
      ).toBe(false)
      const doc = renderSkillDoc(id)
      expect(doc).toContain('Official file URLs are discovery metadata')
    }
    for (const [connector, method] of [
      ['genes', 'query_hgnc_field'],
      ['genes', 'list_hgnc_files'],
      ['cellosaurus', 'get_cell_line_rdf'],
      ['drug-regulatory', 'list_faers_bulk_files']
    ]) {
      const tool = getDescriptor(connector, method)!
      expect(tool).toBeDefined()
      expect(() => validateToolArguments(tool, tool.exampleArgs!)).not.toThrow()
    }
  })

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
        expect(doc).toContain(JSON.stringify(tool.exampleArgs))
        expect(doc).toContain(JSON.stringify(tool.input))
      }
    }
  )
})

it('adds the preview capability only in the application registry', async () => {
  const { MOLECULE_TOOLS } = await import('@aipoch/connector-builtins/molecule')
  expect(MOLECULE_TOOLS.map((tool) => tool.id)).toEqual(['render_molecule'])
  expect(getConnectorTools('molecule').map((tool) => tool.id)).toEqual([
    'render_molecule',
    'preview_molecule'
  ])
  const doc = renderSkillDoc('molecule')
  expect(doc).toContain('write_artifact_file')
  expect(doc).toContain('preview_molecule')
  expect(CONNECTOR_CATALOG.find((entry) => entry.id === 'molecule')?.group).toBe('featured')
  expect(CONNECTOR_CATALOG.find((entry) => entry.id === 'pubmed')?.group).toBe('directory')
})

describe('PDC clinical tool host integration', () => {
  it('exposes the package tool through the host registry and generated Skill', () => {
    const descriptor = getDescriptor('pdc', 'pdc_list_clinical')!
    expect(getConnectorTools('pdc')).toContain(descriptor)
    expect(descriptor.credentialKeys).toEqual([])
    expect(() => validateToolArguments(descriptor, descriptor.exampleArgs!)).not.toThrow()
    expect(() => validateToolArguments(descriptor, {})).toThrow('invalid_arguments')
    const doc = renderSkillDoc('pdc')
    expect(doc).toContain('### pdc_list_clinical')
    expect(doc).toContain(JSON.stringify(descriptor.exampleArgs))
    expect(doc).toContain('completeness: "unknown"')
  })
})

it('exposes posted ClinicalTrials.gov results through the registry and generated Skill', () => {
  const descriptor = getDescriptor('clinical-trials', 'get_trial_results')!
  expect(descriptor).toBeDefined()
  expect(getConnectorTools('clinical-trials')).toContain(descriptor)
  expect(descriptor.credentialKeys).toEqual([])
  expect(() => validateToolArguments(descriptor, descriptor.exampleArgs!)).not.toThrow()
  expect(() => validateToolArguments(descriptor, {})).toThrow('invalid_arguments')
  const doc = renderSkillDoc('clinical-trials')
  expect(doc).toContain('### get_trial_results')
  expect(doc).toContain('results_section')
  expect(doc).toContain('unitOfMeasure')
  expect(doc).toContain('Missing data does not mean zero events or no treatment effect')
})

describe('LIPID MAPS host integration', () => {
  it('exposes exact lipid lookup through Chemistry and its generated Skill', () => {
    const descriptor = getDescriptor('chemistry', 'lipidmaps_get_compound')!
    expect(getConnectorTools('chemistry')).toContain(descriptor)
    expect(() => validateToolArguments(descriptor, descriptor.exampleArgs!)).not.toThrow()
    expect(() =>
      validateToolArguments(descriptor, { id_type: 'lm_id', identifier: 'LMFA' })
    ).toThrow('invalid_arguments')
    expect(ALL_CONNECTOR_IDS).not.toContain('lipidmaps')
    const doc = renderSkillDoc('chemistry')
    expect(doc).toContain('### lipidmaps_get_compound')
    expect(doc).toContain('CC BY 4.0')
    expect(doc).toContain('records_truncated')
  })
})
