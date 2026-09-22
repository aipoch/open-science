import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SkillRegistry } from './registry'
import { RegisteredSkillHelperCatalog } from './registered-helper-catalog'
import { NotebookHelperModuleHost } from '../notebook/helper-module-host'
import { NotebookKernelExecutor } from '../notebook/kernel-executor'
import { resolvePythonCommand } from '../notebook/python-command'

import { NotebookNetworkSandboxOwner } from '../notebook/network-sandbox-owner'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'

const skillsRoot = join(__dirname, '../../../resources/skills')

it('discovers Census and executes its registered public helper in the bound Notebook interpreter', async () => {
  const skill = (await new SkillRegistry(skillsRoot).list()).find((item) => item.id === 'census')!
  expect(skill.helpers?.[0]?.exports).toEqual(['census_list_datasets', 'census_query_cells'])
  const root = await mkdtemp(join(tmpdir(), 'census-notebook-'))
  const executor = new NotebookKernelExecutor({
    pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py')
  })
  try {
    const catalog = new RegisteredSkillHelperCatalog({
      storageRoot: root,
      packages: async () => [
        {
          skillId: skill.id,
          origin: 'builtin',
          packageRoot: skill.sourceDir,
          helpers: [...skill.helpers!]
        }
      ]
    })
    const host = new NotebookHelperModuleHost(catalog)
    const request = await host.preflight('python', ['census'])
    const { injections } = await host.plan(
      { id: 'census-epoch', processKey: 'python:default-python' },
      request
    )
    const python = await resolvePythonCommand()
    await mkdir(join(root, 'nb/data'), { recursive: true })
    const result = await executor.execute({
      cwd: root,
      notebookSessionRoot: join(root, 'nb'),
      dataRoot: join(root, 'nb/data'),
      runtimeRoot: join(root, 'runtime'),
      language: 'python',
      resolvedInterpreter: { command: python.command, args: python.baseArgs },
      helperModules: injections,
      code: 'try:\n    census_query_cells()\nexcept ValueError as error:\n    print(error)'
    })
    expect(
      result,
      JSON.stringify({ status: result.status, stderr: result.stderr, traceback: result.traceback })
    ).toMatchObject({
      status: 'completed',
      stdout: 'at least one of tissue, cell_type, or disease is required\n'
    })
    const { stderr } = await promisify(execFile)(python.command, [
      ...python.baseArgs,
      join(skill.sourceDir, 'test_kernel.py')
    ])
    expect(stderr).toContain('OK')
  } finally {
    await executor.shutdown()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it.skipIf(!process.env.OPEN_SCIENCE_CENSUS_TEST_PYTHON)(
  'checks Census data contracts with real Arrow fixtures',
  async () => {
    const { stderr } = await promisify(execFile)(
      process.env.OPEN_SCIENCE_CENSUS_TEST_PYTHON!,
      [join(skillsRoot, 'census/test_contract.py')],
      { timeout: 60_000 }
    )
    expect(stderr).toMatch(/Ran \d+ tests/)
    expect(stderr).toContain('OK')
  },
  65_000
)

// Opt-in real SDK certification through the same persistent Notebook kernel used by users.
it.skipIf(process.env.OPEN_SCIENCE_CENSUS_LIVE !== '1')(
  'runs repeated Census queries through registered helpers and the real Notebook network sandbox',
  async () => {
    const python = process.env.OPEN_SCIENCE_CENSUS_TEST_PYTHON!
    expect(python, 'A provisioned Census Python interpreter is required').toBeTruthy()
    const root = await mkdtemp(join(tmpdir(), 'census-sandbox-notebook-'))
    const temporaryRoot = join(root, 'sandbox')
    await mkdir(temporaryRoot)
    await mkdir(join(root, 'nb', 'data'), { recursive: true })
    const decisions: string[] = []
    const hosts = new Set([
      'census.cellxgene.cziscience.com',
      'cellxgene-census-public-us-west-2.s3.amazonaws.com',
      'cellxgene-census-public-us-west-2.s3.us-west-2.amazonaws.com'
    ])
    const persist = vi.fn(async () => {
      throw new Error('Live certification must not persist grants')
    })
    const sandbox = new NotebookNetworkSandboxOwner({
      resourceRoot: resolve('packages/notebook-network-sandbox/vendor'),
      temporaryRoot,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: persist,
      getParentProxy: async () => ({
        http: process.env.HTTP_PROXY,
        https: process.env.HTTPS_PROXY
      }),
      requestDecision: async ({ hostname }) => {
        decisions.push(hostname)
        return hosts.has(hostname) ? 'allowOnce' : 'deny'
      }
    })
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      processSandbox: sandbox
    })
    try {
      const skill = (await new SkillRegistry(skillsRoot).list()).find(
        (item) => item.id === 'census'
      )!
      const catalog = new RegisteredSkillHelperCatalog({
        storageRoot: root,
        packages: async () => [
          {
            skillId: skill.id,
            origin: 'builtin',
            packageRoot: skill.sourceDir,
            helpers: [...skill.helpers!]
          }
        ]
      })
      const host = new NotebookHelperModuleHost(catalog)
      const request = await host.preflight('python', ['census'])
      const epoch = { id: 'census-live-epoch', processKey: 'python:default-python' }
      const execution: Parameters<NotebookKernelExecutor['execute']>[0] = {
        cwd: root,
        notebookSessionRoot: join(root, 'nb'),
        dataRoot: join(root, 'nb', 'data'),
        runtimeRoot: join(root, 'runtime'),
        sessionId: 'census-test-session',
        projectId: 'census-test-project',
        language: 'python',
        resolvedInterpreter: { command: python, condaPrefix: dirname(dirname(python)) },
        timeoutMs: 180_000,
        code: [
          "datasets = census_list_datasets(limit=2, census_version='2025-11-08')",
          "assert len(datasets['datasets']) == 2",
          "version = datasets['census_version']",
          "assert version == '2025-11-08'",
          "first = census_query_cells(tissue='liver', limit=2, census_version=version)",
          "assert len(first['cells']) == 2",
          "assert all(cell['tissue_general'] == 'liver' for cell in first['cells'])",
          "empty = census_query_cells(tissue='CENSUS_TEST_UNKNOWN_TISSUE', census_version=version)",
          "assert empty['cells'] == []",
          "assert census_query_cells(tissue='liver', limit=2, census_version=version) == first",
          'assert census_list_datasets(limit=2, census_version=version) == datasets',
          "print('census notebook queries passed')"
        ].join('\n')
      }
      const run = async (): ReturnType<NotebookKernelExecutor['execute']> => {
        const plan = await host.plan(epoch, request)
        const result = await executor.execute({ ...execution, helperModules: plan.injections })
        host.commitInitialized(epoch, result.helperModulesInitialized ?? [])
        return result
      }
      let result = await run()
      expect(result.status).toBe('failed')
      expect(result.stderr).toContain('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')
      for (let retry = 0; result.status !== 'completed' && retry < hosts.size; retry++) {
        const blockedHosts = new Set(
          [...result.stderr.matchAll(/deny network-outbound ([^ :]+):/g)].map((match) => match[1])
        )
        expect(
          blockedHosts.size,
          JSON.stringify({ stderr: result.stderr, traceback: result.traceback })
        ).toBeGreaterThan(0)
        for (const hostname of blockedHosts) {
          expect(hosts.has(hostname)).toBe(true)
          const access = await sandbox.requestNetworkAccess({
            sessionId: 'census-test-session',
            projectId: 'census-test-project',
            hostname,
            runtime: 'python',
            reason: 'Read public Census metadata in this test execution'
          })
          expect(access.status).toBe('allowedOnce')
        }
        result = await run()
      }
      expect(
        result,
        JSON.stringify({
          status: result.status,
          stderr: result.stderr,
          traceback: result.traceback
        })
      ).toMatchObject({
        status: 'completed',
        stdout: 'census notebook queries passed\n'
      })
      expect(decisions).toContain('cellxgene-census-public-us-west-2.s3.us-west-2.amazonaws.com')
      expect(persist).not.toHaveBeenCalled()
    } finally {
      await executor.shutdown()
      await sandbox.dispose()
      const remaining = await readdir(temporaryRoot)
      await rm(root, { recursive: true, force: true })
      expect(remaining).toEqual([])
    }
  },
  210_000
)
