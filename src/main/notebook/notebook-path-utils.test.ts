import { describe, expect, it } from 'vitest'

import { isExternalNotebookPath } from './notebook-path-utils'

describe('isExternalNotebookPath', () => {
  it.each(['https://example.org/data.csv', 's3://bucket/data.zarr', 'file:///tmp/data.h5'])(
    'recognizes %s as external',
    (path) => {
      expect(isExternalNotebookPath(path)).toBe(true)
    }
  )

  it('recognizes VSI-wrapped remote paths as external', () => {
    expect(isExternalNotebookPath('/vsicurl/https://example.org/dem.tif')).toBe(true)
  })

  it.each(['inputs/data.csv', './outputs/result.parquet', 'C:\\data\\matrix.h5'])(
    'keeps local path %s local',
    (path) => {
      expect(isExternalNotebookPath(path)).toBe(false)
    }
  )
})
