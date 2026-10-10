import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElectronCallerContext } from '../caller-context'
import {
  createResearchMaterialInspectionAuthority,
  type ResearchMaterialAuthorityDependencies
} from '../notebook/research-material-authority'
import type { ResearchMaterialAuthority } from '../notebook/research-materials'
import { createResearchRunInspectionPort, type ResearchRunInspectionPort } from './inspection'
import type { ResearchReproductionDescription } from '../../shared/research-reproduction'

vi.mock('../notebook/research-material-authority', () => ({
  createResearchMaterialInspectionAuthority: vi.fn()
}))
const request = { projectId: 'project', sourceSessionId: 'source', sourceImportId: 'import-1' }
const caller = createElectronCallerContext(1)
const bytes = Buffer.from('shared input')
const sha = (content: Buffer): string => createHash('sha256').update(content).digest('hex')
const description = (): ResearchReproductionDescription => ({
  format: 'open-science-reproduction-description',
  descriptionVersion: 1,
  title: 'Offline check',
  materials: [
    {
      key: 'code',
      role: 'script',
      availability: 'included',
      filename: 'test.js',
      restorePath: 'test.js',
      sha256: sha(bytes),
      sizeBytes: bytes.length
    },
    { key: 'private_data', role: 'data', availability: 'withheld', description: 'Not shared' }
  ],
  plans: [
    {
      key: 'check',
      title: 'Engineering check',
      scope: 'engineering-check',
      materialKeys: ['code'],
      claim: 'Runs offline',
      limitations: ['Not the full study'],
      entrypoints: [{ materialKey: 'code', arguments: ['do-not-expose-this'] }],
      requirements: { node: '>=22', platforms: ['darwin'] }
    },
    {
      key: 'full',
      title: 'Full study',
      scope: 'end-to-end',
      materialKeys: ['code', 'private_data'],
      claim: 'Full result',
      limitations: []
    }
  ],
  secrets: [
    {
      key: 'credential',
      description: 'Do not disclose',
      required: true,
      environmentVariable: 'RESEARCH_KEY',
      planKeys: ['full']
    }
  ]
})
function fixture(descriptor: unknown = description()): {
  authority: ResearchMaterialAuthority
  runtimes: { runtimes: ReturnType<typeof vi.fn> }
  assertOpen: ReturnType<typeof vi.fn>
  port: ResearchRunInspectionPort
} {
  const content = Buffer.from(
    typeof descriptor === 'string' ? descriptor : JSON.stringify(descriptor)
  )
  const source = {
    projectId: 'project',
    sessionId: 'source',
    title: 'Research',
    identity: 'research-materials:frozen'
  }
  const authority: ResearchMaterialAuthority = {
    source,
    versions: [
      {
        versionId: 'descriptor',
        filename: 'research-reproduction.json',
        sha256: sha(content),
        sizeBytes: content.length,
        sourceIdentity: source.identity
      },
      {
        versionId: 'input',
        filename: 'test.js',
        sha256: sha(bytes),
        sizeBytes: bytes.length,
        sourceIdentity: source.identity
      }
    ],
    readVersion: vi.fn(async (id) => (id === 'descriptor' ? content : bytes))
  }
  vi.mocked(createResearchMaterialInspectionAuthority).mockResolvedValue(authority)
  const runtimes = {
    runtimes: vi.fn(async () => ({
      available: true,
      runtimes: [
        {
          runtimeId: 'a'.repeat(64),
          kind: 'node' as const,
          version: '22.10.0',
          platform: 'darwin' as const,
          arch: 'arm64',
          sha256: 'b'.repeat(64),
          executable: '/private/runtime'
        }
      ],
      diagnostics: { nativeServiceSupported: true, issues: [] }
    }))
  }
  const assertOpen = vi.fn()
  return {
    authority,
    runtimes,
    assertOpen,
    port: createResearchRunInspectionPort({
      materials: {} as ResearchMaterialAuthorityDependencies,
      runtimes,
      assertOpen
    })
  }
}

beforeEach(() => vi.clearAllMocks())
describe('read-only research run inspection', () => {
  it('returns package plan choices and retained material readiness without host paths or secret/argument fields', async () => {
    const f = fixture()
    const result = await f.port.inspect(request, caller)
    expect(result.status).toBe('ready')
    expect(result.source).toMatchObject({
      importId: 'import-1',
      identity: 'research-materials:frozen'
    })
    expect(result.plans[0]).toMatchObject({
      materialReady: true,
      requiresSecrets: false,
      materials: [{ key: 'code', status: 'available', versionIds: ['input'] }],
      entrypoints: [{ materialKey: 'code' }]
    })
    expect(result.plans[1]).toMatchObject({
      materialReady: false,
      requiresSecrets: true,
      materials: [
        { key: 'code', status: 'available' },
        { key: 'private_data', status: 'withheld' }
      ]
    })
    expect(JSON.stringify(result)).not.toMatch(
      /private\/runtime|RESEARCH_KEY|do-not-expose-this|executable|readOnlyRoots/
    )
    expect(createResearchMaterialInspectionAuthority).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        expectedSourceIdentity: 'research-materials:frozen',
        sourceImportId: 'import-1'
      })
    )
  })

  it.each([
    { node: '>=22', platforms: ['darwin'], compatible: true },
    { node: '^22.0.0 || >=24', platforms: ['darwin'], compatible: true },
    { node: '>=24', platforms: ['darwin'], compatible: false },
    { node: '>=22', platforms: ['linux'], compatible: false },
    { node: 'not a range', platforms: ['darwin'], compatible: false }
  ])(
    'checks declared runtime requirements with SemVer: $node / $platforms',
    async ({ node, platforms, compatible }) => {
      const input = description()
      input.plans[0].requirements = {
        node,
        platforms: platforms as ('darwin' | 'linux' | 'win32')[]
      }
      const f = fixture(input)
      const inspected = await f.port.inspect(request, caller)
      expect(inspected.plans[0].compatibleRuntimeIds).toEqual(compatible ? ['a'.repeat(64)] : [])
    }
  )

  it('requires explicit selection when more than one retained descriptor exists', async () => {
    const f = fixture()
    f.authority.versions = [
      ...f.authority.versions,
      { ...f.authority.versions[0], versionId: 'descriptor-2' }
    ]
    expect((await f.port.inspect(request, caller)).status).toBe('choose-description')
    expect(f.authority.readVersion).not.toHaveBeenCalled()
    expect(
      (await f.port.inspect({ ...request, descriptorVersionId: 'descriptor' }, caller)).status
    ).toBe('ready')
  })

  it.each(['invalid', 'unsupported', 'no-description'] as const)(
    'reports %s without inventing a runnable plan',
    async (status) => {
      const f = fixture(
        status === 'invalid' ? 'invalid JSON' : { ...description(), descriptionVersion: 2 }
      )
      if (status === 'no-description') f.authority.versions = f.authority.versions.slice(1)
      const result = await f.port.inspect(request, caller)
      expect(result.status).toBe(status)
      expect(result.plans).toEqual([])
    }
  )

  it('rejects arbitrary Version selection and expected identity conflicts', async () => {
    const f = fixture()
    await expect(
      f.port.inspect({ ...request, descriptorVersionId: 'input' }, caller)
    ).rejects.toThrow('research-run-inspection-unavailable')
    vi.mocked(createResearchMaterialInspectionAuthority).mockRejectedValueOnce(
      new Error('/private/secret receipt mismatch')
    )
    await expect(
      f.port.inspect({ ...request, expectedSourceIdentity: 'old' }, caller)
    ).rejects.toThrow(/^research-run-inspection-unavailable$/)
    expect(createResearchMaterialInspectionAuthority).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ expectedSourceIdentity: 'old' })
    )
  })

  it('rejects a caller revoked during asynchronous probing and a changed source during final revalidation', async () => {
    const f = fixture()
    let current = true
    f.runtimes.runtimes.mockImplementationOnce(async () => {
      current = false
      return {
        available: false,
        runtimes: [],
        diagnostics: { nativeServiceSupported: false, issues: [] }
      }
    })
    await expect(
      f.port.inspect(request, { ...caller, isAuthorizationCurrent: () => current })
    ).rejects.toThrow('research-run-inspection-unavailable')
    current = true
    vi.mocked(createResearchMaterialInspectionAuthority)
      .mockResolvedValueOnce(f.authority)
      .mockRejectedValueOnce(new Error('import changed'))
    await expect(f.port.inspect(request, caller)).rejects.toThrow(
      'research-run-inspection-unavailable'
    )
  })

  it('rejects unexpected execution fields before reading anything', async () => {
    const f = fixture()
    await expect(f.port.inspect({ ...request, command: 'run' }, caller)).rejects.toThrow(
      'research-run-inspection-invalid-request'
    )
    expect(createResearchMaterialInspectionAuthority).not.toHaveBeenCalled()
    await expect(f.port.inspect(request, { ...caller, location: 'remote' })).rejects.toThrow(
      'research-run-inspection-unavailable'
    )
    expect(createResearchMaterialInspectionAuthority).not.toHaveBeenCalled()
  })
})
