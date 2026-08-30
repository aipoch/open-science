import { describe, expect, it } from 'vitest'

import { analyzeScientificOutputs as analyzeOutputs } from './scientific-output-analysis'

const analyzeScientificOutputs = (
  relations: Parameters<typeof analyzeOutputs>[0]
): ReturnType<typeof analyzeOutputs> => analyzeOutputs(relations, 'test-run')

describe('scientific output analysis', () => {
  it.each([
    ['data/table.csv', 'text-data', ['format-validity-not-verified']],
    ['data/frame.parquet', 'parquet', ['format-validity-not-verified']],
    ['data/frame.fst', 'fst', ['format-validity-not-verified']],
    ['data/climate.nc', 'netcdf', ['format-validity-not-verified']],
    ['data/survey.sav', 'statistical-data', ['format-validity-not-verified']],
    [
      'data/cells.h5ad',
      'single-cell-data',
      ['format-validity-not-verified', 'runtime-dependent-serialization']
    ],
    [
      'data/model.pkl',
      'python-serialization',
      ['format-validity-not-verified', 'runtime-dependent-serialization']
    ],
    [
      'data/model.rds',
      'r-serialization',
      ['format-validity-not-verified', 'runtime-dependent-serialization']
    ],
    [
      'data/results.sqlite',
      'database',
      ['database-state-not-verified', 'format-validity-not-verified']
    ],
    ['data/figure.png', 'image', ['format-validity-not-verified']]
  ])('classifies a Python/R single-file output at %s', (relativePath, formatHint, riskCodes) => {
    expect(analyzeScientificOutputs([{ relation: 'created', relativePath }])).toMatchObject([
      {
        storageShape: 'single-file',
        formatHint,
        classificationAuthority: 'path-heuristic',
        members: [relativePath],
        riskCodes
      }
    ])
  })

  it('groups a partitioned Arrow dataset without grouping unrelated files at the managed root', () => {
    const outputs = analyzeScientificOutputs([
      { relation: 'created', relativePath: 'data/dataset/species=setosa/part-0.parquet' },
      { relation: 'created', relativePath: 'data/dataset/species=virginica/part-1.parquet' },
      { relation: 'created', relativePath: 'data/unrelated-a.parquet' },
      { relation: 'created', relativePath: 'data/unrelated-b.parquet' }
    ])

    expect(outputs).toHaveLength(3)
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storageShape: 'directory-tree',
          formatHint: 'parquet-dataset',
          members: [
            'data/dataset/species=setosa/part-0.parquet',
            'data/dataset/species=virginica/part-1.parquet'
          ],
          riskCodes: ['format-validity-not-verified', 'multi-file-consistency-not-verified']
        }),
        expect.objectContaining({
          storageShape: 'single-file',
          members: ['data/unrelated-a.parquet']
        }),
        expect.objectContaining({
          storageShape: 'single-file',
          members: ['data/unrelated-b.parquet']
        })
      ])
    )
  })

  it('groups a chunked Zarr store including replaced and deleted chunks', () => {
    expect(
      analyzeScientificOutputs([
        { relation: 'created', relativePath: 'data/climate.zarr/zarr.json' },
        { relation: 'modified', relativePath: 'data/climate.zarr/temperature/c/0/0' },
        { relation: 'deleted', relativePath: 'data/climate.zarr/temperature/c/old' }
      ])
    ).toMatchObject([
      {
        storageShape: 'directory-tree',
        formatHint: 'zarr',
        members: [
          'data/climate.zarr/temperature/c/0/0',
          'data/climate.zarr/temperature/c/old',
          'data/climate.zarr/zarr.json'
        ],
        riskCodes: ['format-validity-not-verified', 'multi-file-consistency-not-verified']
      }
    ])
  })

  it('groups database journals and reports transactional uncertainty', () => {
    expect(
      analyzeScientificOutputs([
        { relation: 'modified', relativePath: 'data/results.sqlite' },
        { relation: 'created', relativePath: 'data/results.sqlite-wal' },
        { relation: 'created', relativePath: 'data/results.sqlite-shm' }
      ])
    ).toMatchObject([
      {
        storageShape: 'file-set',
        formatHint: 'sqlite',
        members: ['data/results.sqlite', 'data/results.sqlite-shm', 'data/results.sqlite-wal'],
        riskCodes: [
          'database-state-not-verified',
          'format-validity-not-verified',
          'multi-file-consistency-not-verified'
        ]
      }
    ])
  })

  it('groups geospatial companion files while leaving a standalone DBF independent', () => {
    const outputs = analyzeScientificOutputs([
      { relation: 'created', relativePath: 'data/plots.shp' },
      { relation: 'created', relativePath: 'data/plots.shx' },
      { relation: 'created', relativePath: 'data/plots.dbf' },
      { relation: 'created', relativePath: 'data/plots.prj' },
      { relation: 'created', relativePath: 'data/lookup.dbf' }
    ])

    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storageShape: 'file-set',
          formatHint: 'shapefile',
          members: ['data/plots.dbf', 'data/plots.prj', 'data/plots.shp', 'data/plots.shx']
        }),
        expect.objectContaining({
          storageShape: 'single-file',
          formatHint: 'shapefile',
          members: ['data/lookup.dbf']
        })
      ])
    )
  })

  it('keeps an observed Shapefile or partition member as a multi-file output when companions are absent', () => {
    const outputs = analyzeScientificOutputs([
      { relation: 'modified', relativePath: 'data/boundaries.shp' },
      { relation: 'created', relativePath: 'data/export/part-0.parquet' }
    ])

    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storageShape: 'file-set',
          formatHint: 'shapefile',
          members: ['data/boundaries.shp'],
          riskCodes: ['format-validity-not-verified', 'multi-file-consistency-not-verified']
        }),
        expect.objectContaining({
          storageShape: 'directory-tree',
          formatHint: 'parquet-dataset',
          members: ['data/export/part-0.parquet'],
          riskCodes: ['format-validity-not-verified', 'multi-file-consistency-not-verified']
        })
      ])
    )
  })

  it('groups model directories, checkpoints, and HTML reports with assets', () => {
    const outputs = analyzeScientificOutputs([
      { relation: 'created', relativePath: 'data/model/saved_model.pb' },
      { relation: 'created', relativePath: 'data/model/variables/variables.index' },
      { relation: 'created', relativePath: 'data/model/variables/variables.data-00000-of-00001' },
      { relation: 'created', relativePath: 'data/train/ckpt-1.index' },
      { relation: 'created', relativePath: 'data/train/ckpt-1.data-00000-of-00001' },
      { relation: 'created', relativePath: 'handoff/report.html' },
      { relation: 'created', relativePath: 'handoff/report_files/plot.png' }
    ])

    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storageShape: 'directory-tree',
          formatHint: 'tensorflow-saved-model',
          members: [
            'data/model/saved_model.pb',
            'data/model/variables/variables.data-00000-of-00001',
            'data/model/variables/variables.index'
          ]
        }),
        expect.objectContaining({
          storageShape: 'file-set',
          formatHint: 'tensorflow-checkpoint',
          members: ['data/train/ckpt-1.data-00000-of-00001', 'data/train/ckpt-1.index']
        }),
        expect.objectContaining({
          storageShape: 'file-set',
          formatHint: 'html-with-assets',
          members: ['handoff/report.html', 'handoff/report_files/plot.png']
        })
      ])
    )
  })

  it('groups GeoTIFF sidecars, 10x matrices, and unsharded model directories', () => {
    const outputs = analyzeScientificOutputs([
      { relation: 'created', relativePath: 'data/map.tif' },
      { relation: 'created', relativePath: 'data/map.tif.aux.xml' },
      { relation: 'created', relativePath: 'data/map.tfw' },
      { relation: 'created', relativePath: 'data/cells/matrix.mtx.gz' },
      { relation: 'created', relativePath: 'data/cells/barcodes.tsv.gz' },
      { relation: 'created', relativePath: 'data/cells/features.tsv.gz' },
      { relation: 'created', relativePath: 'data/classifier/config.json' },
      { relation: 'created', relativePath: 'data/classifier/model.safetensors' },
      { relation: 'created', relativePath: 'data/classifier/tokenizer.json' }
    ])

    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storageShape: 'file-set',
          formatHint: 'geotiff-with-sidecars',
          members: ['data/map.tfw', 'data/map.tif', 'data/map.tif.aux.xml']
        }),
        expect.objectContaining({
          storageShape: 'file-set',
          formatHint: '10x-matrix',
          members: [
            'data/cells/barcodes.tsv.gz',
            'data/cells/features.tsv.gz',
            'data/cells/matrix.mtx.gz'
          ]
        }),
        expect.objectContaining({
          storageShape: 'directory-tree',
          formatHint: 'model-directory',
          members: [
            'data/classifier/config.json',
            'data/classifier/model.safetensors',
            'data/classifier/tokenizer.json'
          ]
        })
      ])
    )
  })

  it('includes metadata and success markers in a recognized partitioned dataset', () => {
    expect(
      analyzeScientificOutputs([
        { relation: 'created', relativePath: 'data/dataset/part-0.parquet' },
        { relation: 'created', relativePath: 'data/dataset/part-1.parquet' },
        { relation: 'created', relativePath: 'data/dataset/_metadata' },
        { relation: 'created', relativePath: 'data/dataset/_SUCCESS' }
      ])
    ).toMatchObject([
      {
        storageShape: 'directory-tree',
        formatHint: 'parquet-dataset',
        members: [
          'data/dataset/_SUCCESS',
          'data/dataset/_metadata',
          'data/dataset/part-0.parquet',
          'data/dataset/part-1.parquet'
        ]
      }
    ])
  })

  it('recognizes Arrow-style partitioned text datasets without grouping arbitrary CSV files', () => {
    const outputs = analyzeScientificOutputs([
      { relation: 'created', relativePath: 'data/export/group=a/part-0.csv' },
      { relation: 'created', relativePath: 'data/export/group=b/part-1.csv' },
      { relation: 'created', relativePath: 'data/report-a.csv' },
      { relation: 'created', relativePath: 'data/report-b.csv' }
    ])

    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storageShape: 'directory-tree',
          formatHint: 'text-dataset',
          members: ['data/export/group=a/part-0.csv', 'data/export/group=b/part-1.csv']
        }),
        expect.objectContaining({
          storageShape: 'single-file',
          members: ['data/report-a.csv']
        }),
        expect.objectContaining({
          storageShape: 'single-file',
          members: ['data/report-b.csv']
        })
      ])
    )
  })

  it('keeps output IDs deterministic while excluding deletion-only paths', () => {
    const relations = [
      { relation: 'created' as const, relativePath: 'data/result.csv' },
      { relation: 'deleted' as const, relativePath: 'data/obsolete.csv' }
    ]
    const first = analyzeScientificOutputs(relations)
    const second = analyzeScientificOutputs([...relations].reverse())

    expect(second).toEqual(first)
    expect(first).toHaveLength(1)
    expect(first[0]?.outputId).toMatch(/^scientific-output-[a-f0-9]{24}$/u)
    expect(first[0]?.members).toEqual(['data/result.csv'])
    expect(analyzeOutputs(relations, 'other-run')[0]?.outputId).not.toBe(first[0]?.outputId)
  })
})
