import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareMcpStdioLaunch } from './mcp-stdio-launch'

// Isolate system discovery without mocking the filesystem or the launch resolver.
vi.mock('../settings/shell-path', () => ({ augmentedPathEnv: (env: unknown) => env }))

let root: string
let node: string
let bin: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp launch space-'))
  node = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  bin = join(root, 'system bin')
  await mkdir(bin, { recursive: true })
  for (const name of ['npm', 'npx']) {
    const path = join(dirname(node), 'node_modules/npm/bin', `${name}-cli.js`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'fixture')
  }
  await writeFile(join(dirname(node), 'version.json'), '{"stagingVersion":2}')
  vi.stubGlobal('process', { ...process, execPath: node })
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

const launch = (command = 'npx', env = { PATH: bin }): ReturnType<typeof prepareMcpStdioLaunch> =>
  prepareMcpStdioLaunch({ command, args: ['--yes', 'package name', 'a&b', '$(literal)'], env })

it.each(['npm', 'npx'])('uses bundled %s and its matching Node only when absent', (command) => {
  const result = launch(command)
  expect(result.command).toBe(node)
  expect(result.args).toEqual([
    join(dirname(node), 'node_modules/npm/bin', `${command}-cli.js`),
    '--yes',
    'package name',
    'a&b',
    '$(literal)'
  ])
  expect(result.env.PATH.split(delimiter)).toEqual([dirname(node), bin])
})

it.each(['npm', 'npx'])('preserves the installed %s and environment', async (command) => {
  const path = join(bin, command + (process.platform === 'win32' ? '.cmd' : ''))
  await writeFile(path, 'a failing installed command must not trigger another launch')
  await chmod(path, 0o755)
  const env = { PATH: bin, SECRET: 'configured', npm_config_cache: join(root, 'cache') }
  expect(launch(command, env)).toEqual({
    command,
    args: ['--yes', 'package name', 'a&b', '$(literal)'],
    env
  })
})

it('never replaces explicit paths or unrelated commands', () => {
  for (const command of [join(root, 'missing', 'npx'), './npx', '../npm', 'uvx', 'node'])
    expect(launch(command).command).toBe(command)
})

it('leaves the original error path when no bundle is installed', async () => {
  await rm(join(dirname(node), 'node_modules/npm'), { recursive: true })
  expect(launch().command).toBe('npx')
})

it('does not mistake a directory for an installed executable', async () => {
  await mkdir(join(bin, 'npx'))
  expect(launch().command).toBe(node)
})

it.runIf(process.platform !== 'win32')('ignores files without execute permission', async () => {
  await writeFile(join(bin, 'npx'), 'not executable', { mode: 0o600 })
  expect(launch().command).toBe(node)
})

it.runIf(process.platform === 'win32')(
  'honors Path casing, PATHEXT and explicit cmd names',
  async () => {
    await writeFile(join(bin, 'npx.CUSTOM'), 'custom executable')
    const env = { PATH: join(root, 'wrong'), Path: bin, PATHEXT: '.CUSTOM;.CMD' }
    expect(launch('npx', env)).toMatchObject({ command: 'npx', env: { PATH: bin } })
    expect(launch('npx', env).env).not.toHaveProperty('Path')
    expect(launch('npx.cmd').command).toBe(node)
    await writeFile(join(bin, 'npx.cmd'), 'installed cmd')
    expect(launch('npx.cmd').command).toBe('npx.cmd')
  }
)
