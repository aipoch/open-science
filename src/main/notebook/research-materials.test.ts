import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { zipSync } from 'fflate'
import { Header } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  inspectResearchMaterials,
  prepareResearchMaterials,
  ResearchMaterialUnavailableError,
  ResearchMaterialVersionSelectionError,
  type ResearchMaterialAuthority,
  type ResearchMaterialVersion
} from './research-materials'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})
const staging = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'science-materials-'))
  directories.push(path)
  return path
}
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const source = {
  projectId: 'project',
  sessionId: 'research',
  identity: 'import-1',
  title: 'Research'
}
const fixture = (
  files: Record<string, { filename: string; content: Buffer }>
): ResearchMaterialAuthority => ({
  source: { ...source },
  versions: Object.entries(files).map(([versionId, file]) => ({
    versionId,
    sourceIdentity: source.identity,
    filename: file.filename,
    sha256: sha(file.content),
    sizeBytes: file.content.length
  })),
  readVersion: vi.fn(async (versionId) => files[versionId].content)
})
const description = (
  payload: Buffer,
  archive?: { format: 'tar' | 'tar.gz' | 'zip'; entries: unknown[] }
): Buffer =>
  Buffer.from(
    JSON.stringify({
      format: 'open-science-reproduction-description',
      descriptionVersion: 1,
      title: 'Prepared materials',
      materials: [
        {
          key: 'source',
          role: 'source',
          availability: 'included',
          filename: archive ? 'source.archive' : 'data.csv',
          sha256: sha(payload),
          sizeBytes: payload.length,
          restorePath: archive ? 'workspace' : 'inputs/data.csv',
          ...(archive ? { archive } : {})
        }
      ],
      plans: [
        {
          key: 'inspect',
          title: 'Inspect',
          scope: 'engineering-check',
          materialKeys: ['source'],
          claim: 'Engineering check only',
          limitations: []
        }
      ]
    })
  )
const withDescription = (
  payload: Buffer,
  descriptor = description(payload)
): ResearchMaterialAuthority =>
  fixture({
    data: { filename: 'data.csv', content: payload },
    descriptor: { filename: 'research-reproduction.json', content: descriptor }
  })

describe('research material discovery', () => {
  it('keeps old packages usable without a description or any discovery reads', async () => {
    const authority = fixture({ data: { filename: 'data.csv', content: Buffer.from('a,1') } })
    expect(await inspectResearchMaterials(authority)).toMatchObject({
      status: 'no-description',
      source
    })
    expect(authority.readVersion).not.toHaveBeenCalled()
  })

  it('requires explicit selection among multiple descriptions', async () => {
    const payload = Buffer.from('a,1')
    const desc = description(payload)
    const authority = fixture({
      data: { filename: 'data.csv', content: payload },
      first: { filename: 'research-reproduction.json', content: desc },
      second: { filename: 'research-reproduction.json', content: desc }
    })
    expect(await inspectResearchMaterials(authority)).toMatchObject({
      status: 'choose-description'
    })
    expect(authority.readVersion).not.toHaveBeenCalled()
    expect(
      await inspectResearchMaterials(authority, { descriptorVersionId: 'second' })
    ).toMatchObject({
      status: 'ready',
      descriptor: { versionId: 'second' },
      materials: [{ key: 'source', status: 'available', versionIds: ['data'] }]
    })
  })

  it('rejects a mixed-source catalogue rather than relabelling it', async () => {
    const authority = withDescription(Buffer.from('data'))
    authority.versions = authority.versions.map((version) => ({
      ...version,
      sourceIdentity: 'other-import'
    }))
    await expect(inspectResearchMaterials(authority)).rejects.toThrow(/another research/)
    expect(authority.readVersion).not.toHaveBeenCalled()
  })

  it('reports missing, mismatched and unavailable included materials', async () => {
    const original = Buffer.from('original')
    const authority = withDescription(original)
    authority.versions = authority.versions.filter((version) => version.versionId !== 'data')
    expect(await inspectResearchMaterials(authority)).toMatchObject({
      materials: [{ status: 'missing' }]
    })
    const mismatch = fixture({
      descriptor: { filename: 'research-reproduction.json', content: description(original) },
      different: { filename: 'data.csv', content: Buffer.from('changed') }
    })
    expect(await inspectResearchMaterials(mismatch)).toMatchObject({
      materials: [{ status: 'mismatch' }]
    })
    const unavailable = withDescription(original)
    unavailable.versions = unavailable.versions.map((version) => ({
      ...version,
      contentAvailable: version.versionId !== 'data'
    }))
    expect(await inspectResearchMaterials(unavailable)).toMatchObject({
      materials: [{ status: 'missing' }]
    })
  })

  it('reports unsupported description versions without following their declarations', async () => {
    const authority = fixture({
      descriptor: {
        filename: 'research-reproduction.json',
        content: Buffer.from(
          JSON.stringify({
            format: 'open-science-reproduction-description',
            descriptionVersion: 999
          })
        )
      }
    })
    expect(await inspectResearchMaterials(authority)).toMatchObject({
      status: 'unsupported',
      inspection: { version: 999 }
    })
    const path = await staging()
    await expect(
      prepareResearchMaterials(authority, {
        stagingDirectory: path,
        descriptorVersionId: 'descriptor',
        materialKeys: ['source']
      })
    ).rejects.toThrow(/unsupported/)
    expect(await readdir(path)).toEqual([])
  })

  it('verifies the actual descriptor bytes, not just catalogue metadata', async () => {
    const authority = withDescription(Buffer.from('data'))
    authority.readVersion = vi.fn(async () => Buffer.from('changed'))
    await expect(inspectResearchMaterials(authority)).rejects.toThrow(/verification/)
  })
})

describe('verified preparation into caller-owned staging', () => {
  it.each(['missing', 'withheld', 'external', 'mismatch'] as const)(
    'reports the diagnosed %s material as unavailable before reading or restoring it',
    async (reason) => {
      const payload = Buffer.from('original')
      const declared = JSON.parse(description(payload).toString('utf8'))
      if (reason === 'withheld' || reason === 'external')
        declared.materials = [
          {
            key: 'source',
            role: 'source',
            availability: reason,
            description: '/private/research/secret'
          }
        ]
      const authority = withDescription(payload, Buffer.from(JSON.stringify(declared)))
      if (reason === 'missing')
        authority.versions = authority.versions.filter((version) => version.versionId !== 'data')
      if (reason === 'mismatch')
        authority.versions = authority.versions.map((version) =>
          version.versionId === 'data' ? { ...version, sha256: 'a'.repeat(64) } : version
        )
      const path = await staging()
      const error = await prepareResearchMaterials(authority, {
        stagingDirectory: path,
        descriptorVersionId: 'descriptor',
        materialKeys: ['source']
      }).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(ResearchMaterialUnavailableError)
      expect(error).toMatchObject({ reason })
      expect((error as Error).message).not.toContain('/private/')
      expect(vi.mocked(authority.readVersion).mock.calls.map(([id]) => id)).toEqual(['descriptor'])
      expect(await readdir(path)).toEqual([])
    }
  )

  it('reports a selected legacy Version whose catalogue content is unavailable without reading it', async () => {
    const authority = fixture({ data: { filename: 'data', content: Buffer.from('data') } })
    authority.versions = authority.versions.map((version) => ({
      ...version,
      contentAvailable: false
    }))
    const path = await staging()
    await expect(
      prepareResearchMaterials(authority, {
        stagingDirectory: path,
        files: [{ versionId: 'data', restorePath: 'data' }]
      })
    ).rejects.toMatchObject({ name: 'ResearchMaterialUnavailableError', reason: 'missing' })
    expect(authority.readVersion).not.toHaveBeenCalled()
    expect(await readdir(path)).toEqual([])
  })

  it('does not classify unknown keys or read failures as diagnosed material availability', async () => {
    const authority = withDescription(Buffer.from('data'))
    const path = await staging()
    const unknown = await prepareResearchMaterials(authority, {
      stagingDirectory: path,
      descriptorVersionId: 'descriptor',
      materialKeys: ['unknown']
    }).catch((cause: unknown) => cause)
    expect(unknown).toBeInstanceOf(Error)
    expect(unknown).not.toBeInstanceOf(ResearchMaterialUnavailableError)
    const failure = new Error('ENOENT missing /private/research/secret')
    authority.readVersion = vi.fn(async () => {
      throw failure
    })
    await expect(
      prepareResearchMaterials(authority, {
        stagingDirectory: path,
        files: [{ versionId: 'data', restorePath: 'data' }]
      })
    ).rejects.toBe(failure)
    expect(await readdir(path)).toEqual([])
  })

  it('prepares an explicit legacy file verbatim with immutable provenance inputs', async () => {
    const data = Buffer.from('plain file, not executable instructions')
    const authority = fixture({ data: { filename: 'data.csv', content: data } })
    const path = await staging()
    const receipt = await prepareResearchMaterials(authority, {
      stagingDirectory: path,
      files: [{ versionId: 'data', restorePath: 'inputs/data.csv' }]
    })
    expect(await readFile(join(path, 'inputs/data.csv'))).toEqual(data)
    expect(receipt).toMatchObject({
      source,
      totalBytes: data.length,
      inputs: [{ versionId: 'data', sha256: sha(data), restorePath: 'inputs/data.csv' }]
    })
    expect(receipt.entries).toEqual([
      { path: 'inputs/data.csv', type: 'file', sizeBytes: data.length, sha256: sha(data) }
    ])
  })

  it.each(['tar', 'tar.gz', 'zip'] as const)(
    'restores and verifies real %s material inventories',
    async (format) => {
      const body = Buffer.from('console.log(42)\n')
      const header = Buffer.alloc(512)
      new Header({ path: 'project/main.js', type: 'File', size: body.length }).encode(header)
      const raw = Buffer.concat([
        header,
        body,
        Buffer.alloc((512 - (body.length % 512)) % 512),
        Buffer.alloc(1024)
      ])
      const payload =
        format === 'tar.gz'
          ? gzipSync(raw)
          : format === 'zip'
            ? Buffer.from(zipSync({ 'project/main.js': body }))
            : raw
      const archive = {
        format,
        entries: [
          { path: 'project/main.js', type: 'file', sizeBytes: body.length, sha256: sha(body) }
        ]
      }
      const authority = withDescription(payload, description(payload, archive))
      const path = await staging()
      const receipt = await prepareResearchMaterials(authority, {
        stagingDirectory: path,
        descriptorVersionId: 'descriptor',
        materialKeys: ['source']
      })
      expect(await readFile(join(path, 'workspace/project/main.js'))).toEqual(body)
      expect(receipt.inputs.map((version) => version.versionId)).toEqual(['descriptor', 'data'])
      expect(receipt.totalBytes).toBe(body.length)
    }
  )

  it('rejects valid archive bytes with a dishonest declared file inventory before writing', async () => {
    const payload = Buffer.from(zipSync({ file: Buffer.from('actual') }))
    const authority = withDescription(
      payload,
      description(payload, {
        format: 'zip',
        entries: [{ path: 'file', type: 'file', sizeBytes: 6, sha256: sha(Buffer.from('forged')) }]
      })
    )
    const path = await staging()
    await expect(
      prepareResearchMaterials(authority, {
        stagingDirectory: path,
        descriptorVersionId: 'descriptor',
        materialKeys: ['source']
      })
    ).rejects.toThrow(/inventory/)
    expect(await readdir(path)).toEqual([])
  })

  it('does not permit overriding descriptor restore paths', async () => {
    const authority = withDescription(Buffer.from('data'))
    await expect(
      prepareResearchMaterials(authority, {
        stagingDirectory: await staging(),
        descriptorVersionId: 'descriptor',
        materialKeys: ['source'],
        files: [{ versionId: 'data', restorePath: 'elsewhere' }]
      })
    ).rejects.toThrow(/override/)
  })

  it('requires an explicit immutable version when material content matches several Versions', async () => {
    const payload = Buffer.from('same bytes')
    const authority = withDescription(payload)
    authority.versions = [...authority.versions, { ...authority.versions[0], versionId: 'other' }]
    const reader = authority.readVersion
    authority.readVersion = (versionId, options) =>
      reader(versionId === 'other' ? 'data' : versionId, options)
    const path = await staging()
    await expect(
      prepareResearchMaterials(authority, {
        stagingDirectory: path,
        descriptorVersionId: 'descriptor',
        materialKeys: ['source']
      })
    ).rejects.toBeInstanceOf(ResearchMaterialVersionSelectionError)
    await expect(
      prepareResearchMaterials(authority, {
        stagingDirectory: path,
        descriptorVersionId: 'descriptor',
        materialKeys: ['source'],
        materialVersions: { source: 'unrelated' }
      })
    ).rejects.toBeInstanceOf(ResearchMaterialVersionSelectionError)
    const receipt = await prepareResearchMaterials(authority, {
      stagingDirectory: path,
      descriptorVersionId: 'descriptor',
      materialKeys: ['source'],
      materialVersions: { source: 'other' }
    })
    expect(receipt.inputs[1].versionId).toBe('other')
  })

  it('freezes source and Versions before asynchronous reads', async () => {
    const data = Buffer.from('fixed')
    const authority = fixture({ data: { filename: 'data', content: data } })
    authority.readVersion = vi.fn(async () => {
      authority.source.identity = 'changed'
      ;(authority.versions as ResearchMaterialVersion[])[0].sha256 = 'b'.repeat(64)
      return data
    })
    const receipt = await prepareResearchMaterials(authority, {
      stagingDirectory: await staging(),
      files: [{ versionId: 'data', restorePath: 'data' }]
    })
    expect(receipt.source.identity).toBe('import-1')
    expect(receipt.inputs[0].sha256).toBe(sha(data))
  })

  it('checks all output paths together before creating any files', async () => {
    const authority = fixture({ data: { filename: 'data', content: Buffer.from('data') } })
    for (const paths of [
      ['one', '../escape'],
      ['a/file', 'A/other'],
      ['parent', 'parent/child']
    ]) {
      const path = await staging()
      await expect(
        prepareResearchMaterials(authority, {
          stagingDirectory: path,
          files: paths.map((restorePath) => ({ versionId: 'data', restorePath }))
        })
      ).rejects.toThrow()
      expect(await readdir(path)).toEqual([])
    }
  })

  it('rejects unavailable/foreign Versions and content mismatches', async () => {
    const authority = fixture({ data: { filename: 'data', content: Buffer.from('data') } })
    const path = await staging()
    await expect(
      prepareResearchMaterials(authority, {
        stagingDirectory: path,
        files: [{ versionId: 'foreign', restorePath: 'data' }]
      })
    ).rejects.toThrow(/outside/)
    authority.readVersion = vi.fn(async () => Buffer.from('fake'))
    await expect(
      prepareResearchMaterials(authority, {
        stagingDirectory: path,
        files: [{ versionId: 'data', restorePath: 'data' }]
      })
    ).rejects.toThrow(/verification/)
    expect(await readdir(path)).toEqual([])
  })

  it('enforces host input/output limits before reading known-oversized data', async () => {
    const authority = fixture({ data: { filename: 'data', content: Buffer.from('data') } })
    const path = await staging()
    for (const limits of [{ maxInputBytes: 3 }, { maxExpandedBytes: 3 }]) {
      await expect(
        prepareResearchMaterials(authority, {
          stagingDirectory: path,
          files: [{ versionId: 'data', restorePath: 'data' }],
          limits
        })
      ).rejects.toThrow(/limit/)
    }
    expect(authority.readVersion).not.toHaveBeenCalled()
  })

  it('refuses existing or symlink staging and never overwrites its contents', async () => {
    const authority = fixture({ data: { filename: 'data', content: Buffer.from('data') } })
    const root = await staging()
    await writeFile(join(root, 'keep'), 'unchanged')
    await expect(
      prepareResearchMaterials(authority, {
        stagingDirectory: root,
        files: [{ versionId: 'data', restorePath: 'keep' }]
      })
    ).rejects.toThrow(/empty/)
    const outer = await staging()
    await symlink(root, join(outer, 'linked'))
    await expect(
      prepareResearchMaterials(authority, {
        stagingDirectory: join(outer, 'linked'),
        files: [{ versionId: 'data', restorePath: 'keep' }]
      })
    ).rejects.toThrow(/owner-controlled/)
    expect(await readFile(join(root, 'keep'), 'utf8')).toBe('unchanged')
  })

  it('detects staging replacement during material reads', async () => {
    const authority = fixture({ data: { filename: 'data', content: Buffer.from('data') } })
    const path = await staging()
    const moved = `${path}-moved`
    directories.push(moved)
    authority.readVersion = vi.fn(async () => {
      await rename(path, moved)
      await mkdir(path, { mode: 0o700 })
      return Buffer.from('data')
    })
    await expect(
      prepareResearchMaterials(authority, {
        stagingDirectory: path,
        files: [{ versionId: 'data', restorePath: 'data' }]
      })
    ).rejects.toThrow(/identity changed/)
  })

  it('does not return a success receipt or write files after cancellation during I/O', async () => {
    const authority = fixture({ data: { filename: 'data', content: Buffer.from('data') } })
    const abort = new AbortController()
    authority.readVersion = vi.fn(async () => {
      abort.abort()
      return Buffer.from('data')
    })
    const path = await staging()
    await expect(
      prepareResearchMaterials(authority, {
        stagingDirectory: path,
        files: [{ versionId: 'data', restorePath: 'data' }],
        signal: abort.signal
      })
    ).rejects.toThrow()
    expect(await readdir(path)).toEqual([])
  })
})
