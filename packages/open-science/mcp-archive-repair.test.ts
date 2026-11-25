import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findStandaloneInstallation,
  repairStandaloneMcp,
  verifyStandaloneSignature
} from './mcp-archive-repair.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('standalone archive detection', () => {
  it('identifies the archive root and release target from the bundled CLI path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-archive-repair-'))
    roots.push(root)
    const archive = join(root, 'open-science-cli-1.3.2-win32-x64')
    await mkdir(join(archive, 'backend'), { recursive: true })
    await mkdir(join(archive, 'node-runtime'), { recursive: true })
    await writeFile(join(archive, 'backend', 'cli.mjs'), '')
    await writeFile(join(archive, 'node-runtime', 'node.exe'), '')
    await writeFile(
      join(archive, 'release.json'),
      JSON.stringify({
        version: '1.3.2',
        target: 'win32-x64',
        sourceSha: 'a'.repeat(40),
        nodeVersion: '22.23.4'
      })
    )

    await expect(
      findStandaloneInstallation({
        cliPath: join(archive, 'backend', 'mcp-repair.mjs'),
        platform: 'win32',
        arch: 'x64'
      })
    ).resolves.toMatchObject({
      kind: 'archive',
      root: archive,
      version: '1.3.2',
      target: 'win32-x64',
      sourceSha: 'a'.repeat(40)
    })
  })
})

it('installs a verified complete archive beside the old tree before reporting MCP recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-archive-repair-success-'))
  roots.push(root)
  const archive = join(root, 'open-science-cli-1.3.2-win32-x64')
  await mkdir(join(archive, 'backend'), { recursive: true })
  await mkdir(join(archive, 'node-runtime'), { recursive: true })
  await writeFile(join(archive, 'backend', 'cli.mjs'), '')
  await writeFile(join(archive, 'backend', 'mcp-repair.mjs'), '')
  await writeFile(join(archive, 'node-runtime', 'node.exe'), '')
  await writeFile(
    join(archive, 'release.json'),
    JSON.stringify({
      version: '1.3.2',
      target: 'win32-x64',
      sourceSha: 'a'.repeat(40),
      nodeVersion: '22.23.4'
    })
  )
  const installation = await findStandaloneInstallation({
    cliPath: join(archive, 'backend', 'mcp-repair.mjs'),
    platform: 'win32',
    arch: 'x64'
  })
  expect(installation).toBeDefined()

  const bytes = Buffer.from('complete official archive')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const filename = 'open-science-cli-1.3.3-win32-x64.zip'
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith('SHA256SUMS.txt')) return new Response(`${sha256}  ${filename}\n`)
    return new Response(bytes)
  })
  const extractArchive = vi.fn(
    async ({ archivePath, expectedRoot }: { archivePath: string; expectedRoot: string }) => {
      expect(await readFile(archivePath)).toEqual(bytes)
      await mkdir(join(expectedRoot, 'backend'), { recursive: true })
      await mkdir(join(expectedRoot, 'node-runtime'), { recursive: true })
      await writeFile(join(expectedRoot, 'backend', 'cli.mjs'), '')
      await writeFile(join(expectedRoot, 'backend', 'mcp-repair.mjs'), '')
      await writeFile(join(expectedRoot, 'node-runtime', 'node.exe'), '')
      await writeFile(
        join(expectedRoot, 'release.json'),
        JSON.stringify({
          version: '1.3.3',
          target: 'win32-x64',
          sourceSha: 'b'.repeat(40),
          nodeVersion: '22.23.5'
        })
      )
    }
  )
  const verifySignature = vi.fn().mockResolvedValue(undefined)
  const verifyMcp = vi.fn().mockResolvedValue({
    initialize: 'verified',
    toolsList: 'verified',
    toolCount: 28
  })
  const profile = join(root, 'profile')
  await writeFile(profile, 'profile marker')

  const result = await repairStandaloneMcp({
    profile,
    installation,
    platform: 'win32',
    arch: 'x64',
    checkDependency: async () => ({ available: false }),
    fetchImpl,
    extractArchive,
    verifySignature,
    verifyMcp
  })

  expect(result).toMatchObject({
    status: 'repaired',
    installation: 'archive',
    version: '1.3.3',
    platform: 'win32',
    arch: 'x64',
    profile,
    root: expect.stringContaining('open-science-cli-1.3.2-win32-x64-repaired-')
  })
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  expect(fetchImpl.mock.calls[0][0]).toContain('/releases/latest/download/SHA256SUMS.txt')
  expect(fetchImpl.mock.calls[1][0]).toContain(`/releases/latest/download/${filename}`)
  expect(extractArchive).toHaveBeenCalledOnce()
  expect(verifySignature).toHaveBeenCalledOnce()
  expect(verifyMcp).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ profile, platform: 'win32', arch: 'x64' })
  )
  expect(await readFile(profile, 'utf8')).toBe('profile marker')
  expect(await readFile(join(archive, 'release.json'), 'utf8')).toContain('1.3.2')
})

it('preserves the old archive when the official download fails checksum verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-archive-repair-checksum-'))
  roots.push(root)
  const archive = join(root, 'open-science-cli-1.3.2-win32-x64')
  await mkdir(join(archive, 'backend'), { recursive: true })
  await mkdir(join(archive, 'node-runtime'), { recursive: true })
  await writeFile(join(archive, 'backend', 'cli.mjs'), 'old cli')
  await writeFile(join(archive, 'node-runtime', 'node.exe'), 'old node')
  await writeFile(
    join(archive, 'release.json'),
    JSON.stringify({ version: '1.3.2', target: 'win32-x64', sourceSha: 'a'.repeat(40) })
  )
  const installation = await findStandaloneInstallation({
    cliPath: join(archive, 'backend', 'cli.mjs'),
    platform: 'win32',
    arch: 'x64'
  })
  const fetchImpl = vi.fn(async (url: string) =>
    url.endsWith('SHA256SUMS.txt')
      ? new Response(`${'0'.repeat(64)}  open-science-cli-1.3.3-win32-x64.zip\n`)
      : new Response('tampered bytes')
  )
  const extractArchive = vi.fn()
  const verifyMcp = vi.fn()

  const result = await repairStandaloneMcp({
    profile: join(root, 'profile'),
    installation,
    platform: 'win32',
    arch: 'x64',
    checkDependency: async () => ({ available: false }),
    fetchImpl,
    extractArchive,
    verifyMcp
  })

  expect(result).toMatchObject({
    status: 'failed',
    error: { code: 'mcp_repair_verification_failed' }
  })
  expect(extractArchive).not.toHaveBeenCalled()
  expect(verifyMcp).not.toHaveBeenCalled()
  expect(await readFile(join(archive, 'backend', 'cli.mjs'), 'utf8')).toBe('old cli')
  expect(await readFile(join(archive, 'node-runtime', 'node.exe'), 'utf8')).toBe('old node')
})

it('does not activate a verified archive when its one MCP handshake fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-archive-repair-mcp-'))
  roots.push(root)
  const archive = join(root, 'open-science-cli-1.3.2-win32-x64')
  await mkdir(join(archive, 'backend'), { recursive: true })
  await mkdir(join(archive, 'node-runtime'), { recursive: true })
  await writeFile(join(archive, 'backend', 'cli.mjs'), 'old cli')
  await writeFile(join(archive, 'node-runtime', 'node.exe'), 'old node')
  await writeFile(
    join(archive, 'release.json'),
    JSON.stringify({ version: '1.3.2', target: 'win32-x64', sourceSha: 'a'.repeat(40) })
  )
  const installation = await findStandaloneInstallation({
    cliPath: join(archive, 'backend', 'cli.mjs'),
    platform: 'win32',
    arch: 'x64'
  })
  const bytes = Buffer.from('complete archive without usable MCP')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const filename = 'open-science-cli-1.3.3-win32-x64.zip'
  const fetchImpl = vi.fn(async (url: string) =>
    url.endsWith('SHA256SUMS.txt') ? new Response(`${sha256}  ${filename}\n`) : new Response(bytes)
  )
  const extractArchive = vi.fn(async ({ expectedRoot }: { expectedRoot: string }) => {
    await mkdir(join(expectedRoot, 'backend'), { recursive: true })
    await mkdir(join(expectedRoot, 'node-runtime'), { recursive: true })
    await writeFile(join(expectedRoot, 'backend', 'cli.mjs'), 'new cli')
    await writeFile(join(expectedRoot, 'node-runtime', 'node.exe'), 'new node')
    await writeFile(
      join(expectedRoot, 'release.json'),
      JSON.stringify({ version: '1.3.3', target: 'win32-x64', sourceSha: 'b'.repeat(40) })
    )
  })
  const verifyMcp = vi.fn().mockRejectedValue(new Error('tools/list unavailable'))

  const result = await repairStandaloneMcp({
    profile: join(root, 'profile'),
    installation,
    platform: 'win32',
    arch: 'x64',
    checkDependency: async () => ({ available: false }),
    fetchImpl,
    extractArchive,
    verifySignature: vi.fn().mockResolvedValue(undefined),
    verifyMcp
  })

  expect(result).toMatchObject({
    status: 'failed',
    error: {
      code: 'mcp_repair_mcp_unavailable',
      retryable: false
    }
  })
  expect(verifyMcp).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ profile: join(root, 'profile') })
  )
  expect(await readFile(join(archive, 'backend', 'cli.mjs'), 'utf8')).toBe('old cli')
  expect(await readFile(join(archive, 'node-runtime', 'node.exe'), 'utf8')).toBe('old node')
})

it('rejects an archive target mismatch before downloading a replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-archive-repair-target-'))
  roots.push(root)
  const archive = join(root, 'open-science-cli-1.3.2-win32-x64')
  await mkdir(join(archive, 'backend'), { recursive: true })
  await mkdir(join(archive, 'node-runtime'), { recursive: true })
  await writeFile(join(archive, 'backend', 'cli.mjs'), 'old cli')
  await writeFile(join(archive, 'node-runtime', 'node.exe'), 'old node')
  await writeFile(
    join(archive, 'release.json'),
    JSON.stringify({ version: '1.3.2', target: 'win32-x64', sourceSha: 'a'.repeat(40) })
  )
  const installation = await findStandaloneInstallation({
    cliPath: join(archive, 'backend', 'cli.mjs'),
    platform: 'win32',
    arch: 'arm64'
  })
  const fetchImpl = vi.fn()

  const result = await repairStandaloneMcp({
    profile: join(root, 'profile'),
    installation,
    platform: 'win32',
    arch: 'arm64',
    checkDependency: async () => ({ available: false }),
    fetchImpl
  })

  expect(result).toMatchObject({
    status: 'failed',
    error: { code: 'mcp_repair_incompatible_target' }
  })
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(await readFile(join(archive, 'backend', 'cli.mjs'), 'utf8')).toBe('old cli')
})

it('reports a stable download error when the official transport fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-archive-repair-download-'))
  roots.push(root)
  const archive = join(root, 'open-science-cli-1.3.2-win32-x64')
  await mkdir(join(archive, 'backend'), { recursive: true })
  await mkdir(join(archive, 'node-runtime'), { recursive: true })
  await writeFile(join(archive, 'backend', 'cli.mjs'), 'old cli')
  await writeFile(join(archive, 'node-runtime', 'node.exe'), 'old node')
  await writeFile(
    join(archive, 'release.json'),
    JSON.stringify({ version: '1.3.2', target: 'win32-x64', sourceSha: 'a'.repeat(40) })
  )
  const installation = await findStandaloneInstallation({
    cliPath: join(archive, 'backend', 'cli.mjs'),
    platform: 'win32',
    arch: 'x64'
  })
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith('SHA256SUMS.txt'))
      return new Response(`${'0'.repeat(64)}  open-science-cli-1.3.3-win32-x64.zip\n`)
    const error = Object.assign(new Error('request timed out'), { code: 23 })
    throw error
  })

  const result = await repairStandaloneMcp({
    profile: join(root, 'profile'),
    installation,
    platform: 'win32',
    arch: 'x64',
    checkDependency: async () => ({ available: false }),
    fetchImpl
  })

  expect(result).toMatchObject({
    status: 'failed',
    error: { code: 'mcp_repair_download_failed' }
  })
})

it('passes the archive root and signature mode to the Windows verifier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-archive-signature-'))
  roots.push(root)
  const exec = vi.fn().mockResolvedValue({})

  await verifyStandaloneSignature({ root, platform: 'win32', exec })

  expect(exec).toHaveBeenCalledWith(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      expect.stringContaining('.mcp-signature-'),
      root,
      'stable'
    ],
    expect.objectContaining({ timeout: expect.any(Number), windowsHide: true })
  )
})
