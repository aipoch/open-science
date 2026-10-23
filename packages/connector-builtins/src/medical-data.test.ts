import { describe, expect, it } from 'vitest'
import { MEDICAL_DATA_TOOLS, MEDICAL_PROVIDERS, MEDICAL_ROUTES } from './medical-data'

describe('medical data descriptors', () => {
  it('publishes all fourteen real providers and unique provider-scoped routes', () => {
    expect(MEDICAL_PROVIDERS.map((p) => p.id).sort()).toEqual([
      'biodbnet',
      'cellosaurus-extra',
      'charls',
      'chea3',
      'chns',
      'ctd',
      'eicu',
      'europepmc',
      'faers',
      'gbd',
      'hgnc',
      'mimic',
      'nhanes',
      'seer'
    ])
    expect(new Set(MEDICAL_DATA_TOOLS.map((t) => `${t.connector}/${t.id}`)).size).toBe(
      MEDICAL_ROUTES.length
    )
    for (const provider of MEDICAL_PROVIDERS) {
      const tools = MEDICAL_DATA_TOOLS.filter((tool) => tool.connector === provider.id)
      expect(tools.map((t) => t.id)).toEqual(
        expect.arrayContaining([
          'provider_info',
          'access_requirements',
          'import_data',
          'query_local',
          'get_job'
        ])
      )
      expect(tools.some((t) => t.id === 'download_file')).toBe(provider.id !== 'seer')
      for (const tool of tools) {
        expect(tool.input.type).toBe('object')
        expect(tool.exampleArgs).toBeDefined()
        expect(tool.returns).toBeTruthy()
      }
    }
  })

  it('does not pretend the standalone package can launch a privileged host worker', async () => {
    await expect(MEDICAL_DATA_TOOLS[0].run!({} as never, {})).rejects.toThrow('host handler')
  })
})
