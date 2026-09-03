import { describe, expect, it, vi } from 'vitest'

import { TagResourceCatalog } from './resource-catalog'

describe('TagResourceCatalog', () => {
  it('excludes unavailable Skills from the resource snapshot', async () => {
    const catalog = new TagResourceCatalog({
      listSkills: vi
        .fn()
        .mockResolvedValue([
          { id: 'available-skill' },
          { id: 'conflicting-skill', available: false },
          { id: 'conflicting-skill', available: false }
        ]),
      listConnectors: vi.fn().mockResolvedValue({ connectors: [], customServers: [] }),
      listSpecialists: vi.fn().mockResolvedValue([])
    })

    const snapshot = await catalog.snapshot()

    expect([...snapshot['catalog.skill']]).toEqual(['available-skill'])
  })
})
