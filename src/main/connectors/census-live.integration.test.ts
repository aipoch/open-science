import type { SpawnOptions } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { expect, it } from 'vitest'
import { NotebookNetworkSandboxOwner } from '../notebook/network-sandbox-owner'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { ConnectorService } from './service'
import { ParserEngine } from './engine'
import { createCensusHandler } from './census-runtime'

// Manual certification: OPEN_SCIENCE_CENSUS_LIVE=1 OPEN_SCIENCE_CENSUS_TEST_PYTHON=/path/to/python npm test -- src/main/connectors/census-live.integration.test.ts
// Each request uses a fresh Python process while reusing the app RPC/service/sandbox owners.
type MetadataResult = {
  census_version: string
  organism?: string
  total?: number
  total_returned?: number
  datasets?: { dataset_id: string }[]
  cells?: { soma_joinid: number; tissue_general: string }[]
}

const metadataCases = [
  {
    action: 'list_datasets',
    args: { limit: 2 },
    emptyArgs: { query: 'CENSUS_TEST_UNKNOWN_DATASET' },
    check(result: MetadataResult): void {
      expect(result.datasets).toHaveLength(2)
      expect(result.total).toBeGreaterThanOrEqual(2)
      expect(result.datasets?.every((row) => typeof row.dataset_id === 'string')).toBe(true)
    },
    empty: { total: 0, datasets: [] }
  },
  {
    action: 'query_cells',
    args: { organism: 'homo_sapiens', tissue: 'liver', limit: 2 },
    emptyArgs: { organism: 'homo_sapiens', tissue: 'CENSUS_TEST_UNKNOWN_TISSUE' },
    check(result: MetadataResult): void {
      expect(result.organism).toBe('homo_sapiens')
      expect(result.total_returned).toBe(2)
      expect(result.cells).toHaveLength(2)
      expect(result.cells?.every((cell) => cell.tissue_general === 'liver')).toBe(true)
      expect(new Set(result.cells?.map((cell) => cell.soma_joinid)).size).toBe(2)
    },
    empty: { organism: 'homo_sapiens', total_returned: 0, cells: [] }
  }
]

it.skipIf(process.env.OPEN_SCIENCE_CENSUS_LIVE !== '1').each(metadataCases)(
  '$action repeats real queries and recovers after an empty result through authenticated RPC and the Notebook sandbox',
  async (testCase) => {
    const pythonPath = process.env.OPEN_SCIENCE_CENSUS_TEST_PYTHON
    expect(pythonPath, 'A provisioned Python interpreter is required').toBeTruthy()
    const root = await mkdtemp(join(tmpdir(), 'census-metadata-live-'))
    const settingsBefore = JSON.stringify(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)
    const sandbox = new NotebookNetworkSandboxOwner({
      resourceRoot: resolve('packages/notebook-network-sandbox/vendor'),
      temporaryRoot: root,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => {
        throw new Error('Live test must not persist domain grants')
      },
      requestDecision: async () => 'deny'
    })
    const service = new ConnectorService({
      engine: new ParserEngine(),
      getConnectors: () => ({ enabledIds: ['census'], autoAllowIds: ['census'] }),
      resolveApiKey: () => undefined,
      localToolHandlers: Object.fromEntries(
        ['list_datasets', 'query_cells'].map((action) => [
          `census/census_${action}`,
          createCensusHandler({ action, pythonPath, processSandbox: sandbox })
        ])
      )
    })
    const rpc = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      connectorService: service
    })
    const failures: string[] = []
    try {
      const connection = await rpc.issueControlConnection(
        'census-test-session',
        'census-test-project',
        'census-test-frame'
      )
      const call = async (
        name: string,
        args: Record<string, unknown>,
        check: (result: MetadataResult) => void
      ): Promise<void> => {
        const started = Date.now()
        try {
          const response = await fetch(connection.endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${connection.token}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              method: 'mcpCall',
              params: {
                server: 'census',
                method: `census_${testCase.action}`,
                args: { census_version: '2025-11-08', ...args }
              }
            })
          })
          const body = await response.json()
          if (body.error) throw new Error(String(body.error))
          expect(body, name).not.toHaveProperty('error')
          expect(response.status).toBe(200)
          expect(body.result.census_version).toBe('2025-11-08')
          check(body.result)
          console.info(JSON.stringify({ case: name, ok: true, elapsedMs: Date.now() - started }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failures.push(`${name}: ${message}`)
          console.info(
            JSON.stringify({
              case: name,
              ok: false,
              elapsedMs: Date.now() - started,
              error: message
            })
          )
        }
        expect(await readdir(root)).toEqual([])
        expect(JSON.stringify(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)).toBe(settingsBefore)
      }
      let first: MetadataResult | undefined
      const checkRepeated = (result: MetadataResult): void => {
        testCase.check(result)
        if (first === undefined) first = result
        else expect(result).toEqual(first)
      }
      for (let index = 1; index <= 3; index++) {
        await call(`${testCase.action}-repeat-${index}`, testCase.args, checkRepeated)
      }
      await call(`${testCase.action}-empty`, testCase.emptyArgs, (result) => {
        expect(result).toMatchObject(testCase.empty)
      })
      await call(`${testCase.action}-after-empty`, testCase.args, checkRepeated)
      expect(failures).toEqual([])
    } finally {
      await rpc.close()
      await sandbox.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  960_000
)

it.skipIf(process.env.OPEN_SCIENCE_CENSUS_LIVE !== '1').each(['cancel', 'timeout'] as const)(
  '%s stops a real sandboxed Python tree before removing its temporary resources',
  async (mode) => {
    const { spawn } = await import('node:child_process')
    const root = await mkdtemp(join(tmpdir(), 'census-cancel-'))
    const sandbox = new NotebookNetworkSandboxOwner({
      resourceRoot: resolve('packages/notebook-network-sandbox/vendor'),
      temporaryRoot: root,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => {
        throw new Error('Unexpected persisted grant')
      },
      requestDecision: async () => 'deny'
    })
    const controller = new AbortController()
    let ready!: (pid: number) => void
    const childReady = new Promise<number>((resolve) => {
      ready = resolve
    })
    const stall = `import os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-I', '-c', 'import os, signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print(os.getpid(), flush=True); time.sleep(240)'], stdout=subprocess.PIPE, text=True)
print('READY:' + child.stdout.readline().strip(), flush=True)
time.sleep(240)
`
    let parentPid: number | undefined
    let injectStall = true
    const handler = createCensusHandler({
      action: 'query_cells',
      pythonPath: process.env.OPEN_SCIENCE_CENSUS_TEST_PYTHON,
      processSandbox: {
        // Replace only the fixed Python workload; retain actual production sandbox and lifecycle.
        wrap: (invocation) =>
          sandbox.wrap(
            injectStall ? { ...invocation, args: ['-I', '-u', '-c', stall] } : invocation
          )
      },
      spawnProcess: ((command: string, args: readonly string[], options: SpawnOptions) => {
        const child = spawn(command, args, options)
        parentPid = child.pid
        let output = ''
        child.stdout?.on('data', (chunk) => {
          output += String(chunk)
          const match = /READY:(\d+)/.exec(output)
          if (match) ready(Number(match[1]))
        })
        return child
      }) as unknown as typeof spawn
    })
    const watchdog = setTimeout(() => controller.abort(new Error('test startup deadline')), 15_000)
    try {
      const result = handler(
        { tissue: 'liver' },
        { sessionId: 'cancel-session', projectId: 'cancel-project' },
        controller.signal
      )
      void result.catch(() => {})
      const descendant = await Promise.race([
        childReady,
        result.then(() => {
          throw new Error('Workload exited before ready')
        })
      ])
      clearTimeout(watchdog)
      if (mode === 'cancel') controller.abort(new Error('user stop'))
      await expect(result).rejects.toThrow(
        mode === 'cancel' ? 'user stop' : 'timed out after 180000ms'
      )
      expect(() => process.kill(parentPid!, 0)).toThrow()
      expect(() => process.kill(descendant, 0)).toThrow()
      expect(await readdir(root)).toEqual([])
      if (mode === 'timeout') {
        injectStall = false
        // Reuse the same handler/owner with a fresh request after its actual deadline.
        const recovered = await handler(
          { tissue: 'liver', limit: 1, census_version: '2025-11-08' },
          { sessionId: 'cancel-session', projectId: 'cancel-project' }
        )
        expect(recovered).toMatchObject({ total_returned: 1 })
        expect(await readdir(root)).toEqual([])
      }
    } finally {
      clearTimeout(watchdog)
      controller.abort()
      await sandbox.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  390_000
)
