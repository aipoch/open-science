import type { ContentBlock } from '@agentclientprotocol/sdk'
import { NotebookNetworkSandbox } from '@aipoch/notebook-network-sandbox'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UploadedAttachment } from '../../shared/uploads'
import { getNotebookInputRoot } from '../notebook/input-staging'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const run = (
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stderr: string }> =>
  new Promise((resolveRun, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, shell: false })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolveRun({ code, stderr }))
  })

const contentBlocks = (content: string | ContentBlock[]): ContentBlock[] => {
  expect(Array.isArray(content)).toBe(true)
  return content as ContentBlock[]
}

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')(
  'ACP attachment access from Notebook',
  () => {
    it('lets Notebook copy the exact managed upload snapshot advertised to the Agent', async ({
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
        checksum: '1'.repeat(64),
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
          checksum: '1'.repeat(64),
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
          managedFileVersions: { openLatest, openVersion: vi.fn() }
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
      const destination = join(notebookDataRoot, 'samples.csv')
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
          command: `/bin/cp ${JSON.stringify(advertisedPath)} ${JSON.stringify(destination)}`,
          cwd: notebookDataRoot,
          env: { PATH: '/usr/bin:/bin' },
          filesystem: {
            readOnlyRoots: ['/bin', '/usr/bin', notebookInputRoot, dirname('/bin/cp')],
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
        await expect(readFile(destination, 'utf8')).resolves.toBe(bytes.toString('utf8'))
        await expect(readFile(advertisedPath, 'utf8')).resolves.toBe(bytes.toString('utf8'))
        prepared.close()
        await expect(readFile(advertisedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        prepared.close()
        await sandbox.dispose()
      }
    })
  }
)
