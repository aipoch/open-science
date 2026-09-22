import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import { CENSUS_TOOLS } from './census'
import type { ToolDescriptor } from '../types'

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true })
const descriptor = (id: string): ToolDescriptor => CENSUS_TOOLS.find((tool) => tool.id === id)!

describe('CELLxGENE Census descriptors', () => {
  it('registers only the two bounded Census metadata tools', () => {
    expect(CENSUS_TOOLS.map((tool) => tool.id)).toEqual([
      'census_list_datasets',
      'census_query_cells'
    ])
    expect(CENSUS_TOOLS).toHaveLength(2)
  })

  it('requires a cohort filter and bounded limits for cell queries', () => {
    const queryCells = descriptor('census_query_cells')
    const validateQuery = ajv.compile(queryCells.input)

    expect(validateQuery({ organism: 'homo_sapiens' })).toBe(false)
    expect(validateQuery({ tissue: 'liver', limit: 101 })).toBe(false)
    expect(validateQuery({ tissue: 'liver', limit: 25 })).toBe(true)
  })

  it('documents deterministic cohort and organism defaults', () => {
    const properties = descriptor('census_query_cells').input.properties as Record<
      string,
      { default?: unknown; description?: string }
    >
    expect(properties.organism.default).toBe('homo_sapiens')
    expect(properties.limit.description).toContain('first row-major cells')
  })

  it.each(['tissue', 'cell_type', 'disease'])(
    'rejects blank %s values while allowing surrounding spaces',
    (field) => {
      const validate = ajv.compile(descriptor('census_query_cells').input)
      for (const value of ['', '   ', '\t\n', '\u3000']) {
        expect(validate({ [field]: value })).toBe(false)
        expect(validate({ tissue: 'liver', [field]: value })).toBe(false)
      }
      expect(validate({ [field]: ' normal ' })).toBe(true)
    }
  )

  it.each(['tissue', 'cell_type', 'disease'])(
    'rejects filter syntax characters in %s values',
    (field) => {
      const validate = ajv.compile(descriptor('census_query_cells').input)
      for (const value of ["normal'", 'normal\\liver', 'normal\n liver', 'normal\r']) {
        expect(validate({ [field]: value })).toBe(false)
      }
    }
  )

  it('keeps the local Python deadline in the runtime bridge contract', () => {
    for (const tool of CENSUS_TOOLS) expect(tool.totalTimeoutMs).toBeUndefined()
  })

  it('keeps Census execution inside the app Python runtime', async () => {
    const list = descriptor('census_list_datasets')
    await expect(list.run?.({} as never, {})).rejects.toThrow('app Python runtime')
  })
})
