import { expect } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from './fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './certification/helpers'
import { kernelRecoveryRequest } from './fixtures/kernel-fence.mjs'
import { KernelProcessLifecycleOwner } from '../src/main/notebook/kernel-process-lifecycle.windows-posix'
import { createRootNotebookLane, notebookLaneKey } from '../src/main/notebook/lane-identity'

test.skip(process.platform !== 'win32', 'Windows legacy receipt recovery')

test('Windows Notebook executes in the same lane while legacy cleanup is unconfirmed', async ({
  app
}, testInfo) => {
  test.setTimeout(240_000)
  const python = await realpath(
    execFileSync(
      process.env.OPEN_SCIENCE_TEST_PYTHON ?? 'python',
      ['-I', '-c', 'import sys; print(sys.executable)'],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true }
    ).trim()
  )
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const dataRoot = await app.isolatedDataRoot()
  const runtimeId = await page.evaluate(async (path) => {
    await window.api.runtime.registerInterpreter('python', path)
    const { python } = await window.api.runtime.listEnvironments()
    const runtime = python.find((entry) => entry.interpreterPath === path || entry.envId === path)
    if (!runtime || runtime.provenance === 'app-managed')
      throw new Error('The external Python interpreter was not registered.')
    await window.api.runtime.setEnvironmentEnabled('python', runtime.envId, true)
    await window.api.settings.setDefaultPermissionProfile({ profile: 'auto' })
    return runtime.envId
  }, python)
  const projectId = await createProject(page, 'Windows Notebook recovery')
  const firstPrompt = 'Prepare the session for the Windows Notebook recovery check.'
  await sendPrompt(
    page,
    `${firstPrompt}\n${kernelRecoveryRequest}${JSON.stringify({ runtimeId })}`,
    'Windows Notebook prepared.'
  )
  const sessionId = await page.evaluate(async (projectId) => {
    const { sessions } = await window.api.sessions.loadAll()
    const session = sessions.find((entry) => entry.projectId === projectId)
    if (!session) throw new Error('The project session was not saved.')
    return session.id
  }, projectId)
  // Simulate a cold start with an unsettled receipt, after the fixture has closed the old app.
  await app.close()

  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  await once(child, 'exit')
  const deadPid = child.pid!
  expect(() => process.kill(deadPid, 0)).toThrow()
  const proofFile = '.open-science-process-tree-terminated-repro.proof'
  const proofPath = join(dataRoot, proofFile)
  const proof = {
    path: proofPath,
    requestPath: `${proofPath}.request`,
    token: 'isolated-repro-proof'
  }
  const unconfirmedProof = JSON.stringify({
    version: 1,
    token: proof.token,
    processState: 'termination-unknown'
  })
  await writeFile(proofPath, unconfirmedProof)

  const owner = new KernelProcessLifecycleOwner({ storageRoot: dataRoot })
  const scope = {
    laneKey: notebookLaneKey(
      createRootNotebookLane(projectId, sessionId, `root-frame-${sessionId}`)
    ),
    // A binding to an external interpreter still routes through Python's default process key.
    processKey: 'python:default-python',
    kernelEpochId: 'legacy-repro-epoch'
  }
  const published = owner.recordSpawned(owner.beginSpawn(scope, undefined, proof), { pid: deadPid })
  const ledger = dirname(published.path)
  const legacyPrefix = createHash('sha256')
    .update(`${scope.laneKey}\0${scope.processKey}`)
    .digest('hex')
  const legacyFile = `${legacyPrefix}.active.${deadPid}.${published.receiptId}.json`
  const receipt = { ...published, path: join(ledger, legacyFile) }
  await rename(published.path, receipt.path)

  try {
    page = await app.restart()
    await openRecentSession(page, firstPrompt)
    if (process.env.OPEN_SCIENCE_E2E_FENCE_MANUAL === '1') {
      test.setTimeout(0)
      await app.showMainWindow()
      await page.pause()
      await page.screenshot({ path: testInfo.outputPath('manual-final.png'), fullPage: true })
      return
    }

    const dispatchCell = async (stage: string, code: string): Promise<void> => {
      await sendPrompt(
        page,
        `Run this Python cell.\n${kernelRecoveryRequest}${JSON.stringify({ stage, code })}`,
        `Windows Notebook ${stage}:`,
        90_000
      )
    }
    const firstCode = "import sys\nprint('WINDOWS_RECOVERY_OK', 6 * 7)\nprint(sys.executable)"
    await dispatchCell('degraded', firstCode)
    const firstRuns = await app.readNotebookFixtureRuns(projectId, sessionId)
    expect(firstRuns).toHaveLength(1)
    expect(firstRuns[0]).toMatchObject({ kernelKind: 'python', runtimeId, status: 'completed' })
    const [result, interpreter] = firstRuns[0].text.stdout.trim().split(/\r?\n/u)
    expect(result).toBe('WINDOWS_RECOVERY_OK 42')
    expect(await realpath(interpreter)).toBe(python)
    expect(firstRuns[0].kernelEpochId).toEqual(expect.any(String))
    expect(firstRuns[0].kernelEpochId).not.toBe(scope.kernelEpochId)

    expect(JSON.parse(await readFile(receipt.path, 'utf8')).receiptId).toBe(receipt.receiptId)
    await expect(readFile(proof.path, 'utf8')).resolves.toBe(unconfirmedProof)
    const newReceipts = await Promise.all(
      (await readdir(ledger))
        .filter((name) => name.startsWith(`${legacyPrefix}.`) && name.includes('.active.'))
        .filter((name) => name !== legacyFile)
        .map(async (name) => {
          const { laneKey, processKey, kernelEpochId } = JSON.parse(
            await readFile(join(ledger, name), 'utf8')
          )
          return { laneKey, processKey, kernelEpochId }
        })
    )
    expect(newReceipts).toContainEqual({ ...scope, kernelEpochId: firstRuns[0].kernelEpochId })
    await page.screenshot({ path: testInfo.outputPath('degraded.png'), fullPage: true })

    // Wait for a scan to finish without proof before publishing the result outside the ledger.
    await expect.poll(() => readFile(proof.requestPath, 'utf8').catch(() => '')).toBe(proof.token)
    await expect
      .poll(async () => {
        const path = await app.captureMainLog('windows-kernel-recovery.log')
        const lines = (await readFile(path, 'utf8')).split(/\r?\n/u)
        return lines.some(
          (line) =>
            line.includes('Notebook kernel process recovery deferred') &&
            line.includes(receipt.receiptId) &&
            line.includes('unverified-process')
        )
      })
      .toBe(true)
    await writeFile(
      proof.path,
      JSON.stringify({ version: 1, token: proof.token, processState: 'started-and-reaped' })
    )
    await dispatchCell('continued', "print('WINDOWS_CONTINUED', 40 + 2)")
    const runs = await app.readNotebookFixtureRuns(projectId, sessionId)
    expect(runs).toHaveLength(2)
    const continued = runs.find((run) => run.runId !== firstRuns[0].runId)
    expect(continued).toMatchObject({
      status: 'completed',
      kernelEpochId: firstRuns[0].kernelEpochId,
      text: { stdout: expect.stringContaining('WINDOWS_CONTINUED 42') }
    })
    await expect.poll(async () => (await readdir(ledger)).includes(legacyFile)).toBe(false)
    await expect
      .poll(async () =>
        (await readdir(dataRoot)).filter(
          (name) => name === proofFile || name === `${proofFile}.request`
        )
      )
      .toEqual([])
    await expect(page.locator('body')).not.toContainText(
      /KERNEL_STARTUP_FENCE|DEFAULT_RUNTIME_NOT_READY/u
    )
    await testInfo.attach('notebook-runs', {
      body: JSON.stringify(
        runs.map(({ runId, status, kernelEpochId, text }) => ({
          runId,
          status,
          kernelEpochId,
          text
        })),
        null,
        2
      ),
      contentType: 'application/json'
    })
  } finally {
    // The fixture's only process exited before its synthetic receipt was created.
    owner.complete(receipt, true)
  }
})
