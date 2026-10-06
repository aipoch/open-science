import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { projectNotebookDependencies } from './dependency-projection'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const completedRun = (runId: string, script: string): NotebookRunRecord => ({
  runId,
  cellId: runId,
  source: 'agent',
  inputKind: 'cell',
  kernelKind: 'r',
  kernelEpochId: 'epoch-1',
  environment: 'r',
  script,
  status: 'completed',
  startedAt: Number(runId.slice(-1)),
  endedAt: Number(runId.slice(-1)),
  executionCount: Number(runId.slice(-1)),
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles:
    runId === 'run-3'
      ? [
          {
            path: 'outputs/roads-utm.gpkg',
            relativePath: 'outputs/roads-utm.gpkg',
            kind: 'other',
            createdByRunId: runId,
            change: 'created',
            checksum: 'roads-utm-checksum'
          }
        ]
      : [],
  inputFiles: []
})

it('links sf vector data through CRS transformation and GeoPackage output', async () => {
  const scripts = [
    'roads <- sf::st_read("inputs/roads.gpkg", quiet = TRUE)',
    'utm <- sf::st_transform(roads, 32650)',
    'sf::st_write(utm, "outputs/roads-utm.gpkg", quiet = TRUE)',
    'check <- sf::st_read("outputs/roads-utm.gpkg", quiet = TRUE)'
  ]
  const entries = await Promise.all(
    scripts.map(async (script, index) => ({
      run: completedRun(`run-${index + 1}`, script),
      facts: (await analyzeRNotebookSource(script)).facts,
      fileAccess: await analyzeNotebookSourceFileAccess('r', script)
    }))
  )
  const projection = projectNotebookDependencies(entries)

  expect(entries[0]?.facts.typeBindings).toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'roads', typeName: 'sf' })])
  )
  expect(entries[1]?.facts.safeCallNames).toContain('sf::st_transform')
  expect(entries[2]?.fileAccess.writes).toContain('outputs/roads-utm.gpkg')
  expect(entries[3]?.fileAccess.reads).toContain('outputs/roads-utm.gpkg')
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projection.dependenciesByRunId?.['run-3']).toContain('run-2')
})

it('keeps dynamic sf writers conservative while preserving known paths', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    'sf::st_write(roads, dsn = output_path, quiet = TRUE)'
  )
  expect(access.writes).toEqual([])
  expect(access.writeState).toBe('partial')
})

it('keeps shapefile companion inputs partial while GeoPackage stays complete', async () => {
  await expect(
    analyzeNotebookSourceFileAccess('r', 'roads <- sf::st_read("inputs/roads.shp")')
  ).resolves.toMatchObject({
    reads: ['inputs/roads.shp'],
    readState: 'partial',
    reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
  })
  await expect(
    analyzeNotebookSourceFileAccess('r', 'roads <- sf::st_read("inputs/roads.gpkg")')
  ).resolves.toMatchObject({ reads: ['inputs/roads.gpkg'], readState: 'complete' })
})

it('keeps terra GDAL sidecars and VRT sources partial', async () => {
  await expect(
    analyzeNotebookSourceFileAccess('r', 'roads <- terra::vect("inputs/roads.shp")')
  ).resolves.toMatchObject({
    reads: ['inputs/roads.shp'],
    readState: 'partial',
    reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
  })
  await expect(
    analyzeNotebookSourceFileAccess('r', 'tiles <- terra::rast("inputs/tiles.vrt")')
  ).resolves.toMatchObject({
    reads: ['inputs/tiles.vrt'],
    readState: 'partial',
    reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
  })
  await expect(
    analyzeNotebookSourceFileAccess('r', 'tiles <- terra::rast("inputs/tiles.tif")')
  ).resolves.toMatchObject({ reads: ['inputs/tiles.tif'], readState: 'complete' })
})
