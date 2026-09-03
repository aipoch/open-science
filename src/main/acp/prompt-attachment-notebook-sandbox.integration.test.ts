import type { ContentBlock } from '@agentclientprotocol/sdk'
import { NotebookNetworkSandbox } from '@aipoch/notebook-network-sandbox'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UploadedAttachment } from '../../shared/uploads'
import type { NotebookRunInputFile } from '../../shared/notebook'
import { getNotebookInputRoot } from '../notebook/input-staging'
import { NotebookInputRegistry } from '../notebook/input-registry'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const run = (
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolveRun, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolveRun({ code, stdout, stderr }))
  })

const contentBlocks = (content: string | ContentBlock[]): ContentBlock[] => {
  expect(Array.isArray(content)).toBe(true)
  return content as ContentBlock[]
}

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')(
  'ACP attachment access from Notebook',
  () => {
    it('lets Notebook read the exact managed upload Version through its advertised relative path', async ({
      skip
    }) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-attachment-sandbox-'))
      roots.push(storageRoot)
      const projectId = 'project-1'
      const sessionId = 'session-1'
      const notebookDataRoot = join(storageRoot, 'notebooks', projectId, sessionId, 'data')
      const notebookInputRoot = getNotebookInputRoot(storageRoot, projectId, sessionId)
      await mkdir(notebookDataRoot, { recursive: true })

      const bytes = Buffer.from('sample,group\n1,Ctrl\n2,IRI\n')
      const checksum = createHash('sha256').update(bytes).digest('hex')
      const attachment: UploadedAttachment = {
        id: 'upload-file-1',
        versionId: 'upload-version-1',
        versionNumber: 1,
        sessionId,
        name: 'samples.csv',
        originalName: 'samples.csv',
        path: 'upload-version:stale',
        mimeType: 'text/csv',
        size: bytes.byteLength,
        checksum,
        createdAt: '2026-09-02T00:00:00.000Z'
      }
      const openLatest = vi.fn(async () => ({
        path: '/managed/samples.csv',
        size: bytes.byteLength,
        read: vi.fn(),
        readRange: vi.fn(async (begin: number, end: number) => bytes.subarray(begin, end)),
        copyTo: vi.fn(async (destinationPath: string) =>
          writeFile(destinationPath, bytes, { flag: 'wx' })
        ),
        verifyUnchanged: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        logicalFile: {
          source: 'upload' as const,
          id: attachment.id,
          projectId,
          sessionId,
          displayName: attachment.originalName,
          currentVersionId: 'upload-version-1'
        },
        version: {
          id: 'upload-version-1',
          fileId: attachment.id,
          versionNumber: 1,
          state: 'ready',
          originKind: 'upload',
          basedOnVersionId: null,
          storageTag: 'vabc12345',
          storedFilename: 'vabc12345_samples.csv',
          writeOperationId: 'operation-1',
          contentStorageKey: 'uploads/project-1/session-1/upload-file-1/samples.csv',
          filename: attachment.originalName,
          originalFilename: attachment.originalName,
          contentType: 'text/csv',
          sizeBytes: BigInt(bytes.byteLength),
          checksum,
          createdAt: new Date('2026-09-02T00:00:00.000Z')
        },
        versionToken: 1,
        snapshot: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n }
      }))
      const owners = composeAcpRuntimeBaseOwners({
        appVersion: 'test',
        defaultCwd: notebookDataRoot,
        notebook: { projectId, mcpEntryPath: '/mcp' },
        artifacts: {
          configRoot: join(storageRoot, 'config'),
          dataRoot: storageRoot,
          projectId,
          mcpEntryPath: '/mcp',
          managedFileVersions: { openLatest, openVersion: vi.fn(), openUnpublishedVersion: vi.fn() }
        },
        uploads: {
          repository: {
            finalizePendingSessionUploads: vi.fn(async () => [attachment])
          } as never
        }
      })
      const prepared = await owners.promptContentOwner.prepare({
        appSessionId: sessionId,
        projectId,
        text: 'Draw a pie chart from the attached CSV.',
        historyImages: [],
        historyUploads: [],
        currentUploads: [attachment],
        references: [],
        codexSkillInputs: [],
        skillImportEnabled: false,
        fileTextBudget: 1
      })
      const resource = contentBlocks(prepared.content).find(
        (block): block is Extract<ContentBlock, { type: 'resource_link' }> =>
          block.type === 'resource_link'
      )
      expect(resource).toBeDefined()
      const advertisedPath = fileURLToPath(resource!.uri)
      const advertisedRelativePath = relative(notebookInputRoot, advertisedPath)
      expect(isAbsolute(advertisedRelativePath)).toBe(false)
      expect(advertisedRelativePath).not.toBe('..')
      expect(advertisedRelativePath).not.toMatch(/^\.\.(?:[/\\]|$)/)
      const registeredInput: NotebookRunInputFile = {
        inputFileVersionId: 'upload-version-1',
        sourceKind: 'upload-version',
        sourceFileId: attachment.id,
        sourceVersionNumber: 1,
        sourceProjectId: projectId,
        sourceSessionId: sessionId,
        filename: attachment.originalName,
        contentType: attachment.mimeType,
        sizeBytes: bytes.byteLength,
        checksum,
        storageKey: 'uploads/project-1/session-1/upload-file-1/content',
        association: 'turn-attached'
      }
      const stagedPath = join(notebookInputRoot, registeredInput.sourceKind, checksum, 'content')
      const inputRegistry = new NotebookInputRegistry({
        storageRoot,
        inputAuthority: {
          resolveVersion: vi.fn(async () => registeredInput),
          validateVersion: vi.fn(async () => ({
            state: 'available' as const,
            input: registeredInput
          })),
          openContent: vi.fn(),
          stageContent: vi.fn(async () => {
            await mkdir(dirname(stagedPath), { recursive: true })
            await writeFile(stagedPath, bytes)
            await chmod(stagedPath, 0o444)
            return stagedPath
          })
        }
      })
      const promptInputs = await inputRegistry.registerTurn({
        projectId,
        appSessionId: sessionId,
        promptMessageId: 'prompt-1',
        uploads: prepared.turnInputs!.uploads,
        references: prepared.turnInputs!.references
      })
      expect(promptInputs).toEqual([
        expect.objectContaining({
          filename: 'samples.csv',
          notebookPath: expect.stringMatching(/^inputs[/\\]samples-[a-f0-9]{12}\.csv$/)
        })
      ])
      expect(isAbsolute(promptInputs[0]!.notebookPath)).toBe(false)
      expect(promptInputs[0]!.notebookPath).not.toContain('..')
      const sandbox = new NotebookNetworkSandbox({
        policy: { allowedDomains: [], deniedDomains: [] },
        resources: {
          root: resolve(import.meta.dirname, '../../../packages/notebook-network-sandbox/vendor')
        }
      })

      try {
        const status = await sandbox.status()
        if (status.kind !== 'ready') {
          skip(`Notebook network sandbox is unavailable: ${status.kind}`)
        }
        await sandbox.initialize()
        const wrapped = await sandbox.wrap({
          command: `/bin/cat ${JSON.stringify(promptInputs[0]!.notebookPath)}`,
          cwd: notebookDataRoot,
          env: { PATH: '/usr/bin:/bin' },
          filesystem: {
            readOnlyRoots: ['/bin', '/usr/bin', notebookInputRoot, dirname('/bin/cat')],
            readWriteRoots: [notebookDataRoot],
            deniedReadRoots: [],
            deniedWriteRoots: []
          },
          onNetworkAccessRequest: async () => false
        })
        const result = await run(wrapped.argv, notebookDataRoot, wrapped.env)
        const diagnostic = wrapped.annotateStderr(result.stderr)
        wrapped.cleanup()

        expect(result.code, diagnostic).toBe(0)
        expect(result.stdout).toBe(bytes.toString('utf8'))
        await expect(readFile(advertisedPath, 'utf8')).resolves.toBe(bytes.toString('utf8'))
        prepared.close()
        await expect(readFile(advertisedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(
          readFile(join(notebookDataRoot, promptInputs[0]!.notebookPath), 'utf8')
        ).resolves.toBe(bytes.toString('utf8'))
      } finally {
        prepared.close()
        await sandbox.dispose()
      }
    })
  }
)
