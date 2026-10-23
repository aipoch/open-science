import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve, join } from 'node:path'
import { expect, it } from 'vitest'
import { McpClientManager } from '@aipoch/connector-mcp-client'
import { MEDICAL_PROVIDERS } from '@aipoch/connector-builtins/medical-data'
import { createMedicalDataHandlers } from './medical-data-adapter'

// An explicit prepared runtime makes this an opt-in real-process test, with no installation
// or dependency download hidden in the ordinary portable Node suite.
const python = process.env.OPEN_SCIENCE_MEDICAL_TEST_PYTHON

it.skipIf(!python)(
  'dispatches all medical sources through the actual host adapter, MCP manager and packaged bootstrap',
  async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'medical-engine-integration-'))
    let selectedRoot = dataRoot
    const client = new McpClientManager()
    const handlers = createMedicalDataHandlers({
      client,
      python: () => python!,
      script: () => resolve('resources/medical-data/bootstrap.py'),
      dataRoot: () => selectedRoot,
      environment: () => ({})
    })
    try {
      for (const provider of MEDICAL_PROVIDERS) {
        const info = (await handlers[`${provider.id}/provider_info`]({}, {})) as {
          incoming_directory: string
        }
        await handlers[`${provider.id}/list_tables`]({}, {})
        const path = join(info.incoming_directory, 'integration.csv')
        await writeFile(path, 'group,value\na,2\na,4\nb,10\n')
        const submitted = (await handlers[`${provider.id}/import_data`](
          { path, table_name: 'integration', source_version: 'synthetic' },
          {}
        )) as { job_id: string }
        let job: { status?: string } = {}
        for (let attempt = 0; attempt < 200; attempt += 1) {
          job = (await handlers[`${provider.id}/get_job`]({ job_id: submitted.job_id }, {})) as {
            status: string
          }
          if (['ready', 'error', 'interrupted'].includes(job.status!)) break
          await new Promise((done) => setTimeout(done, 25))
        }
        expect(job.status, provider.id).toBe('ready')
        const result = (await handlers[`${provider.id}/query_local`](
          { sql: 'SELECT count(*) AS n FROM integration' },
          {}
        )) as { rows?: unknown; csv_path?: string }
        if (provider.access === 'public' || provider.id === 'gbd')
          expect(result.rows).toEqual([[3]])
        else {
          expect(result).not.toHaveProperty('rows')
          expect(await readFile(result.csv_path!, 'utf8')).toContain('3')
        }
        await expect(
          handlers[`${provider.id}/query_local`]({ sql: 'DROP TABLE integration' }, {})
        ).rejects.toThrow()
        // Keep only the worker needed by the root-switch assertion. The test should not
        // retain fourteen pandas/DuckDB processes while other portable suites are running.
        if (provider.id !== 'nhanes') await client.close(`builtin-medical:${provider.id}`)
      }
      selectedRoot = join(dataRoot, 'switched')
      expect(await handlers['nhanes/list_tables']({}, {})).toMatchObject({ tables: [] })
    } finally {
      await client.closeAll()
      if (
        dirname(dataRoot) !== resolve(tmpdir()) ||
        !basename(dataRoot).startsWith('medical-engine-integration-')
      ) {
        throw new Error('Unexpected integration temporary directory; refusing cleanup.')
      }
      await rm(dataRoot, { recursive: true, force: true })
    }
  },
  180_000
)
