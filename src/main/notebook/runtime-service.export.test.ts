import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

    const exportWithArtifact = async (
      root: string,
      artifact: NotebookRunDocument['runs'][number]['artifacts'][number]
    ): Promise<Record<string, unknown>> => {
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
        saveIpynb
      })

      await service.exportIpynb({ sessionId: '12345678-abcd', workspaceCwd: '/workspace' })

      const notebook = JSON.parse(saveIpynb.mock.calls[0][1]) as {
        cells: Array<{ outputs: Array<{ output_type: string; data?: Record<string, unknown> }> }>
      }
      // The run's own stream fallback comes first; the artifact display output follows it.
      const display = notebook.cells[0].outputs.find(
        (output) => output.output_type === 'display_data'
      )
      return display?.data ?? {}
    }

    it('inlines SVG artifacts as raw text, not base64', async () => {
      const root = await createSessionRoot()
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
      const svgPath = join(root, 'plot.svg')
      await writeFile(svgPath, svg)

      const data = await exportWithArtifact(root, {
        id: 'a1',
        projectName: 'default-project',
        sessionId: '12345678-abcd',
        runId: 'run-1',
        name: 'plot.svg',
        path: svgPath,
        fileUrl: 'artifact://plot.svg',
        mimeType: 'image/svg+xml',
        size: svg.length,
        mtimeMs: 1
      })

      expect(data['image/svg+xml']).toBe(svg)
    })

    it('inlines binary image artifacts as base64', async () => {
      const root = await createSessionRoot()
      const pngPath = join(root, 'plot.png')
      await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

      const data = await exportWithArtifact(root, {
        id: 'a2',
        projectName: 'default-project',
        sessionId: '12345678-abcd',
        runId: 'run-1',
        name: 'plot.png',
        path: pngPath,
        fileUrl: 'artifact://plot.png',
        mimeType: 'image/png',
        size: 4,
        mtimeMs: 1
      })

      expect(data['image/png']).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'))
    })
  })
})
