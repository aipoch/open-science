import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MCP_DEPENDENCY_NAME,
  buildMcpDependencyDiagnostic,
  checkMcpDependency,
  createMcpDependencyError,
  findMcpInstallation,
  repairMcp,
  repairDesktopMcp,
  repairNpmMcp
} from './mcp-repair.mjs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('MCP dependency diagnostic', () => {
  it('gives an agent a stable repair action without touching MCP stdout', () => {
    const diagnostic = buildMcpDependencyDiagnostic({
      configRoot: 'C:/profiles/research',
      platform: 'win32',
      arch: 'x64',
      installation: 'npm'
    })
    expect(diagnostic).toEqual({
      code: 'mcp_dependency_missing',
      message: 'The Open-Science MCP runtime dependency is missing from this installation.',
      owner: 'deployment',
      dependency: MCP_DEPENDENCY_NAME,
      installation: 'npm',
      platform: 'win32',
      arch: 'x64',
      profile: 'C:/profiles/research',
      requiresUser: true,
      retryable: false,
      next: [
        {
          action: 'repair_mcp',
          executable: 'open-science',
          argv: ['repair', 'mcp', '--profile', 'C:/profiles/research', '--json']
        }
      ]
    })
    expect(JSON.stringify(diagnostic)).not.toContain('stdout')
  })

  it('classifies the installed dependency through the MCP entry subpath', async () => {
    await expect(
      checkMcpDependency({ resolve: () => '/fixture/sdk/server/mcp.js' })
    ).resolves.toEqual({ available: true, dependency: MCP_DEPENDENCY_NAME })
    await expect(
      checkMcpDependency({
        resolve: () => {
          throw new Error('missing')
        }
      })
    ).resolves.toEqual({ available: false, dependency: MCP_DEPENDENCY_NAME })
  })

  it('creates a structured error for MCP stderr and CLI JSON reporting', () => {
    const error = createMcpDependencyError({ configRoot: '/tmp/profile', installation: 'npm' })
    expect(error.code).toBe('mcp_dependency_missing')
    expect(error.details).toMatchObject({
      code: 'mcp_dependency_missing',
      owner: 'deployment',
      next: [{ action: 'repair_mcp' }]
    })
  })
})

describe('npm MCP repair', () => {
  it('upgrades the complete npm distribution and verifies the dependency afterward', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osci-mcp-repair-'))
    roots.push(root)
    const packageRoot = join(root, 'node_modules', '@aipoch', 'open-science')
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ private: true, dependencies: { '@aipoch/open-science': '1.3.2' } })
    )
    await mkdir(packageRoot, { recursive: true })
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@aipoch/open-science', version: '1.3.2' })
    )
    const cliPath = join(packageRoot, 'cli.mjs')
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const verifyMcp = vi.fn().mockResolvedValue({ initialize: true, toolsList: true, toolCount: 1 })
    let available = false
    const result = await repairNpmMcp({
      cliPath,
      profile: join(root, 'profile'),
      checkDependency: async () => ({
        available,
        dependency: MCP_DEPENDENCY_NAME
      }),
      exec: async (...args: unknown[]) => {
        available = true
        return exec(...args)
      },
      verifyMcp,
      platform: 'win32',
      arch: 'x64'
    })
    expect(result).toMatchObject({
      status: 'repaired',
      installation: 'npm',
      platform: 'win32',
      arch: 'x64'
    })
    expect(exec).toHaveBeenCalledWith(
      expect.stringMatching(/npm(?:\.cmd)?$/),
      ['install', '--global', '@aipoch/open-science@latest', '--include=optional'],
      expect.objectContaining({ cwd: dirname(dirname(dirname(packageRoot))) })
    )
    expect(verifyMcp).toHaveBeenCalledOnce()
  })
})

describe('desktop MCP repair', () => {
  it('detects a packaged desktop installation separately from npm', async () => {
    await expect(
      findMcpInstallation({
        cliPath: 'C:/Open-Science/resources/backend/mcp-repair.mjs',
        findNpm: async () => undefined,
        locateDesktop: async () => ({
          packaged: true,
          command: 'C:/Open-Science/open-science.exe'
        })
      })
    ).resolves.toEqual({
      kind: 'desktop',
      executable: 'C:/Open-Science/open-science.exe'
    })
  })

  it('uses the official desktop updater and verifies one same-profile MCP handshake', async () => {
    const profile = 'C:/profiles/research'
    const calls: string[] = []
    const client = {
      configRoot: profile,
      callRpc: vi.fn(async (channel: string) => {
        calls.push(channel)
        if (channel === 'update:check')
          return { state: 'available', current: '1.3.2', latest: '1.3.3' }
        if (channel === 'update:download')
          return { state: 'ready', current: '1.3.2', latest: '1.3.3' }
        if (channel === 'update:apply')
          return { state: 'applying', current: '1.3.2', latest: '1.3.3' }
        if (channel === 'update:get-app-info')
          return { name: 'Open-Science', version: '1.3.3', copyright: 'fixture' }
        throw new Error(`Unexpected update channel: ${channel}`)
      })
    }
    const connect = vi.fn(async () => client)
    const verifyMcp = vi.fn(async () => ({ initialize: true, toolsList: true, toolCount: 3 }))

    await expect(
      repairDesktopMcp({
        profile,
        cliPath: 'C:/Open-Science/resources/backend/mcp-repair.mjs',
        installation: { kind: 'desktop', executable: 'C:/Open-Science/open-science.exe' },
        platform: 'win32',
        arch: 'x64',
        connect,
        verifyMcp,
        sleep: async () => {}
      })
    ).resolves.toMatchObject({
      status: 'repaired',
      installation: 'desktop',
      profile,
      platform: 'win32',
      arch: 'x64',
      version: '1.3.3',
      verification: { initialize: true, toolsList: true, toolCount: 3 }
    })
    expect(calls).toEqual([
      'update:check',
      'update:download',
      'update:apply',
      'update:get-app-info'
    ])
    expect(connect).toHaveBeenCalledTimes(2)
    expect(verifyMcp).toHaveBeenCalledOnce()
    expect(verifyMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        profile,
        cliPath: 'C:/Open-Science/resources/backend/mcp-repair.mjs'
      })
    )
  })

  it('keeps the desktop installation untouched when the selected profile is not active', async () => {
    const update = vi.fn()
    const result = await repairDesktopMcp({
      profile: 'C:/profiles/research',
      installation: { kind: 'desktop', executable: 'C:/Open-Science/open-science.exe' },
      connect: async () => ({
        configRoot: 'C:/profiles/other',
        callRpc: update
      })
    })

    expect(result).toMatchObject({
      status: 'failed',
      installation: 'desktop',
      error: { code: 'mcp_repair_profile_mismatch' }
    })
    expect(update).not.toHaveBeenCalled()
  })
})

describe('standalone archive MCP repair dispatch', () => {
  it('classifies a standalone archive before the npm fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osci-mcp-archive-dispatch-'))
    roots.push(root)
    const archive = join(root, 'open-science-cli-1.3.2-win32-x64')
    await mkdir(join(archive, 'backend'), { recursive: true })
    await mkdir(join(archive, 'node-runtime'), { recursive: true })
    await writeFile(join(archive, 'backend', 'cli.mjs'), '')
    await writeFile(join(archive, 'node-runtime', 'node.exe'), '')
    await writeFile(
      join(archive, 'release.json'),
      JSON.stringify({ version: '1.3.2', target: 'win32-x64', sourceSha: 'a'.repeat(40) })
    )
    const cliPath = join(archive, 'backend', 'cli.mjs')
    await expect(
      findMcpInstallation({ cliPath, platform: 'win32', arch: 'x64' })
    ).resolves.toMatchObject({
      kind: 'archive',
      root: archive,
      target: 'win32-x64'
    })
    await expect(
      repairMcp({
        profile: join(root, 'profile'),
        cliPath,
        platform: 'win32',
        arch: 'x64',
        checkDependency: async () => ({ available: true })
      })
    ).resolves.toMatchObject({
      status: 'already_healthy',
      installation: 'archive',
      root: archive
    })
  })
})
