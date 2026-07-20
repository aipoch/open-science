import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Path codec falls back to resolveDataRoot(), which reads electron's app.getPath.
vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import type { NotebookRunDocument } from '../../shared/notebook'
import { NOTEBOOKS_DIR, NOTEBOOK_RUN_FILE } from '../../shared/notebook'
import { NotebookRunRepository } from '../notebook/repository'
import { PreviewStateRepository } from '../projects/preview-repository'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { ProjectRepository } from '../projects/repository'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { normalizeLegacyDataPaths } from './normalize-legacy-paths'

let configRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  initDataRoot(undefined)
  await disconnect?.()
  disconnect = undefined
  if (configRoot) {
    await rm(configRoot, { recursive: true, force: true })
    configRoot = undefined
  }
})

// Builds a legacy (pre-sentinel) run.json document with absolute paths under `root`.
const buildLegacyRunDocument = (root: string, projectName: string): NotebookRunDocument => {
  const sessionRoot = join(root, NOTEBOOKS_DIR, projectName, 'session-1')
  return {
    version: 1,
    projectName,
    sessionId: 'session-1',
    workspaceCwd: sessionRoot,
    notebookSessionRoot: sessionRoot,
    dataRoot: join(sessionRoot, 'data'),
    kernel: {
      language: 'python',
      kernelName: 'python3',
      runtimeRoot: join(root, 'runtime'),
      lastKnownStatus: 'idle'
    },
    runs: [
      {
        runId: 'run-1',
        cellId: 'cell-1',
        source: 'agent',
        kernelKind: 'python',
        script: "print('hi')",
        status: 'completed',
        startedAt: 0,
        endedAt: 1,
        cwdBefore: sessionRoot,
        cwdAfter: sessionRoot,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [
          {
            path: join(sessionRoot, 'data', 'processed.csv'),
            relativePath: 'data/processed.csv',
            kind: 'processed-data',
            size: 1,
            mtimeMs: 0,
            createdByRunId: 'run-1'
          }
        ]
      }
    ],
    updatedAt: 0
  }
}

describe('normalizeLegacyDataPaths (integration)', () => {
  it('converts legacy absolute paths to $DATA across sessions, preview state, and notebook run.json — and proves relocation + idempotency', async () => {
    configRoot = await mkdtemp(join(tmpdir(), 'open-science-normalize-'))
    const dataRoot = configRoot // production default: config root and data root coincide
    initDataRoot(dataRoot)

    const client = createProjectDbClient(configRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)

    const projectRepository = new ProjectRepository(() => Promise.resolve(client))
    const previewStateRepository = new PreviewStateRepository(() => Promise.resolve(client))
    const sessionRepository = new SessionRepository(configRoot)

    const project = await projectRepository.create({ name: 'Project A' })
    const projectName = project.id

    // Seed a legacy session file directly on disk (absolute paths), simulating a pre-sentinel install.
    const sessionDir = join(configRoot, 'sessions', projectName)
    await mkdir(sessionDir, { recursive: true })
    const artifactPath = join(dataRoot, 'artifacts', projectName, 'session-1', 'm', 'plot.png')
    const legacySessionFile = {
      version: 1,
      session: {
        id: 'session-1',
        projectId: projectName,
        title: 'Legacy session',
        cwd: join(dataRoot, 'notebooks', projectName, 'session-1'),
        status: 'idle',
        messages: [],
        artifacts: [{ id: 'a1', kind: 'managed-file', path: artifactPath }],
        createdAt: 1,
        updatedAt: 1
      }
    }
    await writeFile(
      join(sessionDir, 'session-1.json'),
      JSON.stringify(legacySessionFile, null, 2),
      'utf8'
    )

    // Seed a legacy preview-state row directly through the DB, bypassing the sentinel-aware writer.
    await client.projectPreviewState.create({
      data: {
        projectId: projectName,
        panelState: 'open',
        activeItemId: null,
        items: JSON.stringify([
          {
            id: 'item-1',
            sessionId: 'session-1',
            title: 'plot.png',
            source: 'artifact',
            path: artifactPath,
            format: 'image',
            name: 'plot.png'
          }
        ])
      }
    })

    // Seed a legacy notebook run.json directly on disk (absolute paths).
    const notebookSessionDir = join(dataRoot, NOTEBOOKS_DIR, projectName, 'session-1')
    await mkdir(notebookSessionDir, { recursive: true })
    await writeFile(
      join(notebookSessionDir, NOTEBOOK_RUN_FILE),
      JSON.stringify(buildLegacyRunDocument(dataRoot, projectName), null, 2),
      'utf8'
    )

    await normalizeLegacyDataPaths({
      sessionRepository,
      previewStateRepository,
      projectRepository,
      dataRoot
    })

    // Session file on disk now uses $DATA and no longer contains the raw data-root prefix.
    const sessionRawAfterFirstPass = await readFile(join(sessionDir, 'session-1.json'), 'utf8')
    expect(sessionRawAfterFirstPass).toContain('$DATA/')
    expect(sessionRawAfterFirstPass).not.toContain(dataRoot)

    // Preview-state row now uses $DATA.
    const previewRowAfterFirstPass = await client.projectPreviewState.findUnique({
      where: { projectId: projectName }
    })
    expect(previewRowAfterFirstPass?.items).toContain('$DATA/')
    expect(previewRowAfterFirstPass?.items).not.toContain(dataRoot)

    // Notebook run.json on disk now uses $DATA.
    const runRawAfterFirstPass = await readFile(join(notebookSessionDir, NOTEBOOK_RUN_FILE), 'utf8')
    expect(runRawAfterFirstPass).toContain('$DATA/')
    expect(runRawAfterFirstPass).not.toContain(dataRoot)

    // --- Relocation: reading from a different data root resolves paths under the new root. ---
    const newRoot = await mkdtemp(join(tmpdir(), 'open-science-normalize-newroot-'))
    try {
      initDataRoot(newRoot)

      const { sessions } = await sessionRepository.loadAll()
      expect(sessions[0].cwd).toBe(join(newRoot, 'notebooks', projectName, 'session-1'))
      expect(sessions[0].artifacts?.[0].path).toBe(
        join(newRoot, 'artifacts', projectName, 'session-1', 'm', 'plot.png')
      )

      const relocatedPreview = await previewStateRepository.get(projectName)
      expect(relocatedPreview?.items[0].path).toBe(
        join(newRoot, 'artifacts', projectName, 'session-1', 'm', 'plot.png')
      )

      // Simulate the notebooks tree having physically moved alongside the data root, then confirm a
      // repository rooted at the new location decodes the $DATA-encoded run.json without throwing.
      await cp(join(dataRoot, NOTEBOOKS_DIR), join(newRoot, NOTEBOOKS_DIR), { recursive: true })
      const relocatedNotebookRepository = new NotebookRunRepository(newRoot)
      const relocatedRun = await relocatedNotebookRepository.findExisting(projectName, 'session-1')

      expect(relocatedRun?.notebookSessionRoot).toBe(
        join(newRoot, NOTEBOOKS_DIR, projectName, 'session-1')
      )
      expect(relocatedRun?.runs[0].workingFiles[0].path).toBe(
        join(newRoot, NOTEBOOKS_DIR, projectName, 'session-1', 'data', 'processed.csv')
      )
    } finally {
      await rm(newRoot, { recursive: true, force: true })
      initDataRoot(dataRoot)
    }

    // --- Idempotency: running the pass again must not double-encode ($DATA/$DATA). ---
    await normalizeLegacyDataPaths({
      sessionRepository,
      previewStateRepository,
      projectRepository,
      dataRoot
    })

    const sessionRawAfterSecondPass = await readFile(join(sessionDir, 'session-1.json'), 'utf8')
    expect(sessionRawAfterSecondPass).not.toContain('$DATA/$DATA')
    expect(sessionRawAfterSecondPass).toContain('$DATA/')

    const previewRowAfterSecondPass = await client.projectPreviewState.findUnique({
      where: { projectId: projectName }
    })
    expect(previewRowAfterSecondPass?.items).not.toContain('$DATA/$DATA')

    const runRawAfterSecondPass = await readFile(
      join(notebookSessionDir, NOTEBOOK_RUN_FILE),
      'utf8'
    )
    expect(runRawAfterSecondPass).not.toContain('$DATA/$DATA')
    expect(runRawAfterSecondPass).toContain('$DATA/')
  })

  it('tolerates a fresh install with no notebooks/ directory and no projects', async () => {
    configRoot = await mkdtemp(join(tmpdir(), 'open-science-normalize-empty-'))
    initDataRoot(configRoot)

    const client = createProjectDbClient(configRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)

    const projectRepository = new ProjectRepository(() => Promise.resolve(client))
    const previewStateRepository = new PreviewStateRepository(() => Promise.resolve(client))
    const sessionRepository = new SessionRepository(configRoot)

    await expect(
      normalizeLegacyDataPaths({
        sessionRepository,
        previewStateRepository,
        projectRepository,
        dataRoot: configRoot
      })
    ).resolves.toBeUndefined()
  })
})
