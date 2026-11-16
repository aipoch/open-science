import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const failures = vi.hoisted(() => ({ backup: false }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (
      path: Parameters<typeof actual.open>[0],
      flags: Parameters<typeof actual.open>[1],
      mode?: Parameters<typeof actual.open>[2]
    ) => {
      if (failures.backup && String(path).endsWith('backup')) throw new Error('Backup failed')
      return actual.open(path, flags, mode)
    },
    copyFile: async (source: string, destination: string, flags?: number) => {
      if (failures.backup && destination.endsWith('backup')) throw new Error('Backup failed')
      return actual.copyFile(source, destination, flags)
    }
  }
})
import { ProjectFolderStagedFiles } from './staged-files'

let root: string
let folder: string
let storage: string
let directory: string
const scope = { projectId: 'project-1', sessionId: 'session-1' }
const approve = vi.fn(async () => true)
const authorizeCreatedFile = vi.fn(async () => true)
let service: ProjectFolderStagedFiles
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-staged-files-'))
  folder = join(root, 'research')
  storage = join(root, 'managed')
  directory = join(storage, 'notebook', 'data')
  await mkdir(folder)
  await mkdir(directory, { recursive: true })
  await writeFile(join(folder, 'raw.csv'), 'a,b\n1,2\n')
  approve.mockReset().mockResolvedValue(true)
  authorizeCreatedFile.mockReset().mockResolvedValue(true)
  failures.backup = false
  service = new ProjectFolderStagedFiles({ storageRoot: storage, approve, authorizeCreatedFile })
})
afterEach(async () => {
  failures.backup = false
  await rm(root, { recursive: true, force: true })
})
const stage = (): ReturnType<ProjectFolderStagedFiles['stage']> =>
  service.stage({ ...scope, runId: 'run-1', folder, directory, paths: ['raw.csv'] })

describe('Project folder staged files', () => {
  it('uses independent input bytes and leaves hardlink aliases unchanged during staging and publication', async () => {
    const alias = join(root, 'alias.csv')
    await link(join(folder, 'raw.csv'), alias)
    const staged = await stage()
    const source = await stat(join(folder, 'raw.csv'))
    const copy = await stat(join(directory, 'raw.csv'))
    expect([copy.dev, copy.ino]).not.toEqual([source.dev, source.ino])
    await writeFile(join(directory, 'raw.csv'), 'candidate')
    await expect(readFile(alias, 'utf8')).resolves.toBe('a,b\n1,2\n')
    const change = await service.prepare(staged, 'raw.csv', 'write')
    expect(change).toMatchObject({
      operation: 'replace',
      requiresConfirmation: true,
      state: 'prepared'
    })
    await service.apply(scope, change!.id)
    await expect(readFile(join(folder, 'raw.csv'), 'utf8')).resolves.toBe('candidate')
    await expect(readFile(alias, 'utf8')).resolves.toBe('a,b\n1,2\n')
    await expect(
      readFile(
        join(
          storage,
          'project-folder-history',
          'changes',
          scope.projectId,
          scope.sessionId,
          change!.id,
          'backup'
        ),
        'utf8'
      )
    ).resolves.toBe('a,b\n1,2\n')
    await service.revert(scope, change!.id)
    await expect(readFile(join(folder, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
  })

  it('rejects pre-existing hardlink staging aliases and refreshes unchanged copies on later runs', async () => {
    await link(join(folder, 'raw.csv'), join(directory, 'raw.csv'))
    await expect(stage()).rejects.toThrow(/share a mutable file identity/)
    await rm(join(directory, 'raw.csv'))
    await stage()
    await writeFile(join(folder, 'raw.csv'), 'updated source')
    await stage()
    await expect(readFile(join(directory, 'raw.csv'), 'utf8')).resolves.toBe('updated source')
    await writeFile(join(directory, 'raw.csv'), 'pending candidate')
    await writeFile(join(folder, 'raw.csv'), 'next source')
    await expect(stage()).rejects.toThrow(/changed while/)
    await expect(readFile(join(directory, 'raw.csv'), 'utf8')).resolves.toBe('pending candidate')
    await expect(readFile(join(folder, 'raw.csv'), 'utf8')).resolves.toBe('next source')
  })

  it.each(['ask', 'auto', 'full'])(
    'requires independent original-file confirmation in %s',
    async (profile) => {
      authorizeCreatedFile.mockResolvedValue(profile !== 'ask')
      approve.mockResolvedValue(false)
      const staged = await stage()
      await writeFile(join(directory, 'raw.csv'), 'candidate')
      const change = await service.prepare(staged, 'raw.csv', 'write')
      expect((await service.apply(scope, change!.id)).state).toBe('rejected')
      expect(approve).toHaveBeenCalledOnce()
      expect(authorizeCreatedFile).not.toHaveBeenCalled()
      await expect(readFile(join(folder, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
    }
  )

  it('freezes the exact reviewed candidate while leaving originals unchanged during pending approval', async () => {
    const staged = await stage()
    await writeFile(join(directory, 'raw.csv'), 'reviewed candidate')
    const change = await service.prepare(staged, 'raw.csv', 'write')
    let accept!: (value: boolean) => void
    approve.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve
        })
    )
    const applying = service.apply(scope, change!.id)
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce())
    await expect(readFile(join(folder, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
    await writeFile(join(directory, 'raw.csv'), 'later unreviewed candidate')
    accept(true)
    await applying
    await expect(readFile(join(folder, 'raw.csv'), 'utf8')).resolves.toBe('reviewed candidate')
  })

  it('does not mutate originals if backup fails or original changes during approval', async () => {
    const staged = await stage()
    await writeFile(join(directory, 'raw.csv'), 'candidate')
    const change = await service.prepare(staged, 'raw.csv', 'write')
    failures.backup = true
    await expect(service.apply(scope, change!.id)).rejects.toThrow('Backup failed')
    await expect(readFile(join(folder, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
    failures.backup = false
    approve.mockImplementationOnce(async () => {
      await writeFile(join(folder, 'raw.csv'), 'user edit')
      return true
    })
    await expect(service.apply(scope, change!.id)).rejects.toThrow(/changed while/)
    await expect(readFile(join(folder, 'raw.csv'), 'utf8')).resolves.toBe('user edit')
  })

  it('publishes a new file under normal permission policy, then recognizes it across service instances', async () => {
    const staged = await stage()
    await mkdir(join(directory, 'results'))
    await writeFile(join(directory, 'results', 'output.csv'), 'new output')
    const created = await service.prepare(staged, 'results/output.csv', 'write')
    await expect(readdir(folder)).resolves.toEqual(['raw.csv'])
    await service.apply(scope, created!.id)
    expect(authorizeCreatedFile).toHaveBeenCalledOnce()
    expect(approve).not.toHaveBeenCalled()
    service = new ProjectFolderStagedFiles({ storageRoot: storage, approve, authorizeCreatedFile })
    const next = await stage()
    await writeFile(join(directory, 'results', 'output.csv'), 'revised output')
    const revised = await service.prepare(next, 'results/output.csv', 'write')
    expect(revised?.requiresConfirmation).toBe(false)
    await service.apply(scope, revised!.id)
    await expect(readFile(join(folder, 'results', 'output.csv'), 'utf8')).resolves.toBe(
      'revised output'
    )
  })

  it('backs up deleted original bytes and restores them on undo', async () => {
    const staged = await stage()
    const change = await service.prepare(staged, 'raw.csv', 'delete')
    await service.apply(scope, change!.id)
    await expect(readdir(folder)).resolves.toEqual([])
    await service.revert(scope, change!.id)
    await expect(readFile(join(folder, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
  })

  it('rejects cross-session lookup, git paths, traversal and source aliases without touching bytes', async () => {
    const staged = await stage()
    await writeFile(join(directory, 'raw.csv'), 'candidate')
    const change = await service.prepare(staged, 'raw.csv', 'write')
    await expect(
      service.apply({ ...scope, sessionId: 'other-session' }, change!.id)
    ).rejects.toThrow()
    for (const path of ['../raw.csv', '.git/config', 'nested/../raw.csv'])
      await expect(service.prepare(staged, path, 'write')).rejects.toThrow(/safe relative/)
    await symlink(root, join(folder, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.prepare(staged, 'escape/file', 'write')).rejects.toThrow(/unsafe/)
    await expect(readFile(join(folder, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
  })

  it('lists scoped durable changes while approval is pending and previews bounded UTF-8 candidate text', async () => {
    const candidate = '研究'.repeat(40_000)
    const change = await service.prepareMutation({
      ...scope,
      runId: 'acp-host-run',
      folder,
      relativePath: 'raw.csv',
      operation: 'write',
      content: Buffer.from(candidate)
    })
    const requests = join(
      storage,
      'project-folder-history',
      'changes',
      scope.projectId,
      scope.sessionId,
      'requests'
    )
    await expect(readdir(requests)).resolves.toEqual([])
    let accept!: (value: boolean) => void
    approve.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve
        })
    )
    const applying = service.apply(scope, change!.id)
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce())
    const page = await service.list(scope, { limit: 1 })
    expect(page.changes).toMatchObject([{ id: change!.id, state: 'prepared' }])
    const preview = await service.preview(scope, change!.id)
    expect(preview.original?.text).toBe('a,b\n1,2\n')
    expect(preview.candidate).toMatchObject({
      binary: false,
      truncated: true,
      sizeBytes: Buffer.byteLength(candidate)
    })
    expect(preview.candidate!.text.length).toBeLessThan(candidate.length)
    expect(preview.candidate!.text).not.toContain('�')
    expect((await service.list({ ...scope, sessionId: 'other-session' })).changes).toEqual([])
    accept(false)
    await applying
    const restarted = new ProjectFolderStagedFiles({
      storageRoot: storage,
      approve,
      authorizeCreatedFile
    })
    expect((await restarted.list(scope)).changes).toMatchObject([
      { id: change!.id, state: 'rejected' }
    ])
  })

  it.skipIf(process.platform === 'win32').each([0o600, 0o755])(
    'preserves original mode %s through replacement and undo with private backup bytes',
    async (mode) => {
      await chmod(join(folder, 'raw.csv'), mode)
      const staged = await stage()
      await writeFile(join(directory, 'raw.csv'), 'candidate')
      const change = await service.prepare(staged, 'raw.csv', 'write')
      await service.apply(scope, change!.id)
      expect((await stat(join(folder, 'raw.csv'))).mode & 0o777).toBe(mode)
      const backup = join(
        storage,
        'project-folder-history',
        'changes',
        scope.projectId,
        scope.sessionId,
        change!.id,
        'backup'
      )
      expect((await stat(backup)).mode & 0o777).toBe(0o600)
      expect((await stat(join(storage, 'project-folder-history'))).mode & 0o777).toBe(0o700)
      await service.revert(scope, change!.id)
      expect((await stat(join(folder, 'raw.csv'))).mode & 0o777).toBe(mode)
    }
  )

  it('rebases Undo to the current binding only for the same physical folder identity', async () => {
    const staged = await stage()
    await writeFile(join(directory, 'raw.csv'), 'candidate')
    const change = await service.prepare(staged, 'raw.csv', 'write')
    await service.apply(scope, change!.id)
    const moved = join(root, 'moved-research')
    await rename(folder, moved)
    await mkdir(folder)
    await writeFile(join(folder, 'raw.csv'), 'unbound bytes')
    await expect(service.revert(scope, change!.id, folder)).rejects.toThrow(/changed while/)
    await service.revert(scope, change!.id, moved)
    await expect(readFile(join(moved, 'raw.csv'), 'utf8')).resolves.toBe('a,b\n1,2\n')
    await expect(readFile(join(folder, 'raw.csv'), 'utf8')).resolves.toBe('unbound bytes')
  })

  it('emits scope-only state notifications after persistence, including completed apply and Undo', async () => {
    const changed = vi.fn()
    service = new ProjectFolderStagedFiles({
      storageRoot: storage,
      approve,
      authorizeCreatedFile,
      onChanged: changed
    })
    const staged = await stage()
    await writeFile(join(directory, 'raw.csv'), 'candidate')
    const change = await service.prepare(staged, 'raw.csv', 'write')
    await service.apply(scope, change!.id)
    expect(changed).toHaveBeenLastCalledWith(scope)
    expect((await service.inspect(scope, change!.id)).state).toBe('applied')
    const before = changed.mock.calls.length
    await service.revert(scope, change!.id)
    expect(changed.mock.calls.length).toBeGreaterThan(before)
    expect(changed).toHaveBeenLastCalledWith(scope)
    expect((await service.inspect(scope, change!.id)).state).toBe('reverted')
  })

  it('does not write to a project folder replaced after staging', async () => {
    const staged = await stage()
    await rename(folder, join(root, 'saved'))
    await mkdir(folder)
    await writeFile(join(folder, 'raw.csv'), 'replacement')
    await expect(service.prepare(staged, 'raw.csv', 'delete')).rejects.toThrow(/root alias changed/)
    await expect(readFile(join(folder, 'raw.csv'), 'utf8')).resolves.toBe('replacement')
  })
})

it('keeps internal records out of input provenance and staged file mutations', async () => {
  await mkdir(join(folder, '.open-science/notebook'), { recursive: true })
  await writeFile(join(folder, '.open-science/notebook/record.json'), '{}')
  await symlink(
    join(folder, '.open-science/notebook'),
    join(folder, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const inputs = await service.describeInputs(folder, folder, [
    'raw.csv',
    '.open-science/notebook/record.json',
    'alias/record.json'
  ])
  expect(inputs.map((input) => input.relativePath)).toEqual(['raw.csv'])
  await expect(
    service.stage({
      ...scope,
      runId: 'records',
      folder,
      directory,
      paths: ['.open-science/notebook/record.json']
    })
  ).rejects.toThrow('safe relative')
})
