import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import type { AgentModelConfig, ResolvedAgentBackend } from '../agent-framework'

// Keep app-owned candidates distinct until Attempt cleanup, including the interval before spawn.
// This is not an OS reservation after the probe closes; external port contention can still fail.
const activePorts = new Set<number>()

const claimPort = async (): Promise<number> => {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (address && typeof address !== 'string' && !activePorts.has(address.port)) {
        activePorts.add(address.port)
        return address.port
      }
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  throw new Error('Could not allocate a distinct OpenCode delegated usage port.')
}

const relativeConfigPath = (root: string, path: string): string => {
  const result = relative(root, path)
  if (!result || result === '..' || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    throw new Error('OpenCode delegated config file is outside its app-owned config directory.')
  }
  return result
}

const parseConfig = (content: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(content)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>
  } catch {
    // JSON parser messages may contain credentials from an injected config. Do not expose them.
  }
  throw new Error('OpenCode delegated config must be a JSON object.')
}

const replaceListenerArgs = (args: readonly string[], port: number): string[] => {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--port' || arg === '--hostname') index += 1
    else if (!arg.startsWith('--port=') && !arg.startsWith('--hostname=')) result.push(arg)
  }
  return [...result, '--port', String(port), '--hostname', '127.0.0.1']
}

type PreparedOpenCodeRuntime = Readonly<{
  backend: ResolvedAgentBackend
  modelConfig: AgentModelConfig
  dispose(): void
}>

// The caller owns runtimeHome cleanup. Only process resources are derived here: provider/model
// selection and bridge lease ownership remain with the admitted backend and its existing owner.
const prepareOpenCodeRuntime = async (
  admitted: ResolvedAgentBackend,
  runtimeHome: string
): Promise<PreparedOpenCodeRuntime> => {
  const configHome = join(runtimeHome, 'config')
  const configRoot = join(configHome, 'opencode')
  const sourceRoot = admitted.env.XDG_CONFIG_HOME
    ? join(admitted.env.XDG_CONFIG_HOME, 'opencode')
    : configRoot
  const env = {
    ...admitted.env,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: join(runtimeHome, 'data'),
    XDG_CACHE_HOME: join(runtimeHome, 'cache'),
    XDG_STATE_HOME: join(runtimeHome, 'state'),
    OPENCODE_TEST_HOME: join(runtimeHome, 'home')
  }
  await Promise.all(
    [
      configRoot,
      env.XDG_DATA_HOME,
      env.XDG_CACHE_HOME,
      env.XDG_STATE_HOME,
      env.OPENCODE_TEST_HOME
    ].map((path) => mkdir(path, { recursive: true, mode: 0o700 }))
  )

  // Injected backends need not have generated files. Production always carries the snapshot.
  const sourceFiles = admitted.opencodeConfigFiles ?? [
    {
      path: join(sourceRoot, 'opencode.json'),
      content: admitted.env.OPENCODE_CONFIG_CONTENT ?? '{}'
    },
    ...(admitted.persistentSystemPrompt
      ? [
          {
            path: join(sourceRoot, 'instructions', 'open-science.md'),
            content: admitted.persistentSystemPrompt
          }
        ]
      : [])
  ]
  const sourceConfig = sourceFiles.find((file) => file.path === join(sourceRoot, 'opencode.json'))
  if (!sourceConfig) throw new Error('OpenCode delegated config snapshot has no opencode.json.')
  const config = parseConfig(sourceConfig.content)
  if (!admitted.opencodeConfigFiles && admitted.persistentSystemPrompt) {
    config.instructions = [join(sourceRoot, 'instructions', 'open-science.md')]
  }
  if (Array.isArray(config.instructions)) {
    config.instructions = config.instructions.map((value: unknown) => {
      if (typeof value !== 'string' || !isAbsolute(value)) return value
      const instructionPath = relative(join(sourceRoot, 'instructions'), value)
      if (
        instructionPath === '..' ||
        instructionPath.startsWith(`..${sep}`) ||
        isAbsolute(instructionPath)
      )
        return value
      if (!sourceFiles.some((file) => file.path === value)) {
        throw new Error('OpenCode delegated instruction is missing from its config snapshot.')
      }
      return join(configRoot, relativeConfigPath(sourceRoot, value))
    })
  }
  const configFiles = sourceFiles.map((file) => ({
    ...file,
    path: join(configRoot, relativeConfigPath(sourceRoot, file.path)),
    content: file === sourceConfig ? JSON.stringify(config) : file.content
  }))
  for (const file of configFiles) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 })
    await writeFile(file.path, file.content, { mode: file.mode ?? 0o600 })
  }
  // Reuse app-materialized skills and warm plugin dependencies as independent copies. Otherwise
  // OpenCode waits for a fresh dependency install before every child can initialize. Generated
  // config/plugin/instructions still come from admission; never copy a database or auth store.
  if (admitted.env.XDG_CONFIG_HOME) {
    for (const entry of [
      'skills',
      'package.json',
      'package-lock.json',
      'bun.lock',
      'bun.lockb',
      'node_modules'
    ]) {
      const source = join(sourceRoot, entry)
      try {
        await lstat(source)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        continue
      }
      await cp(source, join(configRoot, entry), { recursive: true, dereference: true })
    }
  }

  const port = admitted.opencodeUsageApi ? await claimPort() : undefined
  const password = port === undefined ? undefined : randomUUID()
  const backend: ResolvedAgentBackend = {
    ...admitted,
    env: { ...env, ...(password ? { OPENCODE_SERVER_PASSWORD: password } : {}) },
    args:
      port === undefined
        ? [...(admitted.args ?? [])]
        : replaceListenerArgs(admitted.args ?? [], port),
    opencodeConfigFiles: configFiles,
    ...(password
      ? {
          opencodeUsageApi: {
            baseUrl: `http://127.0.0.1:${port}`,
            authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
          }
        }
      : {})
  }
  let disposed = false
  return {
    backend,
    modelConfig: { env: backend.env, configFiles },
    dispose: () => {
      if (disposed) return
      disposed = true
      if (port !== undefined) activePorts.delete(port)
    }
  }
}

export { prepareOpenCodeRuntime }
export type { PreparedOpenCodeRuntime }
