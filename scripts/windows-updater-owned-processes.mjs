/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect } from '@playwright/test'
import { waitFor } from './windows-installer-smoke.mjs'

// Model a previous Notebook host whose numeric PID was reused by an unrelated live process.
// This process runs outside the installation and must survive recovery and the real update.
export const prepareStaleNotebookFixture = async (dataRoot) => {
  const child = spawn(
    process.execPath,
    ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'],
    {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    }
  )
  let receipt
  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    if (receipt)
      await unlink(receipt).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
  }
  try {
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(10_000) })
    if (ready !== 'ready') throw new Error('Unrelated Notebook fixture did not start.')
    const receiptId = randomUUID()
    const directory = join(dataRoot, 'shell-process-ownership')
    await mkdir(directory, { recursive: true })
    const runId = `update-recovery-${randomUUID()}`
    receipt = join(directory, `${runId}.active.${child.pid}.${receiptId}.json`)
    await writeFile(
      receipt,
      JSON.stringify({
        version: 2,
        platform: 'win32',
        runId,
        projectId: 'update-recovery-project',
        sessionId: 'update-recovery-session',
        ownerInstanceId: randomUUID(),
        launchedAt: Date.now() - 60_000,
        receiptId,
        pid: child.pid,
        commandIdentityMarker: receiptId
      }),
      { flag: 'wx' }
    )
    return {
      cleanup,
      assertRecovered: async () => {
        process.kill(child.pid, 0)
        const exists = await stat(receipt).then(
          () => true,
          (error) => {
            if (error.code === 'ENOENT') return false
            throw error
          }
        )
        if (exists) throw new Error('The signed app did not retire the stale Notebook receipt.')
        return {
          unrelatedPid: child.pid,
          unrelatedProcessPreserved: true,
          staleReceiptRemoved: true
        }
      }
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export const prepareOwnedAgentFixture = async ({ installDirectory, configRoot, directory }) => {
  await mkdir(directory, { recursive: true })
  const evidence = join(directory, 'owned-processes.json')
  const executable = join(installDirectory, 'resources', 'node-runtime', 'node.exe')
  const launcher = join(directory, 'opencode.cmd')
  await writeFile(
    launcher,
    `@echo off\r\nif "%~1"=="--version" (echo 1.0.0 & exit /b 0)\r\n"${executable}" "${resolve('scripts/fixtures/windows-update-owned-agent.mjs')}" --owned-evidence "${evidence}" --owned-lock-file "${join(installDirectory, 'resources', 'app.asar')}" %*\r\n`
  )
  const settingsPath = join(configRoot, 'settings.json')
  const settings = JSON.parse(
    await readFile(settingsPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '{}'
      throw error
    })
  )
  Object.assign(settings, {
    opencodePath: launcher,
    opencodeVersion: '1.0.0',
    sessionDetailsModel: { mode: 'disabled' },
    localePreference: 'en'
  })
  await writeFile(settingsPath, JSON.stringify(settings, null, 2))
  return { evidence, executable }
}

export const startOwnedAgentFixture = async (page, fixture) => {
  await page.evaluate(async () => {
    const snapshot = await window.api.settings.upsertProvider({
      type: 'custom',
      name: 'Update ownership fixture',
      apiEndpoints: ['chat-completions'],
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'fixture-model',
      key: 'fixture-not-a-secret',
      supportsImageInput: true
    })
    const provider = snapshot.providers.find((item) => item.name === 'Update ownership fixture')
    if (!provider) throw new Error('Fixture provider was not saved.')
    await window.api.settings.setActiveProvider({ id: provider.id, model: 'fixture-model' })
    await window.api.settings.setAgentFramework({ id: 'opencode' })
  })
  await page.locator('header').getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New project', exact: true })
  await dialog.getByLabel('Name', { exact: true }).fill('Owned process update')
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Verify owned process update.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(
    page.getByText('Deterministic reply: Summarize the deterministic fixture.', { exact: false })
  ).toBeVisible({ timeout: 60_000 })
  const evidence = await waitFor('application-owned Agent and descendant', async () =>
    JSON.parse(await readFile(fixture.evidence, 'utf8'))
  )
  if (evidence.executable.toLowerCase() !== fixture.executable.toLowerCase())
    throw new Error('The Agent did not use the installed Node executable.')
  for (const pid of [evidence.leaderPid, evidence.descendantPid]) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned process identity.')
    process.kill(pid, 0)
  }
  console.log(`Application-owned Agent ready: ${JSON.stringify(evidence)}`)
  return evidence
}

export const assertOwnedAgentReaped = async (evidence) => {
  for (const pid of [evidence.leaderPid, evidence.descendantPid]) {
    await waitFor(
      `owned process ${pid} to exit`,
      () => {
        try {
          process.kill(pid, 0)
          return false
        } catch (error) {
          if (error.code === 'ESRCH') return true
          throw error
        }
      },
      10_000
    )
  }
  return { ...evidence, processTreeReaped: true }
}

export const startUpdateNotebook = async (page, evidencePath) => {
  const protection = await page.evaluate(() => window.api.settings.getNotebookNetworkStatus())
  console.log(`Notebook protection status: ${protection.kind}`)
  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Prepare Notebook for Windows update.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const reply = page.getByText('Notebook update ready:', { exact: false })
  await expect(reply).toContainText(/Notebook update ready: \{"replPid":\d+,"shellPid":\d+\}/, {
    timeout: 480_000
  })
  const evidence = JSON.parse(
    (await reply.innerText()).match(/Notebook update ready: (\{[^\n]+\})/)[1]
  )
  for (const pid of [evidence.replPid, evidence.shellPid]) process.kill(pid, 0)
  await page.screenshot({ path: `${evidencePath}.notebook.png` })
  console.log(`Notebook REPL and Shell running: ${JSON.stringify(evidence)}`)
  return evidence
}

export const assertUpdateNotebookReaped = async (evidence) => {
  await assertOwnedAgentReaped({ leaderPid: evidence.replPid, descendantPid: evidence.shellPid })
  return { ...evidence, processTreeReaped: true }
}
