import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunDocument } from '../../shared/notebook'
import type { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'

const document: NotebookRunDocument = {
  version: 1,
  projectName: 'default-project',
  sessionId: '12345678-abcd',
  workspaceCwd: '/workspace',
  notebookSessionRoot: '/storage/notebooks/default-project/12345678-abcd',
  dataRoot: '/storage/notebooks/default-project/12345678-abcd/data',
  kernel: {
    language: 'python',
    kernelName: 'python3',
    runtimeRoot: '/storage/runtime',
    lastKnownStatus: 'idle'
  },
  runs: [
    {
      runId: 'run-1',
      cellId: 'cell-1',
      source: 'agent',
      kernelKind: 'python',
      script: 'print("hello")',
      status: 'completed',
      startedAt: 1,
      executionCount: 1,
      text: { stdout: 'hello', stderr: '', traceback: '', plain: ['hello'] },
      outputs: [],
      artifacts: [],
      workingFiles: []
    }
  ],
  updatedAt: 2
}

describe('NotebookRuntimeService exportIpynb', () => {
  it('loads the durable document and sends a serialized nbformat notebook to the save seam', async () => {
    const repository = {
      findExisting: vi.fn().mockResolvedValue(document)
    } as unknown as NotebookRunRepository
    const saveIpynb = vi
      .fn()
      .mockResolvedValue({ saved: true, filePath: '/downloads/session.ipynb' })
    const service = new NotebookRuntimeService({
      configRoot: '/config',
      dataRoot: '/storage',
      projectName: 'default-project',
      repository,
      appVersion: '1.2.3',
      saveIpynb
    })

    const result = await service.exportIpynb({
      sessionId: '12345678-abcd',
      workspaceCwd: '/workspace'
    })

    expect(repository.findExisting).toHaveBeenCalledWith('default-project', '12345678-abcd')
    expect(saveIpynb).toHaveBeenCalledOnce()
    expect(saveIpynb.mock.calls[0][0]).toBe('session-12345678.ipynb')
    const exported = JSON.parse(saveIpynb.mock.calls[0][1]) as {
      nbformat: number
      metadata: { open_science: { appVersion: string } }
      cells: Array<{ source: string[] }>
    }
    expect(exported).toMatchObject({
      nbformat: 4,
      metadata: { open_science: { appVersion: '1.2.3' } }
    })
    expect(exported.cells[0].source).toEqual(['print("hello")'])
    expect(result).toEqual({ saved: true, filePath: '/downloads/session.ipynb' })
  })

  it('saves mixed sessions as separate per-kernel notebooks', async () => {
    const mixedDocument: NotebookRunDocument = {
      ...document,
      runs: [
        document.runs[0],
        {
          ...document.runs[0],
          runId: 'run-r',
          cellId: 'cell-r',
          kernelKind: 'r',
          script: 'print(2)',
          environment: 'default-r'
        }
      ]
    }
    const repository = {
      findExisting: vi.fn().mockResolvedValue(mixedDocument)
    } as unknown as NotebookRunRepository
    const saveSplitIpynb = vi.fn().mockResolvedValue({
      saved: true,
      filePaths: ['/downloads/python.ipynb', '/downloads/r.ipynb']
    })
    const service = new NotebookRuntimeService({
      configRoot: '/config',
      dataRoot: '/storage',
      projectName: 'default-project',
      repository,
      saveSplitIpynb
    })

    const result = await service.exportIpynbByKernel({
      sessionId: '12345678-abcd',
      workspaceCwd: '/workspace'
    })

    expect(saveSplitIpynb).toHaveBeenCalledOnce()
    const files = saveSplitIpynb.mock.calls[0][0] as Array<{ name: string; data: string }>
    expect(files.map(({ name }) => name)).toEqual([
      'session-12345678-python.ipynb',
      'session-12345678-r.ipynb'
    ])
    expect(
      files.map(
        ({ data }) =>
          (JSON.parse(data) as { metadata: { kernelspec: { name: string } } }).metadata.kernelspec
            .name
      )
    ).toEqual(['python3', 'ir'])
    expect(result).toEqual({
      saved: true,
      filePaths: ['/downloads/python.ipynb', '/downloads/r.ipynb']
    })
  })

  it('rejects an unknown session before opening the save dialog', async () => {
    const repository = {
      findExisting: vi.fn().mockResolvedValue(null)
    } as unknown as NotebookRunRepository
    const saveIpynb = vi.fn()
    const service = new NotebookRuntimeService({
      configRoot: '/config',
      dataRoot: '/storage',
      projectName: 'default-project',
      repository,
      saveIpynb
    })

    await expect(
      service.exportIpynb({ sessionId: 'missing', workspaceCwd: '/workspace' })
    ).rejects.toThrow('Notebook session not found: missing')
    expect(saveIpynb).not.toHaveBeenCalled()
  })

  describe('artifact inlining', () => {
    let sessionRoot: string | undefined

    afterEach(async () => {
      if (sessionRoot) {
        await rm(sessionRoot, { recursive: true, force: true })
        sessionRoot = undefined
      }
    })

    const createSessionRoot = async (): Promise<string> => {
      sessionRoot = await mkdtemp(join(tmpdir(), 'open-science-ipynb-artifacts-'))
      return sessionRoot
    }

    type ArtifactRecord = NotebookRunDocument['runs'][number]['artifacts'][number]

    const makeArtifact = (overrides: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
      id: 'a1',
      projectName: 'default-project',
      sessionId: '12345678-abcd',
      runId: 'run-1',
      name: 'plot.png',
      path: '',
      fileUrl: 'artifact://plot.png',
      mimeType: 'image/png',
      size: 0,
      mtimeMs: 1,
      ...overrides
    })

    type ExportResult = {
      outputs: Array<{ output_type: string; data?: Record<string, unknown>; text?: string[] }>
      json: string
    }

    const exportWithArtifact = async (
      root: string,
      artifact: ArtifactRecord,
      options: {
        resolveArtifactPath?: (request: {
          path: string
          projectName: string
          sessionId: string
        }) => Promise<string>
      } = {}
    ): Promise<ExportResult> => {
      const documentWithArtifact: NotebookRunDocument = {
        ...document,
        notebookSessionRoot: root,
        runs: [{ ...document.runs[0], artifacts: [artifact] }]
      }
      const repository = {
        findExisting: vi.fn().mockResolvedValue(documentWithArtifact)
      } as unknown as NotebookRunRepository
      const saveIpynb = vi.fn().mockResolvedValue({ saved: true, filePath: '/out/session.ipynb' })
      const service = new NotebookRuntimeService({
        configRoot: '/config',
        dataRoot: '/storage',
        projectName: 'default-project',
        repository,
        saveIpynb,
        ...(options.resolveArtifactPath ? { resolveArtifactPath: options.resolveArtifactPath } : {})
      })

      await service.exportIpynb({ sessionId: '12345678-abcd', workspaceCwd: '/workspace' })

      const json = saveIpynb.mock.calls[0][1] as string
      const notebook = JSON.parse(json) as {
        cells: Array<{ outputs: ExportResult['outputs'] }>
      }
      return { outputs: notebook.cells[0].outputs, json }
    }

    // The run's own stream fallback comes first; the artifact display output follows it.
    const displayData = (result: ExportResult): Record<string, unknown> =>
      result.outputs.find((output) => output.output_type === 'display_data')?.data ?? {}

    it('inlines SVG artifacts as raw text, not base64', async () => {
      const root = await createSessionRoot()
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
      const svgPath = join(root, 'plot.svg')
      await writeFile(svgPath, svg)

      const result = await exportWithArtifact(
        root,
        makeArtifact({
          name: 'plot.svg',
          path: svgPath,
          mimeType: 'image/svg+xml',
          size: svg.length
        })
      )

      expect(displayData(result)['image/svg+xml']).toBe(svg)
    })

    it('inlines binary image artifacts as base64', async () => {
      const root = await createSessionRoot()
      const pngPath = join(root, 'plot.png')
      await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

      const result = await exportWithArtifact(root, makeArtifact({ path: pngPath, size: 4 }))

      expect(displayData(result)['image/png']).toBe(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
      )
    })

    // File symlinks need elevated privileges on Windows; covered on POSIX CI.
    it.skipIf(process.platform === 'win32')(
      'refuses to inline a notebook-root symlink that escapes the session root',
      async () => {
        const root = await createSessionRoot()
        const outsideDir = await mkdtemp(join(tmpdir(), 'open-science-ipynb-outside-'))
        try {
          const secretPath = join(outsideDir, 'secret.png')
          await writeFile(secretPath, 'secret-png-bytes')
          const linkPath = join(root, 'link.png')
          await symlink(secretPath, linkPath)

          const result = await exportWithArtifact(
            root,
            makeArtifact({ name: 'link.png', path: linkPath })
          )

          expect(result.outputs.some((output) => output.output_type === 'display_data')).toBe(false)
          expect(result.outputs.some((output) => output.output_type === 'stream')).toBe(true)
          expect(result.json).not.toContain('secret-png-bytes')
        } finally {
          await rm(outsideDir, { recursive: true, force: true })
        }
      }
    )

    it('inlines a managed artifact resolved inside the declaring session subtree', async () => {
      const root = await createSessionRoot()
      // The managed artifact tree lives outside the notebook session root, so resolution goes
      // through the session-scoped resolver rather than the notebook-root branch.
      const managedRoot = await mkdtemp(join(tmpdir(), 'open-science-ipynb-managed-'))
      try {
        const managedDir = join(managedRoot, 'artifacts', 'default-project', '12345678-abcd')
        await mkdir(managedDir, { recursive: true })
        const managedPath = join(managedDir, 'plot.png')
        await writeFile(managedPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        const resolveArtifactPath = vi.fn(
          async (request: { path: string; projectName: string; sessionId: string }) => request.path
        )

        const result = await exportWithArtifact(
          root,
          makeArtifact({ path: managedPath, size: 4 }),
          { resolveArtifactPath }
        )

        expect(resolveArtifactPath).toHaveBeenCalledWith({
          path: managedPath,
          projectName: 'default-project',
          sessionId: '12345678-abcd'
        })
        expect(displayData(result)['image/png']).toBe(
          Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
        )
      } finally {
        await rm(managedRoot, { recursive: true, force: true })
      }
    })

    it('degrades a managed artifact the session-scoped resolver rejects to a stderr marker', async () => {
      const root = await createSessionRoot()
      const outsidePath = join(
        tmpdir(),
        'artifacts',
        'default-project',
        'other-session',
        'plot.png'
      )
      const resolveArtifactPath = vi.fn(async () => {
        throw new Error('Artifact file is outside the declaring session.')
      })

      const result = await exportWithArtifact(root, makeArtifact({ path: outsidePath }), {
        resolveArtifactPath
      })

      expect(result.outputs.some((output) => output.output_type === 'display_data')).toBe(false)
      expect(result.outputs).toContainEqual({
        output_type: 'stream',
        name: 'stderr',
        text: ['[Open Science] Could not inline artifact: plot.png\n']
      })
    })
  })
})
