import { describe, it, expect, vi } from 'vitest'

import type { ArtifactRepository } from '../artifacts/repository'
import type { KetcherBroker } from './broker'
import { KetcherService, type KetcherRunContext } from './service'

// A minimal broker double: records openTile/dispatch calls and lets each test choose mount/reply results.
const createBroker = (
  overrides?: Partial<KetcherBroker>
): {
  broker: KetcherBroker
  openTile: ReturnType<typeof vi.fn>
  dispatch: ReturnType<typeof vi.fn>
  waitForMount: ReturnType<typeof vi.fn>
} => {
  const openTile = vi.fn()
  const dispatch = vi.fn().mockResolvedValue(undefined)
  const waitForMount = vi.fn().mockResolvedValue(undefined)
  const broker = { openTile, dispatch, waitForMount, ...overrides } as unknown as KetcherBroker
  return { broker, openTile, dispatch, waitForMount }
}

const runContext: KetcherRunContext = {
  projectName: 'proj',
  sessionId: 'session-app',
  artifactSessionId: 'session-art',
  runId: 'run-1'
}

// A repository double that echoes a deterministic ArtifactFile for writePendingFile.
const createRepository = (
  writePendingFile = vi.fn()
): {
  repository: ArtifactRepository
  writePendingFile: ReturnType<typeof vi.fn>
  resolveManagedFilePath: ReturnType<typeof vi.fn>
} => {
  writePendingFile.mockImplementation(async (request: { filename: string }) => ({
    id: `session-art:run-1:${request.filename}`,
    path: `/artifacts/${request.filename}`,
    name: request.filename
  }))
  const resolveManagedFilePath = vi.fn()
  return {
    repository: { writePendingFile, resolveManagedFilePath } as unknown as ArtifactRepository,
    writePendingFile,
    resolveManagedFilePath
  }
}

describe('KetcherService', () => {
  it('open_sketcher writes a .ket artifact, opens a tile, and returns the id + filename', async () => {
    const { broker, openTile, waitForMount } = createBroker()
    const { repository, writePendingFile } = createRepository()
    const service = new KetcherService({
      broker,
      repository,
      resolveRunContext: () => runContext
    })

    const out = await service.call('open_sketcher', { smiles: 'CCO', filename: 'aspirin' })

    expect(out).toEqual({ artifact_id: 'session-art:run-1:aspirin.ket', filename: 'aspirin.ket' })
    expect(writePendingFile).toHaveBeenCalledWith({
      projectName: 'proj',
      sessionId: 'session-art',
      runId: 'run-1',
      filename: 'aspirin.ket',
      source: { kind: 'inline', content: 'CCO', encoding: 'utf8' }
    })
    expect(openTile).toHaveBeenCalledWith({
      artifactId: 'session-art:run-1:aspirin.ket',
      sessionId: 'session-app',
      path: '/artifacts/aspirin.ket',
      name: 'aspirin.ket',
      content: 'CCO'
    })
    expect(waitForMount).toHaveBeenCalledWith('session-art:run-1:aspirin.ket')
  })

  it('open_sketcher errors when no artifact run is active', async () => {
    const { broker } = createBroker()
    const { repository } = createRepository()
    const service = new KetcherService({ broker, repository, resolveRunContext: () => undefined })

    await expect(service.call('open_sketcher', {})).rejects.toThrow(/active agent turn/)
  })

  it('open_sketcher defaults a blank canvas and a generated filename', async () => {
    const { broker, openTile } = createBroker()
    const { repository } = createRepository()
    const service = new KetcherService({ broker, repository, resolveRunContext: () => runContext })

    const out = (await service.call('open_sketcher', {})) as { filename: string }
    expect(out.filename).toBe('sketch-1.ket')
    expect(openTile.mock.calls[0][0].content).toBe('')
  })

  it('set_structure dispatches to the mounted tile', async () => {
    const { broker, dispatch } = createBroker()
    const { repository } = createRepository()
    const service = new KetcherService({ broker, repository, resolveRunContext: () => runContext })

    const out = await service.call('set_structure', { artifact_id: 'a', smiles: 'c1ccccc1' })
    expect(out).toEqual({ ok: true })
    expect(dispatch).toHaveBeenCalledWith('a', 'set', {
      ket: undefined,
      molfile: undefined,
      smiles: 'c1ccccc1'
    })
  })

  it('set_structure rejects when no structure is supplied', async () => {
    const { broker } = createBroker()
    const { repository } = createRepository()
    const service = new KetcherService({ broker, repository, resolveRunContext: () => runContext })

    await expect(service.call('set_structure', { artifact_id: 'a' })).rejects.toThrow(
      /requires one of ket, molfile, or smiles/
    )
  })

  it('set_structure requires an artifact_id', async () => {
    const { broker } = createBroker()
    const { repository } = createRepository()
    const service = new KetcherService({ broker, repository, resolveRunContext: () => runContext })

    await expect(service.call('set_structure', { smiles: 'CCO' })).rejects.toThrow(
      /artifact_id is required/
    )
  })

  it('highlight_atoms coerces indices and dispatches highlight', async () => {
    const { broker, dispatch } = createBroker()
    const { repository } = createRepository()
    const service = new KetcherService({ broker, repository, resolveRunContext: () => runContext })

    await service.call('highlight_atoms', { artifact_id: 'a', atoms: [0, 1], color: '#abc' })
    expect(dispatch).toHaveBeenCalledWith('a', 'highlight', {
      atoms: [0, 1],
      bonds: undefined,
      color: '#abc'
    })
  })

  it('highlight_atoms rejects a non-array atoms argument', async () => {
    const { broker } = createBroker()
    const { repository } = createRepository()
    const service = new KetcherService({ broker, repository, resolveRunContext: () => runContext })

    await expect(service.call('highlight_atoms', { artifact_id: 'a', atoms: 3 })).rejects.toThrow(
      /atoms must be an array/
    )
  })

  it('get_structure returns the tile reply in the requested format', async () => {
    const dispatch = vi.fn().mockResolvedValue('CCO')
    const { broker } = createBroker({ dispatch } as Partial<KetcherBroker>)
    const { repository } = createRepository()
    const service = new KetcherService({ broker, repository, resolveRunContext: () => runContext })

    const out = await service.call('get_structure', { artifact_id: 'a', format: 'smiles' })
    expect(out).toEqual({ artifact_id: 'a', format: 'smiles', structure: 'CCO' })
    expect(dispatch).toHaveBeenCalledWith('a', 'get', { format: 'smiles' })
  })

  it('get_structure defaults to ket and rejects an unknown format', async () => {
    const dispatch = vi.fn().mockResolvedValue('{}')
    const { broker } = createBroker({ dispatch } as Partial<KetcherBroker>)
    const { repository } = createRepository()
    const service = new KetcherService({ broker, repository, resolveRunContext: () => runContext })

    const out = await service.call('get_structure', { artifact_id: 'a' })
    expect(out).toEqual({ artifact_id: 'a', format: 'ket', structure: '{}' })
    await expect(
      service.call('get_structure', { artifact_id: 'a', format: 'inchi' })
    ).rejects.toThrow(/format must be one of/)
  })

  it('rejects an unknown method', async () => {
    const { broker } = createBroker()
    const { repository } = createRepository()
    const service = new KetcherService({ broker, repository, resolveRunContext: () => runContext })

    await expect(service.call('nope', {})).rejects.toThrow(/unknown tool: ketcher\/nope/)
  })

  it('save writes the current ket back to a tracked artifact path', async () => {
    const { broker } = createBroker()
    const { repository } = createRepository()
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const service = new KetcherService({
      broker,
      repository,
      resolveRunContext: () => runContext,
      writeFile
    })

    const opened = (await service.call('open_sketcher', { filename: 'm.ket' })) as {
      artifact_id: string
    }
    await service.save(opened.artifact_id, '{"root":{}}')
    expect(writeFile).toHaveBeenCalledWith('/artifacts/m.ket', '{"root":{}}')

    // An unknown artifact id is a no-op (nothing tracked, no throw).
    await service.save('unknown', 'x')
    expect(writeFile).toHaveBeenCalledTimes(1)
  })

  it('save recovers the finalized path when the pending file has moved', async () => {
    const { broker } = createBroker()
    const { repository, resolveManagedFilePath } = createRepository()
    resolveManagedFilePath.mockResolvedValue('/artifacts/message/m.ket')
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const writeFile = vi.fn().mockRejectedValueOnce(enoent).mockResolvedValue(undefined)
    const service = new KetcherService({
      broker,
      repository,
      resolveRunContext: () => runContext,
      writeFile
    })

    const opened = (await service.call('open_sketcher', { filename: 'm.ket' })) as {
      artifact_id: string
    }
    await service.save(opened.artifact_id, '{"root":{}}')

    expect(resolveManagedFilePath).toHaveBeenCalledWith({ path: '/artifacts/m.ket' })
    expect(writeFile).toHaveBeenLastCalledWith('/artifacts/message/m.ket', '{"root":{}}')
    // The recovered path is remembered so the next save goes straight there.
    await service.save(opened.artifact_id, '{"root":{"x":1}}')
    expect(resolveManagedFilePath).toHaveBeenCalledTimes(1)
  })
})
