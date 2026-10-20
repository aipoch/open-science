import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSettingsExportFiles, createSettingsFileCommands } from './file-commands'
import { createElectronCallerContext, createWebCallerContext } from '../caller-context'
import type { ApplicationInvocation } from '../application-command-router'
import { englishNativeTranslator } from '../locale/main-process-messages'

const native = vi.hoisted(() => ({ chooseFiles: vi.fn(), chooseSavePath: vi.fn() }))
vi.mock('../desktop-interaction', () => ({ desktopFileInteraction: () => native }))
const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
function invocation<T extends readonly unknown[]>(
  args: T,
  controller = new AbortController()
): ApplicationInvocation<T> {
  const callerContext = createElectronCallerContext(42)
  return {
    args,
    callerContext,
    callerLease: {
      leaseId: callerContext.leaseId,
      generation: 1,
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted
    }
  }
}
function service(): Parameters<typeof createSettingsFileCommands>[0] {
  return {
    buildSkillExport: vi.fn(async () => ({
      fileName: 'skill.zip',
      archiveBytes: new Uint8Array([1, 2])
    })),
    previewCustomServerTemplateImport: vi.fn(),
    buildCustomServerTemplateExport: vi.fn(async () => ({
      preview: {
        connectorId: 'connector',
        ready: true,
        diagnostics: [],
        digest: 'reviewed',
        suggestedFileName: 'connector.json'
      },
      contents: '{"schemaVersion":1}\n'
    }))
  }
}

describe('shared Settings file workflows', () => {
  it('revalidates the preview digest before opening a dialog and publishes the reviewed data atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'settings-node-export-'))
    roots.push(directory)
    const destination = join(directory, 'connector.json')
    await writeFile(destination, 'original')
    native.chooseSavePath.mockResolvedValue({ canceled: false, filePath: destination })
    const commands = createSettingsFileCommands(
      service(),
      createSettingsExportFiles(englishNativeTranslator)
    )
    await expect(
      commands.exportTemplate(invocation([{ id: 'connector', expectedDigest: 'stale' }]))
    ).rejects.toThrow('changed after preview')
    expect(native.chooseSavePath).not.toHaveBeenCalled()
    await expect(
      commands.exportTemplate(invocation([{ id: 'connector', expectedDigest: 'reviewed' }]))
    ).resolves.toEqual({ saved: true })
    expect(native.chooseSavePath).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'connector.json' }),
      '42'
    )
    expect(await readFile(destination, 'utf8')).toBe('{"schemaVersion":1}\n')
    expect(await readdir(directory)).toEqual(['connector.json'])
  })

  it('discards a selected destination after the invoking document is revoked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'settings-node-revoked-'))
    roots.push(directory)
    const destination = join(directory, 'skill.zip')
    await writeFile(destination, 'original')
    const controller = new AbortController()
    native.chooseSavePath.mockImplementation(async () => {
      controller.abort()
      return { canceled: false, filePath: destination }
    })
    const commands = createSettingsFileCommands(
      service(),
      createSettingsExportFiles(englishNativeTranslator)
    )
    await expect(commands.exportSkill(invocation([{ id: 'skill' }], controller))).rejects.toThrow()
    expect(await readFile(destination, 'utf8')).toBe('original')
    expect(await readdir(directory)).toEqual(['skill.zip'])
  })

  it('rejects browser authority before reading exports or invoking native dialogs', async () => {
    const owner = service()
    const commands = createSettingsFileCommands(
      owner,
      createSettingsExportFiles(englishNativeTranslator)
    )
    const call = invocation([{ id: 'skill' }] as const)
    await expect(
      commands.exportSkill({ ...call, callerContext: createWebCallerContext('browser') })
    ).rejects.toThrow('desktop app')
    expect(owner.buildSkillExport).not.toHaveBeenCalled()
    expect(native.chooseSavePath).not.toHaveBeenCalled()
  })
})
