import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect } from '@playwright/test'
import type { TaskRun, TaskSessionSummary } from '../src/shared/task-api'
import { test } from './fixtures/electron-app'
import { createProject } from './certification/helpers'

const execute = promisify(execFile)

for (const observe of [false, true]) {
  test(`publishes a CLI Task ${observe ? 'while observed in the desktop' : 'without opening its Session'}`, async ({
    app
  }) => {
    test.setTimeout(180_000)
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await page.evaluate(() =>
      window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
    )
    const projectName = `Task publication ${observe ? 'observed' : 'background'}`
    const projectId = await createProject(page, projectName)
    const webUrl = new URL(await app.authenticatedWebUrl())
    // The fixture owns this sibling directory. Verify the service identity before calling the CLI;
    // an explicit root prevents discovery of any developer or production instance.
    const evidenceRoot = await app.createTestDirectory('task-cli-evidence')
    const configRoot = join(dirname(evidenceRoot), 'storage')
    const service = JSON.parse(await readFile(join(configRoot, 'web-service.json'), 'utf8'))
    expect(String(service.port)).toBe(webUrl.port)
    const cli = async <T>(args: string[]): Promise<T> => {
      const { stdout } = await execute(
        process.execPath,
        [resolve('packages/open-science/cli.mjs'), ...args, '--config-root', configRoot, '--json'],
        { timeout: 30_000, maxBuffer: 1024 * 1024 }
      )
      return JSON.parse(stdout) as T
    }
    const prompt = `Create a provenance artifact.${observe ? ' Observe the Task before publication.' : ''}`
    const started = await cli<TaskRun>([
      'run',
      '--project',
      projectId,
      '--prompt',
      prompt,
      '--approval-profile',
      'auto'
    ])
    expect(started.projectId).toBe(projectId)
    if (observe) {
      expect((await cli<TaskRun>(['run', 'status', started.id])).status).toBe('running')
      await page
        .getByRole('navigation', { name: 'Sessions' })
        .locator('button[data-slot="session-open-button"]')
        .filter({ hasText: 'Create a provenance artifact.' })
        .click()
      expect((await cli<TaskRun>(['run', 'status', started.id])).status).toBe('running')
    }
    let completed: TaskRun | undefined
    await expect
      .poll(
        async () => {
          completed = await cli<TaskRun>(['run', 'status', started.id])
          return completed.status
        },
        { timeout: 90_000, intervals: [500, 1000] }
      )
      .not.toBe('running')
    expect(completed?.error).toBeUndefined()
    expect(completed?.status).toBe('completed')
    expect(completed?.artifacts).toHaveLength(1)
    const summary = await cli<TaskSessionSummary>(['session', 'status', started.sessionId])
    expect(summary).toMatchObject({ status: 'idle', artifactCount: 1 })
    const durable = await page.evaluate(
      async (id) =>
        (await window.api.sessions.loadAll()).sessions.find((session) => session.id === id),
      started.sessionId
    )
    expect(durable).toMatchObject({ runtimeTranscriptOwner: 'main', status: 'idle' })
    expect(durable?.activeRun).toBeUndefined()
    expect(durable?.error).toBeUndefined()
    expect(durable?.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(durable?.messages.filter((message) => message.role === 'agent')).toHaveLength(1)
    expect(durable?.artifacts).toHaveLength(1)
    const artifact = completed!.artifacts[0]
    expect(durable?.artifacts?.[0].versionId).toBe(artifact.versionId)
    expect(durable?.artifacts?.[0].sha256).toBe(artifact.checksum)
    expect(artifact.checksum).toMatch(/^[a-f0-9]{64}$/u)
    const downloadPath = join(evidenceRoot, 'provenance-evidence.txt')
    await cli(['artifacts', 'download', artifact.id, '--output', downloadPath])
    const downloaded = await readFile(downloadPath)
    expect(downloaded.toString('utf8')).toBe('artifact provenance e2e')
    expect(createHash('sha256').update(downloaded).digest('hex')).toBe(artifact.checksum)
    const owners = durable?.conversationGraph?.messages.filter((message) =>
      message.artifactIds?.includes(durable!.artifacts![0].id)
    )
    expect(owners).toHaveLength(1)
    expect(owners?.[0].id).toBe(artifact.messageId)
    expect(owners?.[0].responseToMessageId).toBe(durable?.runtimeTranscriptLastRun?.promptMessageId)
    if (!observe)
      await page
        .getByRole('navigation', { name: 'Sessions' })
        .locator('button[data-slot="session-open-button"]')
        .filter({ hasText: 'Create a provenance artifact.' })
        .click()
    await expect(
      page.getByText('Artifact provenance verified for session', { exact: false })
    ).toBeVisible()
  })
}
