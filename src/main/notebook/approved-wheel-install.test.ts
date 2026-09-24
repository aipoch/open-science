import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { installApprovedWheels, parseWheelInstallPlan } from './approved-wheel-install'

const digest = 'a'.repeat(64)
type WheelReportEntry = {
  metadata: { name: string; version: string }
  requested: boolean
  download_info: { url: string; archive_info: { hashes: { sha256: string } } }
}
const wheel = (name: string, requested: boolean): WheelReportEntry => ({
  metadata: { name, version: '2.0' },
  requested,
  download_info: {
    url: `https://files.example.org/${name}-2.0-py3-none-any.whl`,
    archive_info: { hashes: { sha256: digest } }
  }
})
const report = (): { version: string; install: WheelReportEntry[] } => ({
  version: '1',
  install: [wheel('example', true), wheel('dependency', false)]
})
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  cacheRoot: string
  packages: string[]
  run: Mock<(args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>>
}> {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'wheel-review-'))
  roots.push(cacheRoot)
  const run = vi.fn(async (args: string[]) => {
    if (args.includes('--report'))
      await writeFile(args[args.indexOf('--report') + 1], JSON.stringify(report()))
    return { code: 0, stdout: '', stderr: '' }
  })
  return { cacheRoot, packages: ['example'], run }
}

describe('approved wheel installation', () => {
  it('approves all dependencies once and executes only the hash-pinned plan without resolving again', async () => {
    const fixtureOptions = await fixture()
    const approve = vi
      .fn<import('./approved-wheel-install').ApproveWheelInstall>()
      .mockResolvedValue(true)
    expect((await installApprovedWheels({ ...fixtureOptions, approve })).ok).toBe(true)
    expect(approve).toHaveBeenCalledOnce()
    expect(approve.mock.calls[0]?.[0]).toMatchObject({
      packages: [
        { name: 'example', requested: true },
        { name: 'dependency', requested: false }
      ]
    })
    expect(fixtureOptions.run.mock.calls[1][0]).toEqual([
      '--isolated',
      '--disable-pip-version-check',
      '--no-input',
      'install',
      '--no-deps',
      '--only-binary=:all:',
      `https://files.example.org/example-2.0-py3-none-any.whl#sha256=${digest}`,
      `https://files.example.org/dependency-2.0-py3-none-any.whl#sha256=${digest}`
    ])
  })
  it('denial or cancellation never starts the installer', async () => {
    const options = await fixture()
    expect((await installApprovedWheels({ ...options, approve: async () => false })).ok).toBe(false)
    expect(options.run).toHaveBeenCalledOnce()
    const controller = new AbortController()
    await expect(
      installApprovedWheels({
        ...options,
        signal: controller.signal,
        approve: async () => {
          controller.abort()
          return true
        }
      })
    ).rejects.toThrow()
    expect(options.run).toHaveBeenCalledTimes(2)
  })
  it.each([
    '--target=/escape',
    'git+https://example.org/code',
    './source',
    'https://example.org/source.tar.gz'
  ])('rejects pre-approval execution input %s', async (spec) => {
    const options = await fixture()
    expect(
      (await installApprovedWheels({ ...options, packages: [spec], approve: async () => true })).ok
    ).toBe(false)
    expect(options.run).not.toHaveBeenCalled()
  })
  it('rejects source artifacts, missing hashes, duplicate names and credentials in solver output', () => {
    for (const mutate of [
      (entry: ReturnType<typeof wheel>) => {
        entry.download_info.url = 'https://example.org/source.tar.gz'
      },
      (entry: ReturnType<typeof wheel>) => {
        entry.download_info.archive_info.hashes.sha256 = ''
      },
      (entry: ReturnType<typeof wheel>) => {
        entry.download_info.url = 'https://secret:token@example.org/x.whl'
      }
    ]) {
      const entry = wheel('example', true)
      mutate(entry)
      expect(() => parseWheelInstallPlan({ version: '1', install: [entry] })).toThrow()
    }
    expect(() =>
      parseWheelInstallPlan({ version: '1', install: [wheel('a_b', true), wheel('a-b', false)] })
    ).toThrow()
  })
  it('does not fall back or treat an interrupted installation as success', async () => {
    const options = await fixture()
    options.run
      .mockImplementationOnce(async (args) => {
        await writeFile(args[args.indexOf('--report') + 1], JSON.stringify(report()))
        return { code: 0, stdout: '', stderr: '' }
      })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'partial installation' })
    expect((await installApprovedWheels({ ...options, approve: async () => true })).ok).toBe(false)
    expect(options.run).toHaveBeenCalledTimes(2)
  })
})
