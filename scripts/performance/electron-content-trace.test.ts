import { describe, expect, it } from 'vitest'
import { buildElectronContentTraceConfig } from './electron-content-trace'

describe('Electron content trace configuration', () => {
  it('configures detailed periodic memory dumps for heap profiles', () => {
    expect(buildElectronContentTraceConfig(true)).toEqual({
      included_categories: ['disabled-by-default-memory-infra'],
      excluded_categories: ['*'],
      memory_dump_config: {
        triggers: [{ mode: 'detailed', periodic_interval_ms: 1_000 }]
      }
    })
  })

  it('keeps regular traces on the broad category capture path', () => {
    expect(buildElectronContentTraceConfig(false)).toEqual({ included_categories: ['*'] })
  })
})
