import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { opencodeFramework, type ResolvedAgentBackend } from '../agent-framework'
import { assertOpenCodeNativeDelegationDisabled } from './opencode-execution'
import {
  prepareOpenCodeRuntime,
  type PreparedOpenCodeRuntime
} from './opencode-runtime-preparation'

const roots: string[] = []
const prepared: PreparedOpenCodeRuntime[] = []
afterEach(async () => {
  prepared.splice(0).forEach((runtime) => runtime.dispose())
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async (): Promise<{ root: string; backend: ResolvedAgentBackend }> => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-preparation-'))
  roots.push(root)
  const config = opencodeFramework.prepareModelConfig(
    {
      type: 'official',
      vendorId: 'opencode-go',
      agentProviderId: 'admitted-go',
      baseUrl: 'http://127.0.0.1:19999',
      openaiBaseUrl: 'http://127.0.0.1:19999/v1',
      apiEndpoints: ['openai'],
      model: 'admitted-model',
      key: 'synthetic-provider-secret'
    },
    {
      storageRoot: root,
      executablePath: '/opencode',
      instructions: 'admitted connector guidance',
      systemPromptAppends: ['admitted app guidance']
    }
  )
  const backend: ResolvedAgentBackend = {
    framework: opencodeFramework,
    executablePath: '/opencode',
    env: { ...config.env, HOME: '/unchanged-user-home' },
    opencodeConfigFiles: config.configFiles,
    args: ['--log-level', 'WARN', '--port=12345', '--hostname', '127.0.0.1'],
    opencodeUsageApi: { baseUrl: 'http://127.0.0.1:12345', authorization: 'Basic old' },
    sessionModel: config.sessionModel,
    persistentSystemPrompt: config.persistentSystemPrompt
  }
  for (const file of config.configFiles ?? []) {
    await mkdir(dirname(file.path), { recursive: true })
    await writeFile(file.path, 'new global configuration must not be read')
  }
  const skill = join(backend.env.XDG_CONFIG_HOME, 'opencode', 'skills', 'os-example', 'SKILL.md')
  await mkdir(dirname(skill), { recursive: true })
  await writeFile(skill, '# Example skill')
  await mkdir(join(backend.env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await writeFile(join(backend.env.XDG_DATA_HOME, 'opencode', 'opencode.db'), 'live database')
  return { root, backend }
}

describe('OpenCode delegated runtime preparation', () => {
  it('materializes admitted config, Go plugin, instructions and skills without sharing writable state', async () => {
    const { root, backend } = await fixture()
    const original = JSON.stringify(backend)
    const runtime = await prepareOpenCodeRuntime(backend, join(root, 'attempt'))
    prepared.push(runtime)
    const derived = runtime.backend
    expect(derived.env.HOME).toBe('/unchanged-user-home')
    expect(derived.env.OPENCODE_CONFIG_CONTENT).toBe(backend.env.OPENCODE_CONFIG_CONTENT)
    expect(derived.sessionModel).toBe(backend.sessionModel)
    expect(derived.args).toEqual([
      '--log-level',
      'WARN',
      '--port',
      expect.any(String),
      '--hostname',
      '127.0.0.1'
    ])
    expect(derived.args![3]).not.toBe('12345')
    expect(JSON.stringify(backend)).toBe(original)
    const configPath = join(derived.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json')
    const actual = JSON.parse(await readFile(configPath, 'utf8'))
    expect(actual.model).toContain('admitted-model')
    expect(actual.instructions).toHaveLength(2)
    const instructions = await Promise.all(
      actual.instructions.map(async (path: string) => {
        expect(path.startsWith(join(derived.env.XDG_CONFIG_HOME, 'opencode', 'instructions'))).toBe(
          true
        )
        return readFile(path, 'utf8')
      })
    )
    expect(instructions).toEqual(['admitted app guidance', 'admitted connector guidance'])
    const plugin = derived.opencodeConfigFiles!.find((file) => file.path.includes('plugins'))!
    expect(await readFile(plugin.path, 'utf8')).toContain('admitted-go')
    expect(
      await readFile(
        join(derived.env.XDG_CONFIG_HOME, 'opencode', 'skills', 'os-example', 'SKILL.md'),
        'utf8'
      )
    ).toBe('# Example skill')
    await expect(
      readFile(join(derived.env.XDG_DATA_HOME, 'opencode', 'opencode.db'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    const audited = runtime.modelConfig.configFiles!.find((file) => file.path === configPath)!
    expect(audited.content).toBe(await readFile(configPath, 'utf8'))
    expect(() => assertOpenCodeNativeDelegationDisabled(runtime.modelConfig)).not.toThrow()
  })

  it('allocates simultaneously bindable listeners with matching independent usage credentials', async () => {
    const { root, backend } = await fixture()
    const runtimes = await Promise.all(
      [0, 1, 2].map((index) => prepareOpenCodeRuntime(backend, join(root, String(index))))
    )
    prepared.push(...runtimes)
    const listeners = runtimes.map(() => createServer())
    try {
      await Promise.all(
        runtimes.map(async (runtime, index) => {
          const port = Number(new URL(runtime.backend.opencodeUsageApi!.baseUrl).port)
          expect(runtime.backend.args).toContain(String(port))
          expect(runtime.backend.opencodeUsageApi!.authorization).toBe(
            `Basic ${Buffer.from(`opencode:${runtime.backend.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`
          )
          await new Promise<void>((resolve, reject) => {
            listeners[index].once('error', reject)
            listeners[index].listen(port, '127.0.0.1', resolve)
          })
        })
      )
      expect(
        new Set(runtimes.map((runtime) => runtime.backend.opencodeUsageApi!.authorization)).size
      ).toBe(3)
    } finally {
      await Promise.all(
        listeners.map((listener) => new Promise<void>((resolve) => listener.close(() => resolve())))
      )
    }
  })

  it('copies warm plugin dependencies without sharing subsequent writes or copying auth', async () => {
    const { root, backend } = await fixture()
    const sourceRoot = join(backend.env.XDG_CONFIG_HOME, 'opencode')
    const modulePath = join('node_modules', '@opencode-ai', 'plugin', 'package.json')
    await mkdir(dirname(join(sourceRoot, modulePath)), { recursive: true })
    await writeFile(join(sourceRoot, modulePath), '{"version":"test"}')
    await writeFile(
      join(sourceRoot, 'package.json'),
      '{"dependencies":{"@opencode-ai/plugin":"test"}}'
    )
    await writeFile(join(sourceRoot, 'package-lock.json'), 'warm dependency lock')
    await writeFile(join(sourceRoot, 'auth.json'), 'synthetic-auth-must-not-copy')
    const runtime = await prepareOpenCodeRuntime(backend, join(root, 'attempt'))
    prepared.push(runtime)
    const target = join(runtime.backend.env.XDG_CONFIG_HOME, 'opencode')
    expect(await readFile(join(target, modulePath), 'utf8')).toBe('{"version":"test"}')
    expect(await readFile(join(target, 'package-lock.json'), 'utf8')).toBe('warm dependency lock')
    await writeFile(join(target, modulePath), 'child installer write')
    expect(await readFile(join(sourceRoot, modulePath), 'utf8')).toBe('{"version":"test"}')
    await expect(readFile(join(target, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('audits the actual file layer even when the authoritative env disables native delegation', async () => {
    const { root, backend } = await fixture()
    backend.opencodeConfigFiles = backend.opencodeConfigFiles!.map((file) =>
      file.path.endsWith('opencode.json')
        ? {
            ...file,
            content: JSON.stringify({ ...JSON.parse(file.content), permission: { task: 'allow' } })
          }
        : file
    )
    const runtime = await prepareOpenCodeRuntime(backend, join(root, 'attempt'))
    prepared.push(runtime)
    expect(() => assertOpenCodeNativeDelegationDisabled(runtime.modelConfig)).toThrow(
      'native delegation is not disabled'
    )
  })

  it.each(['malformed', 'missing-instruction'] as const)(
    'rejects %s snapshots without echoing configuration secrets',
    async (failure) => {
      const { root, backend } = await fixture()
      backend.opencodeConfigFiles =
        failure === 'malformed'
          ? [
              {
                path: backend.opencodeConfigFiles![0].path,
                content: '{synthetic-secret-do-not-expose'
              }
            ]
          : backend.opencodeConfigFiles!.filter((file) => !file.path.endsWith('connectors.md'))
      const result = await prepareOpenCodeRuntime(backend, join(root, 'attempt')).catch(
        (error: Error) => error
      )
      expect(result).toBeInstanceOf(Error)
      expect(String(result)).not.toContain('synthetic-secret')
    }
  )

  it('propagates an unreadable skills projection instead of silently dropping it', async () => {
    const { root, backend } = await fixture()
    // ENOTDIR is portable, unlike chmod permission tests under privileged test users.
    await rm(join(backend.env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
    await writeFile(join(backend.env.XDG_CONFIG_HOME, 'opencode'), 'not a directory')
    await expect(prepareOpenCodeRuntime(backend, join(root, 'attempt'))).rejects.toMatchObject({
      code: 'ENOTDIR'
    })
  })

  it('supports injected backends without files or a usage API and preserves bridge ownership', async () => {
    const { root, backend } = await fixture()
    delete backend.opencodeConfigFiles
    delete backend.env.XDG_CONFIG_HOME
    delete backend.opencodeUsageApi
    backend.args = []
    const lease = { setTarget: () => true, release: async () => undefined }
    backend.providerTransportLease = lease
    const runtime = await prepareOpenCodeRuntime(backend, join(root, 'attempt'))
    prepared.push(runtime)
    expect(runtime.backend.providerTransportLease).toBe(lease)
    expect(runtime.backend.opencodeUsageApi).toBeUndefined()
    expect(runtime.backend.args).toEqual([])
    expect(() => assertOpenCodeNativeDelegationDisabled(runtime.modelConfig)).not.toThrow()
  })
})
