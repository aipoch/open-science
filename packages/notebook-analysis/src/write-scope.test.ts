import { describe, expect, it } from 'vitest'
import { matchesWriteScope } from './write-scope'

describe('scientific write scopes', () => {
  it('matches scientific companions without changing the basename case', () => {
    expect(
      matchesWriteScope({ kind: 'shapefile', path: 'Outputs/Map.shp' }, 'Outputs/Map.dbf')
    ).toBe(true)
    expect(
      matchesWriteScope({ kind: 'shapefile', path: 'Outputs/Map.shp' }, 'outputs/map.dbf')
    ).toBe(process.platform === 'win32')
    expect(matchesWriteScope({ kind: 'geotiff', path: 'Outputs/Map.tif' }, 'Outputs/Map.tfw')).toBe(
      true
    )
    expect(matchesWriteScope({ kind: 'geotiff', path: 'Outputs/Map.tif' }, 'outputs/map.tfw')).toBe(
      process.platform === 'win32'
    )
  })

  it('matches directory scopes with the host filesystem case rules', () => {
    expect(matchesWriteScope({ kind: 'directory', path: 'Outputs' }, 'Outputs/result.csv')).toBe(
      true
    )
    expect(matchesWriteScope({ kind: 'directory', path: 'Outputs' }, 'outputs/result.csv')).toBe(
      process.platform === 'win32'
    )
  })
})
