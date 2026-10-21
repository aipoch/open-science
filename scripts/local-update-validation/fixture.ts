/** Offline preparation only. This module is never part of either application bundle. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  createProjectDbClient,
  migrateApplicationDatabase
} from '../../src/main/projects/prisma-client'
import { NotebookRunRepository } from '../../src/main/notebook/repository'
import { createRootNotebookLane } from '../../src/main/notebook/lane-identity'
import { UploadRepository } from '../../src/main/uploads/repository'
import {
  createSessionFile,
  decodeSessionFile
} from '../../src/shared/session-persistence/file-codec'
import { toPersistedUploadedAttachment } from '../../src/shared/uploads'

export const FIXTURE_PROJECT = 'local-update-project'
export const FIXTURE_SESSION = 'local-update-history'
const TIME = 1_760_000_000_000
const ATTACHMENT = 'Local update validation attachment. No private research data.\n'
const OUTPUT = 'LOCAL_UPDATE_SAVED_OUTPUT: 42\n'
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
type FixtureConfig = { configRoot: string; dataRoot: string }
const paths = ({
  configRoot,
  dataRoot
}: FixtureConfig): { workspace: string; session: string; notebook: string; manifest: string } => ({
  workspace: join(dataRoot, 'workspaces', FIXTURE_PROJECT),
  session: join(configRoot, 'sessions', FIXTURE_PROJECT, `${FIXTURE_SESSION}.json`),
  notebook: join(dataRoot, 'notebooks', FIXTURE_PROJECT, FIXTURE_SESSION, 'run.json'),
  manifest: join(dirname(configRoot), 'fixture-manifest.json')
})
const json = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n')
}
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export async function prepareFixture(config: FixtureConfig): Promise<void> {
  for (const directory of [config.configRoot, config.dataRoot]) {
    assert.equal(resolve(directory), directory, 'Fixture paths must be absolute')
    await mkdir(directory, { recursive: true })
    assert.deepEqual(await readdir(directory), [], 'Refusing to reseed an existing scenario')
  }
  const p = paths(config)
  await mkdir(p.workspace, { recursive: true })
  const client = createProjectDbClient(config.configRoot)
  try {
    await migrateApplicationDatabase(client, {
      databasePath: join(config.configRoot, 'open-science.db')
    })
    await client.project.create({
      data: {
        id: FIXTURE_PROJECT,
        name: 'Local update validation',
        description: 'Disposable fixed research data for macOS local update validation.'
      }
    })
    const uploads = new UploadRepository(config.dataRoot, { getClient: async () => client })
    await uploads.beginTransfer({
      transferId: 'local-update-attachment',
      name: 'evidence.txt',
      mimeType: 'text/plain',
      size: Buffer.byteLength(ATTACHMENT)
    })
    await uploads.appendTransfer({
      transferId: 'local-update-attachment',
      offset: 0,
      chunk: Buffer.from(ATTACHMENT)
    })
    const staged = await uploads.finishTransfer({ transferId: 'local-update-attachment' })
    const [attachment] = await uploads.finalizePendingSessionUploads(
      FIXTURE_SESSION,
      [staged],
      FIXTURE_PROJECT
    )
    const attachmentPath = await uploads.resolveSessionUploadPath(
      FIXTURE_SESSION,
      { path: attachment.path },
      FIXTURE_PROJECT
    )
    const session = createSessionFile({
      id: FIXTURE_SESSION,
      projectId: FIXTURE_PROJECT,
      title: 'Saved update validation history',
      cwd: p.workspace,
      status: 'idle',
      createdAt: TIME,
      updatedAt: TIME + 1,
      permissionProfile: 'ask',
      memoryEnabled: false,
      delegationPolicy: 'deny',
      messages: [
        {
          id: 'local-update-question',
          role: 'user',
          content: 'Retain this attachment and the saved Notebook output through update recovery.',
          uploads: [toPersistedUploadedAttachment(attachment)],
          status: 'complete',
          eventIds: [],
          createdAt: TIME,
          updatedAt: TIME
        },
        {
          id: 'local-update-answer',
          role: 'agent',
          responseToMessageId: 'local-update-question',
          content: 'Fixed fixture: the saved result is 42.',
          status: 'complete',
          eventIds: [],
          createdAt: TIME + 1,
          updatedAt: TIME + 1
        }
      ]
    })
    await json(p.session, session)
    await json(join(config.configRoot, 'sessions', 'manifest.json'), {
      version: 1,
      lastSessionId: FIXTURE_SESSION
    })
    const notebooks = new NotebookRunRepository(config.dataRoot)
    const frame = `root-frame-${FIXTURE_SESSION}`
    const lane = createRootNotebookLane(FIXTURE_PROJECT, FIXTURE_SESSION, frame)
    await notebooks.loadOrCreate({
      projectId: FIXTURE_PROJECT,
      sessionId: FIXTURE_SESSION,
      workspaceCwd: p.workspace,
      lane
    })
    await notebooks.appendRun({
      projectId: FIXTURE_PROJECT,
      sessionId: FIXTURE_SESSION,
      lane,
      run: {
        runId: 'local-update-saved-run',
        cellId: 'local-update-saved-cell',
        source: 'user',
        kernelKind: 'bash',
        script: "printf 'LOCAL_UPDATE_SAVED_OUTPUT: 42\\n'",
        status: 'completed',
        startedAt: TIME,
        endedAt: TIME + 1,
        executionCount: 1,
        text: { stdout: OUTPUT, stderr: '', traceback: '', plain: [] },
        outputs: [],
        workingFiles: [],
        rootFrameId: frame,
        agentFrameId: frame
      }
    })
    await json(join(config.configRoot, 'settings.json'), {
      version: 2,
      providers: [],
      dataRoot: config.dataRoot,
      onboardingCompletedAt: TIME,
      localePreference: 'en',
      packageMirror: 'official'
    })
    // The user runs these from the application's Notebook Shell. The runner never executes them.
    const taskPath = join(p.workspace, 'task.sh')
    await writeFile(
      taskPath,
      `#!/bin/sh\nset -eu\nprintf '%s\\n' "$$" > ${shellQuote(join(p.workspace, 'task.pid'))}\nprintf 'LOCAL_UPDATE_TASK_STARTED\\n'\nexec /bin/sleep 600\n`
    )
    const writePath = join(p.workspace, 'recovery-write.sh')
    await writeFile(
      writePath,
      `#!/bin/sh\nset -eu\nprintf 'LOCAL_UPDATE_RECOVERY_WRITE\\n' > ${shellQuote(join(p.workspace, 'recovery-write.txt'))}\ncat ${shellQuote(join(p.workspace, 'recovery-write.txt'))}\n`
    )
    await json(p.manifest, {
      version: 1,
      projectId: FIXTURE_PROJECT,
      sessionId: FIXTURE_SESSION,
      sessionPath: p.session,
      notebookPath: p.notebook,
      workspace: p.workspace,
      attachment: {
        id: attachment.id,
        versionId: attachment.versionId,
        path: attachmentPath,
        sha256: sha256(ATTACHMENT)
      },
      taskCommand: `/bin/sh ${shellQuote(taskPath)}`,
      recoveryWriteCommand: `/bin/sh ${shellQuote(writePath)}`,
      savedOutput: OUTPUT
    })
  } finally {
    await client.$disconnect()
  }
}

/** Read observations, never migrate, seed, restart a service, or execute a task. */
export async function verifyFixture(config: FixtureConfig): Promise<{
  preserved: boolean
  checks: Record<string, boolean>
  recoveryWrite: { exists: boolean; mtimeMs?: number }
}> {
  const p = paths(config)
  const manifest = JSON.parse(await readFile(p.manifest, 'utf8'))
  const checks: Record<string, boolean> = {}
  const check = async (name: string, read: () => Promise<boolean>): Promise<void> => {
    checks[name] = await read().catch(() => false)
  }
  const databasePresent = await stat(join(config.configRoot, 'open-science.db'))
    .then((entry) => entry.isFile())
    .catch(() => false)
  const client = databasePresent ? createProjectDbClient(config.configRoot) : undefined
  try {
    // Never connect to an absent database: Prisma would create a new SQLite file on first read.
    await check(
      'project',
      async () =>
        (await client?.project.findUnique({ where: { id: FIXTURE_PROJECT } }))?.name ===
        'Local update validation'
    )
    await check('history', async () => {
      const decoded = decodeSessionFile(JSON.parse(await readFile(p.session, 'utf8')))
      return (
        decoded.status === 'ok' &&
        decoded.session.messages.some(
          (message) =>
            message.id === 'local-update-answer' &&
            message.content === 'Fixed fixture: the saved result is 42.'
        ) &&
        decoded.session.messages.some((message) =>
          message.uploads?.some(
            (upload) =>
              upload.id === manifest.attachment.id &&
              upload.versionId === manifest.attachment.versionId
          )
        )
      )
    })
    await check(
      'attachment',
      async () => sha256(await readFile(manifest.attachment.path)) === manifest.attachment.sha256
    )
    await check('notebook', async () => {
      const document = JSON.parse(await readFile(p.notebook, 'utf8'))
      const runs = document.runs ?? document.document?.runs ?? []
      return runs.some(
        (run: { runId: string; text?: { stdout: string } }) =>
          run.runId === 'local-update-saved-run' && run.text?.stdout === OUTPUT
      )
    })
    await check('settings', async () => {
      const settings = JSON.parse(await readFile(join(config.configRoot, 'settings.json'), 'utf8'))
      return settings.dataRoot === config.dataRoot && settings.localePreference === 'en'
    })
  } finally {
    await client?.$disconnect()
  }
  const marker = join(p.workspace, 'recovery-write.txt')
  const recoveryWrite = await readFile(marker, 'utf8')
    .then(async (value) => ({
      exists: value === 'LOCAL_UPDATE_RECOVERY_WRITE\n',
      mtimeMs: (await stat(marker)).mtimeMs
    }))
    .catch(() => ({ exists: false }))
  return { preserved: Object.values(checks).every(Boolean), checks, recoveryWrite }
}

// Runner bundles this file as fixture.cjs inside the captured build's dependency tree.
if (process.argv[1]?.endsWith('/fixture.cjs')) {
  const verify = process.argv[2] === '--verify'
  const configPath = process.argv[verify ? 3 : 2]
  void (async () => {
    const config = JSON.parse(await readFile(configPath, 'utf8')) as FixtureConfig
    if (verify) {
      const result = await verifyFixture(config)
      await json(join(dirname(configPath), 'fixture-verification.json'), result)
      process.stdout.write(JSON.stringify(result) + '\n')
    } else await prepareFixture(config)
  })().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
