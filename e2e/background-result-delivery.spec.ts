import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

// Shell runs in the default regression suite. Set OPEN_SCIENCE_E2E_PYTHON and
// COMPUTE_TEST_SSH_ALIAS to exercise an external interpreter and a real SSH host.
// The agent is deterministic; task execution, harvesting and delivery use production owners.
test.use({ windowMode: 'normal' })

for (const mode of ['shell', 'python', 'ssh'] as const) {
  test(`delivers real ${mode} background output through an automatic application turn`, async ({
    app
  }, testInfo) => {
    test.skip(
      mode === 'ssh' && !process.env.COMPUTE_TEST_SSH_ALIAS,
      'Requires an explicitly configured SSH test host.'
    )
    test.skip(
      mode === 'python' && !process.env.OPEN_SCIENCE_E2E_PYTHON,
      'Requires an explicitly configured Python interpreter.'
    )
    const remoteScratch = `/tmp/open-science-completion-${randomUUID()}`
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    if (mode === 'python') {
      await page.evaluate(async (path) => {
        await window.api.runtime.registerInterpreter('python', path)
        const { python } = await window.api.runtime.listEnvironments()
        const external = python.find(
          (runtime) => runtime.envId === path || runtime.interpreterPath === path
        )
        if (!external) throw new Error(JSON.stringify({ path, python }))
        await window.api.runtime.setEnvironmentEnabled('python', external.envId, true)
      }, process.env.OPEN_SCIENCE_E2E_PYTHON!)
    }
    await page.getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByLabel('Name').fill('Background completion regression')
    await dialog.getByRole('button', { name: 'Create project' }).click()
    if (mode === 'ssh') {
      await page.getByRole('textbox', { name: 'Ask anything' }).fill('Initialize completion test.')
      await page.getByRole('button', { name: 'Send message' }).click()
      await expect
        .poll(async () =>
          page.evaluate(async () =>
            (await window.api.sessions.loadAll()).sessions.some((session) =>
              session.messages.some(
                (message) => message.role === 'agent' && message.status === 'complete'
              )
            )
          )
        )
        .toBe(true)
      await page.evaluate(
        async ({ sshAlias, remoteScratch }) => {
          const host = await window.api.compute.create({ sshAlias, executionMode: 'direct_ssh' })
          await window.api.compute.probe(host.providerId)
          await window.api.compute.scratchSet(host.providerId, remoteScratch)
          const session = (await window.api.sessions.loadAll()).sessions[0]
          await window.api.compute.hostEnabledSet(session.id, host.providerId, true)
          await window.api.compute.hostSelectedSet(session.id, host.providerId, true)
          window.api.compute.onApprovalRequest((request) => {
            void window.api.compute.respondApproval({ id: request.id, decision: 'once' })
          })
        },
        { sshAlias: process.env.COMPUTE_TEST_SSH_ALIAS!, remoteScratch }
      )
    }
    const cleanupScope =
      mode === 'ssh'
        ? await page.evaluate(async () => {
            const session = (await window.api.sessions.loadAll()).sessions[0]
            return { projectId: session.projectId, sessionId: session.id }
          })
        : undefined
    try {
      await page
        .getByRole('textbox', { name: 'Ask anything' })
        .fill(
          mode === 'ssh'
            ? 'Verify SSH background completion delivery.'
            : mode === 'python'
              ? 'Verify Python background completion delivery.'
              : 'Verify background completion delivery.'
        )
      await page.getByRole('button', { name: 'Send message' }).click()
      await expect(page.getByText('Background execution submitted.', { exact: true })).toBeVisible()
      try {
        await expect(
          page.getByText('Background completion received with execution output.', { exact: true })
        ).toBeVisible({ timeout: 60_000 })
      } finally {
        await testInfo.attach('delivery-state', {
          contentType: 'application/json',
          body: JSON.stringify(
            await page.evaluate(async () => {
              const sessions = (await window.api.sessions.loadAll()).sessions
              return Promise.all(
                sessions.map(async (session) => ({
                  session,
                  jobs: await window.api.compute.jobsList({ sessionId: session.id }),
                  background: await window.api.backgroundResultDelivery.getSessionActivity({
                    sessionId: session.id
                  })
                }))
              )
            })
          )
        })
      }
      await page.screenshot({ path: testInfo.outputPath('background-completion.png') })
      const sessions = await page.evaluate(
        async () => (await window.api.sessions.loadAll()).sessions
      )
      const session = sessions.find((candidate) =>
        candidate.messages.some((message) =>
          message.content.includes('Background completion received')
        )
      )
      expect(session?.activeRun).toBeUndefined()
      const deliveryPrompts = session?.messages.filter(
        (message) =>
          message.attribution?.kind === 'application' &&
          message.attribution.purpose === 'agent-result-delivery'
      )
      expect(deliveryPrompts).toHaveLength(1)
      const outcomes = JSON.parse(deliveryPrompts![0].content.split('\n\n').at(-1)!)
      expect(outcomes).toEqual([
        expect.objectContaining({
          sourceKind: mode === 'ssh' ? 'compute-job' : 'local-run',
          terminalStatus: mode === 'ssh' ? 'success' : 'completed',
          resultSummary: expect.stringContaining('stdout:\nbackground-completion-e2e')
        })
      ])
      await testInfo.attach('main-log', {
        path: await app.captureMainLog('background-completion.log'),
        contentType: 'text/plain'
      })
    } finally {
      if (cleanupScope) {
        // The production deletion barrier drains submissions and confirms owned execution has
        // stopped before removing job files, including when delivery assertions fail.
        const cleanup = await page.evaluate(
          (scope) => window.api.sessions.deleteSession(scope),
          cleanupScope
        )
        await testInfo.attach('remote-cleanup', {
          contentType: 'application/json',
          body: JSON.stringify({ remoteScratch, cleanup })
        })
        expect(cleanup.status, `Remote fixture retained at ${remoteScratch}`).toBe('deleted')
        if (cleanup.status === 'deleted') {
          expect(cleanup.cleanupPending, `Remote fixture retained at ${remoteScratch}`).not.toBe(
            true
          )
          // Only remove empty test-owned containers; an ambiguous or incomplete cleanup must
          // preserve remote evidence instead of recursively removing potentially live work.
          await promisify(execFile)(
            'ssh',
            [
              '-o',
              'BatchMode=yes',
              '-o',
              'ConnectTimeout=8',
              process.env.COMPUTE_TEST_SSH_ALIAS!,
              `for directory in '${remoteScratch}/.open-science/jobs' '${remoteScratch}/.open-science' '${remoteScratch}'; do if [ -d "$directory" ]; then rmdir -- "$directory" || exit 1; fi; done`
            ],
            { timeout: 15_000 }
          )
        }
      }
    }
  })
}
