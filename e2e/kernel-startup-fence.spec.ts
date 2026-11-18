import { expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from './fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './certification/helpers'
import { fencePrompt, retryFencePrompt } from './fixtures/kernel-fence.mjs'
import { KernelProcessLifecycleOwner } from '../src/main/notebook/kernel-process-lifecycle.windows-posix'

test('keeps a legacy Windows receipt fenced across sessions until its supervisor confirms exit', async ({
  app
}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Windows legacy receipt recovery')
  test.setTimeout(240_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const dataRoot = await app.isolatedDataRoot()
  const python = process.env.OPEN_SCIENCE_TEST_PYTHON!
  expect(python).toBeTruthy()
  await page.evaluate(async (path) => {
    await window.api.runtime.registerInterpreter('python', path)
    const { python } = await window.api.runtime.listEnvironments()
    const runtime = python.find((entry) => entry.interpreterPath === path || entry.envId === path)
    if (!runtime) throw new Error('Interpreter registration failed')
    await window.api.runtime.setEnvironmentEnabled('python', runtime.envId, true)
  }, python)
  const profile = (await app.captureBrandState()).profile
  const settings = JSON.parse(
    await readFile(join(dirname(profile), 'storage', 'settings.json'), 'utf8')
  )
  expect(settings.notebookManualInterpreters?.python).toContain(python)
  expect(settings.notebookRuntimeEnablement?.python.enabled[python]).toBe(true)
  const firstPrompt = '请创建一个研究报告准备会话，暂时不要运行代码。'
  const projectId = await createProject(page, 'Kernel fence reproduction')
  await sendPrompt(page, firstPrompt, 'Deterministic reply:')
  const session = await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  await once(child, 'exit')
  const deadPid = child.pid!
  expect(() => process.kill(deadPid, 0)).toThrow()
  const proofPath = join(dataRoot, '.open-science-process-tree-terminated-repro.proof')
  const proof = {
    path: proofPath,
    requestPath: `${proofPath}.request`,
    token: 'isolated-repro-proof'
  }
  await writeFile(
    testInfo.outputPath('isolation.json'),
    JSON.stringify(
      {
        dataRoot,
        profile,
        python,
        enabled: true,
        deadPid,
        micromamba: process.env.OPEN_SCIENCE_MICROMAMBA_BIN
      },
      null,
      2
    )
  )
  // Deliberate fault injection: model a legacy pre-Job receipt, never kill a user's process.
  const owner = new KernelProcessLifecycleOwner({ storageRoot: dataRoot })
  const intent = owner.beginSpawn(
    {
      laneKey: JSON.stringify([projectId, session.id, 'root', null, null]),
      processKey: 'python:default-python',
      kernelEpochId: 'legacy-repro-epoch'
    },
    undefined,
    proof
  )
  const receipt = owner.recordSpawned(intent, { pid: deadPid })
  await writeFile(
    proofPath,
    JSON.stringify({ version: 1, token: proof.token, processState: 'termination-unknown' })
  )
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
    await sendPrompt(page, fencePrompt, 'Kernel fence results:', 90_000)
    expect(JSON.parse(await readFile(receipt.path, 'utf8')).receiptId).toBe(receipt.receiptId)
    const raw = await page.evaluate(async (sessionId) => {
      const { sessions } = await window.api.sessions.loadAll()
      return sessions
        .find((entry) => entry.id === sessionId)!
        .messages.filter(
          (entry) => entry.role === 'agent' && entry.content.startsWith('Kernel fence results:')
        )
        .at(-1)!.content
    }, session.id)
    const results = JSON.parse(
      raw.slice(raw.indexOf('Kernel fence results:') + 'Kernel fence results:'.length)
    )
    expect(results.map((entry: { tool: string }) => entry.tool)).toEqual([
      'inspect_packages',
      'inspect_packages',
      'manage_packages',
      'manage_environments'
    ])
    for (const entry of results)
      expect(JSON.stringify(entry.result)).toContain('KERNEL_STARTUP_FENCE')
    await testInfo.attach('blocked-tools', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json'
    })
    await page.screenshot({ path: testInfo.outputPath('blocked.png'), fullPage: true })

    await page.getByRole('button', { name: 'All projects', exact: true }).click()
    await createProject(page, 'Another session cannot bypass fence')
    await sendPrompt(page, retryFencePrompt, 'Kernel fence retry:', 60_000)
    const crossSessionRetry = await page
      .getByText('Kernel fence retry:', { exact: false })
      .last()
      .innerText()
    expect(crossSessionRetry).toContain('KERNEL_STARTUP_FENCE')
    expect(JSON.parse(await readFile(receipt.path, 'utf8')).receiptId).toBe(receipt.receiptId)
    await writeFile(
      proofPath,
      JSON.stringify({ version: 1, token: proof.token, processState: 'started-and-reaped' })
    )
    await page.getByRole('button', { name: 'All projects', exact: true }).click()
    await createProject(page, 'Terminal proof releases the legacy fence')
    await sendPrompt(page, retryFencePrompt, 'Kernel fence retry:', 60_000)
    const retry = await page.getByText('Kernel fence retry:', { exact: false }).last().innerText()
    expect(retry).not.toContain('KERNEL_STARTUP_FENCE')
    // This clean profile has no managed default: advancing to this error proves fence recovery,
    // without installing into the user's registered external interpreter.
    expect(retry).toContain('DEFAULT_RUNTIME_NOT_READY')
    await expect(readFile(receipt.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await page.screenshot({ path: testInfo.outputPath('recovered.png'), fullPage: true })
    await writeFile(testInfo.outputPath('recovered-inspection.txt'), retry)
    await testInfo.attach('recovered-inspection', { body: retry, contentType: 'text/plain' })
    await testInfo.attach('isolation', {
      body: JSON.stringify({ dataRoot, python, enabled: true, deadPid }),
      contentType: 'application/json'
    })
  } finally {
    // The fixture's only process exited before its synthetic receipt was created.
    owner.complete(receipt, true)
  }
})
