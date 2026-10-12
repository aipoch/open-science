import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { NotebookRunInputFile } from '../../shared/notebook'
import type { HostArtifactCatalogItem } from '../../shared/project-files'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ImmutableInputContentLease } from '../immutable-input-authority'
import { inspectResearchMaterials } from './research-materials'
import {
  createResearchMaterialAuthority,
  createResearchMaterialInspectionAuthority,
  resolvePreparedResearchMaterialInput,
  type ResearchMaterialAuthorityDependencies,
  type ResearchPackageMaterialOrigin
} from './research-material-authority'

const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const session = (id: string): PersistedChatSession => ({
  id,
  projectId: 'project',
  title: id,
  createdAt: 1,
  updatedAt: 1,
  cwd: '',
  status: 'idle',
  messages: []
})
const request = { projectId: 'project', sourceSessionId: 'research', targetSessionId: 'discussion' }
type TestVersion = {
  row: HostArtifactCatalogItem
  input: NotebookRunInputFile
  content: Buffer
  latest: boolean
}
type TestFixture = {
  dependencies: ResearchMaterialAuthorityDependencies
  sessions: Map<string, PersistedChatSession>
  versions: Map<string, TestVersion>
  origin: ResearchPackageMaterialOrigin
  add(
    versionId: string,
    options?: {
      sessionId?: string
      projectId?: string
      filename?: string
      content?: Buffer
      latest?: boolean
      source?: 'artifact' | 'upload'
    }
  ): TestVersion
  include(versionId: string): void
  useOrigin(kind?: 'import' | 'fork'): void
  controls: { onRead?: () => void; verificationError?: Error; readSizes: number[] }
  leases: ImmutableInputContentLease[]
}
const fixture = (): TestFixture => {
  const sessions = new Map(['research', 'discussion', 'other'].map((id) => [id, session(id)]))
  const versions = new Map<string, TestVersion>()
  const controls: { onRead?: () => void; verificationError?: Error; readSizes: number[] } = {
    readSizes: []
  }
  const leases: ImmutableInputContentLease[] = []
  const origin: ResearchPackageMaterialOrigin = {
    receiptIdentity: { importId: 'import-1', manifestChecksum: 'a'.repeat(64) },
    sourceManifest: {
      format: 'open-science-session',
      schemaVersion: 1,
      createdAt: 1,
      source: { projectId: 'old-project', sessionId: 'old-source', projectName: 'P', title: 'R' },
      inventory: [],
      excludedFiles: [],
      omissions: []
    },
    identities: { 'old-project': 'project', 'old-source': 'research' },
    files: []
  }
  const readSession = vi.fn(async (_projectId: string, sessionId: string) =>
    sessions.get(sessionId)
  )
  const catalog = {
    readHostArtifactCatalog: vi.fn(
      async ({ versionId }: { projectId: string; versionId?: string }) =>
        versionId
          ? versions.has(versionId)
            ? [versions.get(versionId)!.row]
            : []
          : [...versions.values()].filter((version) => version.latest).map((version) => version.row)
    )
  }
  const inputAuthority: ResearchMaterialAuthorityDependencies['inputAuthority'] = {
    resolveVersion: vi.fn(
      async ({ inputFileVersionId }) => versions.get(inputFileVersionId)?.input
    ),
    openContent: vi.fn(async (input) => {
      const file = versions.get(input.inputFileVersionId)!
      if (JSON.stringify(input) !== JSON.stringify(file.input)) throw new Error('Version changed')
      const lease: ImmutableInputContentLease = {
        path: '/private/material',
        size: input.sizeBytes,
        versionToken: 1,
        snapshot: { dev: 1n, ino: 1n, size: BigInt(input.sizeBytes), mtimeNs: 1n },
        read: vi.fn(async (buffer, offset, length, position) => {
          controls.readSizes.push(length)
          controls.onRead?.()
          const bytes = file.content.subarray(position, position + length)
          buffer.set(bytes, offset)
          return { bytesRead: bytes.length }
        }),
        readRange: vi.fn(async () => new Uint8Array()),
        copyTo: vi.fn(async () => undefined),
        verifyUnchanged: vi.fn(async () => {
          if (controls.verificationError) throw controls.verificationError
        }),
        close: vi.fn(async () => undefined)
      }
      leases.push(lease)
      return lease
    })
  }
  const dependencies: ResearchMaterialAuthorityDependencies = {
    catalog,
    inputAuthority,
    readSession,
    readOrigin: vi.fn(async () => origin)
  }
  const add = (
    versionId: string,
    options: {
      sessionId?: string
      projectId?: string
      filename?: string
      content?: Buffer
      latest?: boolean
      source?: 'artifact' | 'upload'
    } = {}
  ): TestVersion => {
    const content = options.content ?? Buffer.from(`content:${versionId}`)
    const row: HostArtifactCatalogItem = {
      source: options.source ?? 'artifact',
      sourceFileId: `file-${versionId}`,
      versionId,
      checksum: sha(content),
      projectId: options.projectId ?? 'project',
      sessionId: options.sessionId ?? 'research',
      filename: options.filename ?? 'data.csv',
      sizeBytes: content.length,
      sortAtMs: 1,
      createdAt: new Date(1).toISOString(),
      rootFrameId: null,
      agentFrameId: null
    }
    const input: NotebookRunInputFile = {
      inputFileVersionId: versionId,
      sourceKind: row.source === 'artifact' ? 'artifact-version' : 'upload-version',
      sourceFileId: row.sourceFileId,
      sourceProjectId: row.projectId,
      sourceSessionId: row.sessionId,
      filename: row.filename,
      sizeBytes: content.length,
      checksum: sha(content),
      storageKey: `artifacts/project/${row.sessionId}/${versionId}`,
      association: 'turn-attached'
    }
    const version = { row, input, content, latest: options.latest ?? true }
    versions.set(versionId, version)
    return version
  }
  const useOrigin = (kind: 'import' | 'fork' = 'import'): void => {
    const source = sessions.get('research')!
    source[kind === 'import' ? 'packageOrigin' : 'forkOrigin'] = {
      ...origin.receiptIdentity,
      sourceProjectId: 'old-project',
      sourceSessionId: 'old-source',
      importedAt: 2
    }
  }
  const include = (versionId: string): void => {
    const { input } = versions.get(versionId)!
    const sourceStorageKey = `artifacts/old-project/old-source/old-${versionId}`
    origin.identities[`old-${versionId}`] = versionId
    origin.sourceManifest.inventory.push({
      path: `objects/${input.checksum}`,
      kind: 'file',
      storageKey: sourceStorageKey,
      checksum: input.checksum,
      sizeBytes: input.sizeBytes
    })
    origin.files.push({
      sourceStorageKey,
      localStorageKey: input.storageKey,
      sourceChecksum: input.checksum,
      localChecksum: input.checksum
    })
  }
  return { dependencies, sessions, versions, origin, add, include, useOrigin, controls, leases }
}

describe('production research material scope', () => {
  it('discovers only own current Versions and explicitly selected own historical Versions', async () => {
    const f = fixture()
    f.add('current')
    f.add('historical', { latest: false, source: 'upload' })
    f.add('unrelated', { sessionId: 'other' })
    const authority = await createResearchMaterialAuthority(f.dependencies, {
      ...request,
      versionIds: ['historical']
    })
    expect(authority.versions.map((version) => version.versionId)).toEqual([
      'current',
      'historical'
    ])
    expect(
      authority.versions.every((version) => version.sourceIdentity === authority.source.identity)
    ).toBe(true)
    expect(await authority.readVersion('historical', { maxBytes: 100 })).toEqual(
      f.versions.get('historical')!.content
    )
    await expect(authority.readVersion('unrelated', { maxBytes: 100 })).rejects.toThrow(
      'outside the frozen'
    )
    await expect(
      createResearchMaterialAuthority(f.dependencies, { ...request, versionIds: ['unrelated'] })
    ).rejects.toThrow('outside this research')
    expect(f.dependencies.readOrigin).not.toHaveBeenCalled()
  })

  it('allows an ordinary receiving Session to prepare its own materials', async () => {
    const f = fixture()
    f.add('data')
    const authority = await createResearchMaterialAuthority(f.dependencies, {
      ...request,
      targetSessionId: 'research'
    })
    expect(authority.versions).toHaveLength(1)
  })

  it('uses imported receipt closure including historical upstream-owned Versions, not project heads', async () => {
    const f = fixture()
    f.useOrigin()
    f.add('inherited-history', { sessionId: 'retained-source', latest: false })
    f.add('foreign-head', { sessionId: 'retained-source' })
    f.add('unexpected-own-file')
    f.add('excluded', { sessionId: 'retained-source' })
    f.include('inherited-history')
    f.origin.identities['old-excluded'] = 'excluded'
    const authority = await createResearchMaterialAuthority(f.dependencies, request)
    expect(authority.versions.map((version) => version.versionId)).toEqual(['inherited-history'])
    expect(f.dependencies.catalog.readHostArtifactCatalog).not.toHaveBeenCalledWith({
      projectId: 'project'
    })
    expect(await authority.readVersion('inherited-history', { maxBytes: 100 })).toEqual(
      f.versions.get('inherited-history')!.content
    )
    await expect(
      createResearchMaterialAuthority(f.dependencies, { ...request, versionIds: ['excluded'] })
    ).rejects.toThrow('outside this research')
  })

  it('combines a fork own new Versions with verified inherited closure without membership', async () => {
    const f = fixture()
    f.useOrigin('fork')
    f.add('new')
    f.add('inherited', { sessionId: 'ancestor', latest: false })
    f.add('unrelated', { sessionId: 'ancestor' })
    f.include('inherited')
    const authority = await createResearchMaterialAuthority(f.dependencies, {
      ...request,
      targetSessionId: 'research'
    })
    expect(authority.versions.map((version) => version.versionId)).toEqual(['inherited', 'new'])
  })

  it('does not silently choose among same-named descriptions within the verified scope', async () => {
    const f = fixture()
    for (const id of ['first', 'second']) f.add(id, { filename: 'research-reproduction.json' })
    f.add('foreign', { filename: 'research-reproduction.json', sessionId: 'other' })
    const authority = await createResearchMaterialAuthority(f.dependencies, request)
    expect(await inspectResearchMaterials(authority)).toMatchObject({
      status: 'choose-description',
      descriptorCandidates: [{ versionId: 'first' }, { versionId: 'second' }]
    })
    expect(f.dependencies.inputAuthority.openContent).not.toHaveBeenCalled()
  })

  it.each([
    'missing-origin',
    'import-id',
    'manifest-checksum',
    'project-map',
    'session-map',
    'source-id'
  ])('rejects an unverifiable or mismatched imported identity: %s', async (mode) => {
    const f = fixture()
    f.useOrigin()
    if (mode === 'missing-origin') f.dependencies.readOrigin = undefined
    if (mode === 'import-id') f.origin.receiptIdentity.importId = 'different-import'
    if (mode === 'manifest-checksum') f.origin.receiptIdentity.manifestChecksum = 'b'.repeat(64)
    if (mode === 'project-map') f.origin.identities['old-project'] = 'other-project'
    if (mode === 'session-map') f.origin.identities['old-source'] = 'other'
    if (mode === 'source-id') f.origin.sourceManifest.source.sessionId = 'other'
    await expect(createResearchMaterialAuthority(f.dependencies, request)).rejects.toThrow(
      /closure/
    )
    expect(f.dependencies.catalog.readHostArtifactCatalog).not.toHaveBeenCalled()
  })

  it.each(['excluded', 'local-hash', 'source-hash', 'source-size', 'missing-payload'])(
    'excludes receipt metadata that does not prove included immutable payload: %s',
    async (mode) => {
      const f = fixture()
      f.useOrigin()
      f.add('data')
      f.include('data')
      if (mode === 'excluded')
        f.origin.sourceManifest.excludedFiles.push({
          storageKey: f.origin.files[0].sourceStorageKey,
          filename: 'data.csv',
          sizeBytes: 1
        })
      if (mode === 'local-hash') f.origin.files[0].localChecksum = 'b'.repeat(64)
      if (mode === 'source-hash') f.origin.files[0].sourceChecksum = 'b'.repeat(64)
      if (mode === 'source-size') f.origin.sourceManifest.inventory[0].sizeBytes++
      if (mode === 'missing-payload') f.origin.files = []
      expect((await createResearchMaterialAuthority(f.dependencies, request)).versions).toEqual([])
    }
  )

  it('supports receipt-verified content transformed during native identity remapping', async () => {
    const f = fixture()
    f.useOrigin()
    f.add('remapped')
    f.include('remapped')
    f.origin.files[0].sourceChecksum = 'b'.repeat(64)
    f.origin.sourceManifest.inventory[0].checksum = 'b'.repeat(64)
    f.origin.sourceManifest.inventory[0].sizeBytes++
    expect((await createResearchMaterialAuthority(f.dependencies, request)).versions).toHaveLength(
      1
    )
  })

  it.each([
    'source-project',
    'target-project',
    'source-deleted',
    'target-deleted',
    'read-only-target',
    'source-archived'
  ])('rejects unavailable or cross-project Session boundaries: %s', async (mode) => {
    const f = fixture()
    if (mode === 'source-project') f.sessions.get('research')!.projectId = 'other-project'
    if (mode === 'target-project') f.sessions.get('discussion')!.projectId = 'other-project'
    if (mode === 'source-deleted') f.sessions.delete('research')
    if (mode === 'target-deleted') f.sessions.delete('discussion')
    if (mode === 'read-only-target') {
      f.useOrigin()
      f.sessions.get('discussion')!.packageOrigin = f.sessions.get('research')!.packageOrigin
    }
    if (mode === 'source-archived') f.sessions.get('research')!.archivedAt = 2
    await expect(createResearchMaterialAuthority(f.dependencies, request)).rejects.toThrow(
      /unavailable|read-only/
    )
  })

  it.each(['project', 'version', 'checksum', 'filename', 'ambiguous'])(
    'rejects catalog and immutable identity disagreement: %s',
    async (mode) => {
      const f = fixture()
      const file = f.add('data')
      if (mode === 'project') file.input.sourceProjectId = 'other-project'
      if (mode === 'version') file.input.inputFileVersionId = 'other-version'
      if (mode === 'checksum') file.input.checksum = 'b'.repeat(64)
      if (mode === 'filename') file.input.filename = 'research-reproduction.json'
      if (mode === 'ambiguous')
        vi.mocked(f.dependencies.catalog.readHostArtifactCatalog).mockResolvedValue([
          file.row,
          file.row
        ])
      await expect(createResearchMaterialAuthority(f.dependencies, request)).rejects.toThrow(
        /disagree|ambiguous/
      )
    }
  )

  it('bounds explicit inputs and receipt candidate discovery before catalog queries', async () => {
    const f = fixture()
    await expect(
      createResearchMaterialAuthority(f.dependencies, { ...request, versionIds: ['a', 'a'] })
    ).rejects.toThrow('explicit Version')
    await expect(
      createResearchMaterialAuthority(f.dependencies, {
        ...request,
        versionIds: Array.from({ length: 1001 }, (_, index) => `v-${index}`)
      })
    ).rejects.toThrow('explicit Version')
    f.useOrigin()
    for (let i = 0; i < 20_001; i++) f.origin.identities[`old-${i}`] = `local-${i}`
    await expect(createResearchMaterialAuthority(f.dependencies, request)).rejects.toThrow(
      'discovery limit'
    )
    expect(f.dependencies.catalog.readHostArtifactCatalog).not.toHaveBeenCalled()
  })
})

describe('frozen research material snapshots and bounded reads', () => {
  it.each(['artifact', 'upload'] as const)(
    'registers an exact prepared %s Version without claiming an observed read',
    async (source) => {
      const f = fixture()
      const file = f.add('data', { source })
      const registered = await resolvePreparedResearchMaterialInput(f.dependencies, {
        projectId: 'project',
        versionId: 'data',
        sha256: file.input.checksum,
        sizeBytes: file.input.sizeBytes
      })
      expect(registered).toMatchObject({
        inputFileVersionId: 'data',
        sourceKind: `${source}-version`,
        association: 'turn-attached'
      })
      expect(registered.accessEvidence).toBeUndefined()
      expect(f.dependencies.inputAuthority.openContent).not.toHaveBeenCalled()
    }
  )

  it.each(['project', 'hash', 'size', 'deleted'])(
    'rejects a prepared Version registration when its %s no longer matches',
    async (mode) => {
      const f = fixture()
      const file = f.add('data')
      const prepared = {
        projectId: 'project',
        versionId: 'data',
        sha256: file.input.checksum,
        sizeBytes: file.input.sizeBytes
      }
      if (mode === 'project') file.row.projectId = 'other-project'
      if (mode === 'hash') prepared.sha256 = 'b'.repeat(64)
      if (mode === 'size') prepared.sizeBytes++
      if (mode === 'deleted') f.versions.delete('data')
      await expect(resolvePreparedResearchMaterialInput(f.dependencies, prepared)).rejects.toThrow(
        /unavailable|identity changed/
      )
    }
  )

  it('ignores mutable title, reading links and latest heads after selection, but checks new selections', async () => {
    const f = fixture()
    f.add('data')
    const authority = await createResearchMaterialAuthority(f.dependencies, request)
    f.sessions.get('research')!.title = 'Renamed'
    f.sessions.get('research')!.updatedAt++
    expect((await createResearchMaterialAuthority(f.dependencies, request)).source.identity).toBe(
      authority.source.identity
    )
    f.versions.get('data')!.latest = false
    f.add('new-head')
    expect(await authority.readVersion('data', { maxBytes: 100 })).toEqual(
      f.versions.get('data')!.content
    )
    await expect(
      createResearchMaterialAuthority(f.dependencies, {
        ...request,
        expectedSourceIdentity: authority.source.identity
      })
    ).rejects.toThrow('snapshot changed')
  })

  it('detects reimport identity changes even with identical material bytes', async () => {
    const f = fixture()
    f.useOrigin()
    f.add('data')
    f.include('data')
    const authority = await createResearchMaterialAuthority(f.dependencies, request)
    f.origin.receiptIdentity.importId = 'import-2'
    f.sessions.get('research')!.packageOrigin!.importId = 'import-2'
    await expect(authority.readVersion('data', { maxBytes: 100 })).rejects.toThrow(
      'source identity changed'
    )
    expect(
      (await createResearchMaterialAuthority(f.dependencies, request)).source.identity
    ).not.toBe(authority.source.identity)
  })

  it.each(['source', 'target', 'reimport'])(
    'closes the lease and fails if %s is replaced/deleted during reading',
    async (mode) => {
      const f = fixture()
      f.add('data')
      const authority = await createResearchMaterialAuthority(f.dependencies, request)
      f.controls.onRead = () => {
        if (mode === 'source') f.sessions.delete('research')
        if (mode === 'target') f.sessions.delete('discussion')
        if (mode === 'reimport') f.useOrigin()
      }
      await expect(authority.readVersion('data', { maxBytes: 100 })).rejects.toThrow(
        /unavailable|identity changed/
      )
      expect(f.leases[0].close).toHaveBeenCalledOnce()
    }
  )

  it('limits every read chunk and rejects large materials before opening content', async () => {
    const f = fixture()
    const file = f.add('data', { content: Buffer.alloc(180_000, 'a') })
    const authority = await createResearchMaterialAuthority(f.dependencies, request)
    await expect(authority.readVersion('data', { maxBytes: 100 })).rejects.toThrow(
      'read byte limit'
    )
    expect(f.dependencies.inputAuthority.openContent).not.toHaveBeenCalled()
    expect(await authority.readVersion('data', { maxBytes: file.content.length })).toEqual(
      file.content
    )
    expect(Math.max(...f.controls.readSizes)).toBe(64 * 1024)
    expect(f.leases[0].verifyUnchanged).toHaveBeenCalledOnce()
    expect(f.leases[0].close).toHaveBeenCalledOnce()
  })

  it.each(['changed', 'short', 'grown', 'verification', 'version'])(
    'rejects changed or incomplete immutable content: %s',
    async (mode) => {
      const f = fixture()
      const file = f.add('data')
      const authority = await createResearchMaterialAuthority(f.dependencies, request)
      if (mode === 'changed') file.content = Buffer.alloc(file.content.length, 'x')
      if (mode === 'short') file.content = file.content.subarray(0, 2)
      if (mode === 'grown') file.content = Buffer.concat([file.content, Buffer.from('x')])
      if (mode === 'verification') f.controls.verificationError = new Error('lease changed')
      if (mode === 'version') file.input.storageKey = 'different-version'
      await expect(authority.readVersion('data', { maxBytes: 100 })).rejects.toThrow(
        /changed|ended early|grew/
      )
      for (const lease of f.leases) expect(lease.close).toHaveBeenCalledOnce()
    }
  )

  it('honors cancellation during reading and closes the leased content', async () => {
    const f = fixture()
    f.add('data', { content: Buffer.alloc(180_000, 'a') })
    const authority = await createResearchMaterialAuthority(f.dependencies, request)
    const controller = new AbortController()
    f.controls.onRead = () => controller.abort()
    await expect(
      authority.readVersion('data', { maxBytes: 200_000, signal: controller.signal })
    ).rejects.toThrow(/abort/i)
    expect(f.leases[0].close).toHaveBeenCalledOnce()
    expect(f.leases[0].read).toHaveBeenCalledOnce()
  })
})

describe('read-only imported research inspection authority', () => {
  const inspectionRequest = {
    projectId: 'project',
    sourceSessionId: 'research',
    sourceImportId: 'import-1'
  }

  it('admits the same verified closure without requiring or creating a writable Session', async () => {
    const f = fixture()
    f.useOrigin()
    f.add('retained-input', { sessionId: 'retained-source', latest: false })
    f.add('unrelated-head', { sessionId: 'retained-source' })
    f.add('unproven-own-file')
    f.include('retained-input')
    const writable = await createResearchMaterialAuthority(f.dependencies, request)
    f.sessions.delete('discussion')
    const inspected = await createResearchMaterialInspectionAuthority(
      f.dependencies,
      inspectionRequest
    )
    expect(inspected.source.identity).toBe(writable.source.identity)
    expect(inspected.versions).toEqual(writable.versions)
    expect(inspected.versions.map((row) => row.versionId)).toEqual(['retained-input'])
    expect(await inspected.readVersion('retained-input', { maxBytes: 100 })).toEqual(
      f.versions.get('retained-input')!.content
    )
    await expect(createResearchMaterialAuthority(f.dependencies, request)).rejects.toThrow(
      'receiving Session'
    )
    await expect(
      createResearchMaterialAuthority(f.dependencies, { ...request, targetSessionId: 'research' })
    ).rejects.toThrow('read-only')
  })

  it.each(['ordinary', 'fork', 'archived', 'reimport', 'wrong-project'])(
    'rejects %s sources',
    async (mode) => {
      const f = fixture()
      if (mode !== 'ordinary') f.useOrigin(mode === 'fork' ? 'fork' : 'import')
      const source = f.sessions.get('research')!
      if (mode === 'archived') source.archivedAt = 3
      if (mode === 'reimport') source.packageOrigin!.importId = 'import-2'
      if (mode === 'wrong-project') source.projectId = 'another-project'
      await expect(
        createResearchMaterialInspectionAuthority(f.dependencies, inspectionRequest)
      ).rejects.toThrow('unavailable or changed')
    }
  )

  it('revalidates import identity while reading and refuses altered frozen material sets', async () => {
    const f = fixture()
    f.useOrigin()
    f.add('data')
    f.include('data')
    const inspected = await createResearchMaterialInspectionAuthority(
      f.dependencies,
      inspectionRequest
    )
    f.add('new')
    f.include('new')
    await expect(
      createResearchMaterialInspectionAuthority(f.dependencies, {
        ...inspectionRequest,
        expectedSourceIdentity: inspected.source.identity
      })
    ).rejects.toThrow('snapshot changed')
    f.controls.onRead = () => {
      f.sessions.get('research')!.packageOrigin!.importId = 'import-2'
    }
    await expect(inspected.readVersion('data', { maxBytes: 100 })).rejects.toThrow(
      'unavailable or changed'
    )
    expect(f.leases[0].close).toHaveBeenCalledOnce()
  })

  it('does not trust an unverified or mismatched retained receipt', async () => {
    const f = fixture()
    f.useOrigin()
    f.origin.receiptIdentity.manifestChecksum = 'b'.repeat(64)
    await expect(
      createResearchMaterialInspectionAuthority(f.dependencies, inspectionRequest)
    ).rejects.toThrow('closure does not belong')
  })
})
