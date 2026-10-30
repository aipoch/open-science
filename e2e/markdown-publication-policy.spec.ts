import { expect } from '@playwright/test'
import { realpathSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from './fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './certification/helpers'
import { createProjectDbClient } from '../src/main/projects/prisma-client'
import type { ManagedFileVersionInspectResult } from '../src/shared/managed-file-versions'

const name = 'publication-policy.md'
const original = '# Publication report\n\nOriginal result.\n'
const edited = '# Publication report\n\nManually corrected result.\n'
test.use({ windowMode: 'normal' })

test('new Markdown publications replace the head while edits, restoration and drafts survive', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  // Register the actual local interpreter in the isolated app, without authorizing installation.
  const python = process.env.OPEN_SCIENCE_TASK_PYTHON
    ? realpathSync(process.env.OPEN_SCIENCE_TASK_PYTHON)
    : undefined
  if (python)
    await page.evaluate(async (python) => {
      await window.api.runtime.registerInterpreter('python', python)
      await window.api.runtime.setEnvironmentEnabled('python', python, true)
      await window.api.runtime.setAgentEnvironmentCreationEnabled({ enabled: false })
    }, python)
  if (process.env.MARKDOWN_REPRO_ROOT && python) {
    const storage = await page.evaluate(() => window.api.storage.getStatus())
    expect(
      realpathSync(storage.dataRoot).startsWith(realpathSync(process.env.MARKDOWN_REPRO_ROOT) + '/')
    ).toBe(true)
    const settings = JSON.parse(
      await readFile(join(dirname(storage.dataRoot), 'settings.json'), 'utf8')
    )
    const canonicalPython = realpathSync(python)
    expect(settings.notebookManualInterpreters.python).toContain(canonicalPython)
    expect(settings.notebookRuntimeEnablement.python.enabled[canonicalPython]).toBe(true)
    await testInfo.attach('isolation-runtime', {
      body: JSON.stringify({
        dataRoot: realpathSync(storage.dataRoot),
        python: canonicalPython,
        enabled: true,
        micromamba: process.env.OPEN_SCIENCE_MICROMAMBA_BIN
      }),
      contentType: 'application/json'
    })
  }
  const capture = async (label: string): Promise<void> => {
    const path = testInfo.outputPath(label + '.png')
    await page.screenshot({ path })
    await testInfo.attach(label, { path, contentType: 'image/png' })
  }
  const projectId = await createProject(page, 'Markdown publication policy')
  const publish = async (
    withoutExecution = false
  ): Promise<{ appSessionId: string; artifactId: string; versionId: string }> => {
    const before = await page.getByText(/^Artifact provenance verified for session /).count()
    await sendPrompt(
      page,
      'Create a provenance artifact. Markdown publication policy' +
        (withoutExecution ? ' Without execution evidence' : ''),
      'Artifact provenance verified for session',
      90000
    )
    const receipts = page.getByText(/^Artifact provenance verified for session /)
    await expect(receipts).toHaveCount(before + 1)
    await expect(receipts.last()).toHaveText(/session [^,]+, artifact [^,]+, version [^.]+\./)
    const receipt = await receipts.last().innerText()
    const match = receipt.match(/session ([^,]+), artifact ([^,]+), version ([^.]+)\./)!
    return { appSessionId: match[1], artifactId: match[2], versionId: match[3] }
  }
  const verifyTaskRead = async (expected: string, version: string): Promise<void> => {
    const reply = sendPrompt(
      page,
      `Verify Markdown task reads. Expected: ${expected}. Historical version: ${version}`,
      'Markdown task read verified.',
      90000
    )
    const review = page.getByRole('group', {
      name: 'Permission request: Review potentially destructive code',
      exact: true
    })
    const needsApproval = await Promise.race([
      reply.then(() => false),
      review.waitFor({ state: 'visible', timeout: 85000 }).then(() => true)
    ])
    if (needsApproval) {
      await expect(review).toContainText('host.artifacts')
      await review.getByRole('button', { name: 'Allow', exact: true }).click()
    }
    await reply
  }
  const first = await publish()
  const identity = { source: 'artifact' as const, projectId, fileId: first.artifactId }
  const inspect = (versionId?: string): Promise<ManagedFileVersionInspectResult> =>
    page.evaluate(
      async (request) => {
        const result = await window.api.managedFileVersions.inspect(request)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      { ...identity, versionId }
    )
  const openFile = async (): Promise<void> => {
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await page
      .getByRole('button', { name: `Preview generated file ${name}`, exact: true })
      .last()
      .click()
    const dialog = page.getByRole('dialog', { name: `Preview ${name}` })
    const fullscreen = page.getByRole('button', { name: `Open full screen preview of ${name}` })
    await expect(dialog.or(fullscreen)).toBeVisible()
    if (!(await dialog.isVisible())) await fullscreen.click()
  }
  await openFile()
  let preview = page.getByRole('dialog', { name: `Preview ${name}` })
  // Wide previews can open provenance automatically. Finish and close that initial read before
  // injecting faults, so every fault is checked by a fresh real repository request.
  await preview.getByRole('button', { name: `Open Provenance for ${name}` }).click()
  await expect(
    page.getByTestId('artifact-provenance').getByRole('button', { name: 'Generate script' })
  ).toBeEnabled()
  await page
    .getByTestId('artifact-provenance')
    .getByRole('button', { name: 'Close Provenance' })
    .click()
  // Fault injection touches only this disposable version’s execution mirror; restore its bytes below.
  const storage = await page.evaluate(() => window.api.storage.getStatus())
  const client = createProjectDbClient(dirname(storage.dataRoot))
  const firstRow = await client.artifactVersion.findUniqueOrThrow({
    where: { id: first.versionId }
  })
  const executionPath = join(storage.dataRoot, firstRow.executionSnapshotStorageKey!)
  const executionBytes = await readFile(executionPath)
  const contentBlob = firstRow.contentBlobId
    ? await client.contentBlob.findUniqueOrThrow({ where: { id: firstRow.contentBlobId } })
    : undefined
  const contentPath = join(storage.dataRoot, contentBlob?.storageKey ?? firstRow.contentStorageKey)
  const contentBytes = await readFile(contentPath)
  for (const reason of ['missing', 'checksum-mismatch'] as const) {
    try {
      if (reason === 'missing') await rename(contentPath, contentPath + '.held-for-test')
      else await writeFile(contentPath, 'corrupted artifact bytes')
      await preview.getByRole('button', { name: `Open Provenance for ${name}` }).click()
      const panel = page.getByTestId('artifact-provenance')
      await expect(
        panel.locator(`[data-notice-level="${reason === 'missing' ? 'warning' : 'error'}"]`)
      ).toContainText('Artifact content is unavailable for v1')
      await expect(panel).not.toContainText('Record validation failed')
      await expect(panel).not.toContainText('Do not use its records')
      await expect(panel.getByRole('button', { name: 'Generate script' })).toBeDisabled()
      // Real repository validation still accepts this exact version's execution evidence.
      const evidence = await page.evaluate(
        async (request) => ({
          execution: await window.api.artifacts.getVersionExecution(request),
          script: await window.api.artifacts.getCodeReconstruction(request)
        }),
        { projectId, ...first }
      )
      expect(evidence.execution).not.toHaveProperty('failure')
      expect(evidence.execution).toHaveProperty('execution.producerRunId')
      expect(evidence.script).toMatchObject({
        state: 'unavailable',
        reason: 'artifact-content-unavailable'
      })
      await capture('version-v1-content-' + reason)
      await panel.getByRole('button', { name: 'Close Provenance' }).click()
    } finally {
      if (reason === 'missing') await rename(contentPath + '.held-for-test', contentPath)
      else await writeFile(contentPath, contentBytes)
      // Verification quarantines damaged blobs. Reset only this disposable fixture's original
      // availability after restoring its bytes, so the next fault starts independently.
      if (contentBlob)
        await client.contentBlob.update({
          where: { id: contentBlob.id },
          data: { state: contentBlob.state }
        })
    }
  }
  try {
    await writeFile(executionPath, 'invalid execution record')
    await preview.getByRole('button', { name: `Open Provenance for ${name}` }).click()
    const invalid = page.getByTestId('artifact-provenance')
    await expect(invalid.locator('[data-notice-level="error"]')).toContainText(
      'Record validation failed for v1'
    )
    await expect(invalid.getByRole('button', { name: 'Generate script' })).toBeDisabled()
    await capture('version-v1-validation-error')
    await invalid.getByRole('button', { name: 'Close Provenance' }).click()
  } finally {
    await writeFile(executionPath, executionBytes)
    await client.$disconnect()
  }
  await preview.getByRole('button', { name: `Open Provenance for ${name}` }).click()
  let provenance = page.getByTestId('artifact-provenance')
  await expect(provenance.getByRole('button', { name: 'Generate script' })).toBeEnabled()
  await provenance.evaluate((element) => element.setAttribute('data-continuously-open', 'true'))
  await preview.getByRole('button', { name: `Edit ${name}`, exact: true }).click()
  let editor = preview.getByRole('textbox', { name: `Edit ${name} source` })
  await expect(editor).toHaveValue(original)
  await editor.fill(edited)
  await preview.getByRole('button', { name: 'Save changes' }).click()
  await expect(editor).toBeHidden()
  const second = await inspect()
  expect(second.selectedVersion?.versionNumber).toBe(2)
  await expect(provenance.locator('[data-notice-level="info"]')).toContainText(
    'Script reconstruction is not applicable to v2'
  )
  await expect(provenance).toHaveAttribute('data-continuously-open', 'true')
  await preview.getByRole('button', { name: `Close preview of ${name}` }).click()
  const third = await publish(true)
  expect(third.artifactId).toBe(first.artifactId)
  await expect(provenance.locator('[data-notice-level="warning"]')).toContainText(
    'Execution evidence is incomplete for v3'
  )
  await expect(provenance).toHaveAttribute('data-continuously-open', 'true')
  expect(await inspect()).toMatchObject({ headVersionId: third.versionId, text: original })
  expect(await inspect(second.selectedVersionId)).toMatchObject({ text: edited })
  await verifyTaskRead('original', second.selectedVersionId)
  await page.getByRole('button', { name: `Open full screen preview of ${name}` }).click()
  preview = page.getByRole('dialog', { name: `Preview ${name}` })
  await expect(preview.getByText('Original result.', { exact: true })).toBeVisible()
  let warning = provenance.locator('[data-notice-level="warning"]')
  await expect(warning).toContainText('Execution evidence is incomplete for v3')
  await expect(warning).toContainText('Run the producing task again')
  await expect(provenance.getByRole('button', { name: 'Generate script' })).toBeDisabled()
  await capture('version-v3-warning')
  await preview.getByRole('button', { name: 'Previous file version' }).click()
  await expect(preview.getByText('Manually corrected result.', { exact: true })).toBeVisible()
  await expect(provenance.locator('[data-notice-level="info"]')).toContainText(
    'Script reconstruction is not applicable to v2'
  )
  await expect(provenance.getByRole('button', { name: 'Generate script' })).toHaveCount(0)
  await capture('version-v2-not-applicable')
  await preview.getByRole('button', { name: `Edit ${name}`, exact: true }).click()
  await expect(editor).toHaveValue(edited)
  await expect(preview.getByRole('button', { name: 'Save changes' })).toHaveText(
    'Restore as new version'
  )
  await preview.getByRole('button', { name: 'Save changes' }).click()
  await expect(editor).toBeHidden()
  expect(await inspect()).toMatchObject({ text: edited, selectedVersion: { versionNumber: 4 } })
  await expect(provenance.locator('[data-notice-level="info"]')).toContainText(
    'Script reconstruction is not applicable to v4'
  )
  await expect(provenance).toHaveAttribute('data-continuously-open', 'true')
  await capture('restored-v4')
  await preview.getByRole('button', { name: `Close preview of ${name}` }).click()
  await verifyTaskRead('restored', second.selectedVersionId)
  page = await app.restart()
  provenance = page.getByTestId('artifact-provenance')
  warning = provenance.locator('[data-notice-level="warning"]')
  await openRecentSession(page, 'Create a provenance artifact.')
  expect(await inspect()).toMatchObject({ text: edited, selectedVersion: { versionNumber: 4 } })
  await openFile()
  preview = page.getByRole('dialog', { name: `Preview ${name}` })
  await preview.getByRole('button', { name: `Open Provenance for ${name}` }).click()
  await preview.getByRole('button', { name: `Edit ${name}`, exact: true }).click()
  await expect(provenance.locator('[data-notice-level="info"]')).toContainText(
    'Script reconstruction is not applicable to v4'
  )
  editor = preview.getByRole('textbox', { name: `Edit ${name} source` })
  await editor.fill(edited + '\nUnsaved draft.\n')
  // A genuine backend head advance arrives while the renderer owns an unsaved draft.
  await page.evaluate(
    async ({ identity, edited }) => {
      const state = await window.api.managedFileVersions.inspect(identity)
      if (!state.ok) throw new Error('inspect failed')
      const result = await window.api.managedFileVersions.saveTextEdit({
        ...identity,
        basedOnVersionId: state.value.headVersionId,
        expectedHeadVersionId: state.value.headVersionId,
        content: edited + '\nConcurrent edit.\n',
        operationId: crypto.randomUUID()
      })
      if (!result.ok || result.value.kind !== 'created') throw new Error('concurrent save failed')
    },
    { identity, edited }
  )
  await expect(editor).toHaveValue(edited + '\nUnsaved draft.\n')
  await preview.getByRole('button', { name: 'Save changes' }).click()
  await expect(preview.getByText('This file has a newer version.', { exact: true })).toBeVisible()
  await expect(editor).toHaveValue(edited + '\nUnsaved draft.\n')
  await expect(provenance.locator('[data-notice-level="info"]')).toContainText(
    'Script reconstruction is not applicable to v4'
  )
  await provenance.getByRole('button', { name: 'Previous Artifact version' }).click()
  const discard = page.getByTestId('discard-preview-changes-confirmation')
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(editor).toHaveValue(edited + '\nUnsaved draft.\n')
  await expect(provenance.locator('[data-notice-level="info"]')).toContainText(
    'Script reconstruction is not applicable to v4'
  )
  await capture('draft-conflict')
  await preview.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page
    .getByTestId('discard-preview-changes-confirmation')
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click()
  await preview.getByRole('button', { name: 'Previous file version' }).click()
  await preview.getByRole('button', { name: 'Previous file version' }).click()
  await expect(warning).toContainText('Execution evidence is incomplete for v3')
  await page.setViewportSize({ width: 640, height: 850 })
  // The workspace moves into its narrow-screen dialog at this breakpoint.
  await preview.getByRole('button', { name: `Open Provenance for ${name}` }).click()
  await expect(warning).toContainText('Execution evidence is incomplete for v3')
  expect(await warning.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true
  )
  await capture('version-v3-warning-narrow')
})
