import { processBirthIdentity } from '../src/main/process-birth-identity'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './certification/helpers'
import { KernelProcessLifecycleOwner } from '../src/main/notebook/kernel-process-lifecycle.windows-posix'

const taskRoot = resolve('.dev-isolate/macos-e2e')
const forbidden = /KERNEL_STARTUP_FENCE|DEFAULT_RUNTIME_NOT_READY/u
const micromamba = process.env.OPEN_SCIENCE_MICROMAMBA_BIN!
const py = process.env.OPEN_SCIENCE_TEST_PYTHON!

test.skip(
  process.platform !== 'darwin' ||
    !micromamba ||
    !py ||
    !existsSync(join(taskRoot, 'default-python.lock')),
  'Requires the prepared macOS diagnostic acceptance environment and explicit interpreter paths.'
)

test.use({ windowMode: 'normal' })
for (const scenario of ['normal', 'stale-live', 'orphan-group'] as const) {
  test(`macOS configured Python user workflow ${scenario}`, async ({ app }, testInfo) => {
    test.setTimeout(300_000)
    const evidence: Record<string, unknown> = {
      scenario,
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    }
    evidence.recoverySourceSha256 = createHash('sha256')
      .update(await readFile('src/main/notebook/kernel-process-recovery.darwin.ts'))
      .digest('hex')
    const faultLease = testInfo.outputPath('fault-process.lease')
    let faultPid: number | undefined
    let faultChildPid: number | undefined
    let dataRoot = ''
    let page = await app.completeOnboarding()
    try {
      page = await app.configureFakeAgent()
      dataRoot = await app.isolatedDataRoot()
      const runtimeRoot = join(dataRoot, 'runtime')
      const temporary = join(runtimeRoot, 'tmp')
      const prefix = join(runtimeRoot, 'envs/default-python')
      await mkdir(temporary, { recursive: true })
      // Reconstruct the real installed default from read-only export and task-owned cache.
      execFileSync('/bin/cp', ['-cR', join(taskRoot, 'seed-pkgs'), join(runtimeRoot, 'pkgs')])
      const env = {
        ...process.env,
        MAMBA_ROOT_PREFIX: runtimeRoot,
        CONDA_PKGS_DIRS: join(runtimeRoot, 'pkgs'),
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary
      }
      execFileSync(
        micromamba,
        [
          '--no-rc',
          'create',
          '--yes',
          '--offline',
          '--copy',
          '--prefix',
          prefix,
          '--file',
          join(taskRoot, 'default-python.lock')
        ],
        { env, timeout: 120_000, stdio: 'pipe' }
      )
      const python = join(prefix, 'bin/python')
      const version = execFileSync(
        python,
        [
          '-B',
          '-c',
          'import sys,numpy; print(sys.executable);print(sys.version);print(numpy.__version__)'
        ],
        { env, encoding: 'utf8' }
      )
      await copyFile(join(taskRoot, 'default-env-ready.json'), join(runtimeRoot, '.env-ready'))
      const runtime = await page.evaluate(async (python) => {
        await window.api.runtime.registerInterpreter('python', python)
        const environments = (await window.api.runtime.listEnvironments()).python
        const managed = environments.find((r) => r.provenance === 'app-managed' && r.runnable)!
        await window.api.runtime.setEnvironmentEnabled('python', managed.envId, true)
        await window.api.settings.setDefaultPermissionProfile({ profile: 'auto' })
        return (await window.api.runtime.listEnvironments()).python
      }, python)
      expect(runtime).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            condaEnv: 'default-python',
            provenance: 'app-managed',
            runnable: true
          })
        ])
      )
      evidence.isolation = {
        dataRoot,
        python,
        version,
        runtime,
        micromamba,
        micromambaVersion: execFileSync(micromamba, ['--version'], { encoding: 'utf8' }).trim()
      }
      await page.reload({ waitUntil: 'domcontentloaded' })
      const projectId = await createProject(page, `macOS ${scenario}`)
      const initialPrompt = `Prepare report comparison for macOS ${scenario}; wait for my source files.`
      await sendPrompt(page, initialPrompt, 'Deterministic reply:', 30000)
      const session = await page.evaluate(
        async (id) =>
          (await window.api.sessions.loadAll()).sessions.find((s) => s.projectId === id)!,
        projectId
      )
      expect(session.cwd).toBeTruthy()
      const sourcePath = join(session.cwd, 'research-notes.md')
      const oldPath = join(session.cwd, 'research-notes-v1.md')
      await writeFile(oldPath, '# Research\n\nFirst version.\n', 'utf8')
      const inputText =
        '# Research\n\nFirst version. Revised 中文结果.\n\n## Results\n\nPython should produce results.\n'
      await writeFile(sourcePath, inputText, 'utf8')
      evidence.sourceAccess = await page.evaluate(
        (path) => window.api.localFs.grantRoot({ path, access: 'ro' }),
        session.cwd
      )
      evidence.session = { projectId, sessionId: session.id, cwd: session.cwd }
      const request = async (stage: string, code: string, publish = false): Promise<void> => {
        await sendPrompt(
          page,
          `请使用 Python 比较本地 Markdown 并保存结果。\nMACOS_ACCEPTANCE_REQUEST:${JSON.stringify({ stage, code, publish })}`,
          `MACOS_ACCEPTANCE_OK ${stage}`,
          150_000
        )
        const raw = await page
          .getByText(`MACOS_ACCEPTANCE_OK ${stage}`, { exact: false })
          .last()
          .innerText()
        expect(raw).not.toMatch(forbidden)
        evidence[stage] = raw
      }
      const firstCode = [
        'from pathlib import Path',
        'import json, os, sys',
        `text = Path(${JSON.stringify(sourcePath)}).read_text(encoding='utf-8')`,
        `old = Path(${JSON.stringify(oldPath)}).read_text(encoding='utf-8')`,
        `result = {'marker':'DIAGNOSTIC_PYTHON_OK','headings':sum(s.startswith('#') for s in text.splitlines()),'characters':len(text),'changed':text != old,'delta':len(text)-len(old)}`,
        `Path('research-result.json').write_text(json.dumps(result,ensure_ascii=False,sort_keys=True),encoding='utf-8')`,
        `print(json.dumps(result,sort_keys=True)); print('KERNEL_PID',os.getpid()); print('PYTHON',sys.executable)`
      ].join('\n')
      await request('first', firstCode)
      const firstRuns = await app.readNotebookFixtureRuns(projectId, session.id)
      expect(firstRuns.filter((r) => r.kernelKind === 'python').map((r) => r.status)).toEqual([
        'completed'
      ])
      const first = firstRuns.find((r) => r.kernelKind === 'python')!
      expect(first.text.stdout).toContain('"headings": 2')
      expect(first.text.stdout).toContain(`"characters": ${inputText.length}`)
      evidence.firstRuns = firstRuns
      if (scenario !== 'normal') {
        // Isolated fault injection: a previous-session receipt and real owned POSIX process group.
        const owner = new KernelProcessLifecycleOwner({
          storageRoot: dataRoot,
          ownerInstanceId: 'acceptance-previous-host'
        })
        const token = owner.createOwnerToken()
        const intent = owner.beginSpawn(
          {
            laneKey: JSON.stringify([projectId, 'previous-session', 'root', null, null]),
            processKey: 'python:default-python',
            kernelEpochId: 'acceptance-fault'
          },
          token
        )
        // Teardown releases only our fixture processes, even if their PIDs have been reused.
        await writeFile(faultLease, '')
        const waitForCleanup = [
          'import os,time',
          'deadline=time.monotonic()+180',
          'while os.path.exists(' +
            JSON.stringify(faultLease) +
            ') and time.monotonic()<deadline: time.sleep(0.1)'
        ].join('\n')
        const code =
          scenario === 'orphan-group'
            ? 'import subprocess,sys\np=subprocess.Popen([sys.executable,"-u","-c",' +
              JSON.stringify(waitForCleanup) +
              '])\nprint(p.pid,flush=True)\n' +
              waitForCleanup
            : waitForCleanup
        const child = spawn(py, ['-u', '-c', code], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...owner.environment(token) }
        })
        await once(child, 'spawn')
        faultPid = child.pid!
        if (scenario === 'orphan-group') {
          const [buf] = await once(child.stdout!, 'data')
          faultChildPid = Number(String(buf).trim())
          expect(faultChildPid).toBeGreaterThan(0)
        }
        const receipt = owner.recordSpawned(intent, {
          pid: faultPid,
          posixBirthToken: processBirthIdentity(faultPid)
        })
        if (scenario === 'orphan-group') {
          const exited = once(child, 'exit')
          child.kill('SIGKILL')
          await exited
          expect(() => process.kill(faultPid!, 0)).toThrow()
          process.kill(faultChildPid!, 0)
        }
        evidence.fault = {
          faultPid,
          faultChildPid,
          receipt: JSON.parse(await readFile(receipt.path, 'utf8'))
        }
        page = await app.restart()
        const exited = (pid: number): boolean => {
          try {
            process.kill(pid, 0)
            return false
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH'
          }
        }
        await expect.poll(() => exited(faultPid!), { timeout: 10000 }).toBe(true)
        if (faultChildPid)
          await expect.poll(() => exited(faultChildPid!), { timeout: 10000 }).toBe(true)
        await expect
          .poll(
            async () => {
              try {
                await readFile(receipt.path, 'utf8')
                return false
              } catch (error) {
                return (error as NodeJS.ErrnoException).code === 'ENOENT'
              }
            },
            { timeout: 10000 }
          )
          .toBe(true)
        evidence.recovery = {
          leaderExited: true,
          childExited: faultChildPid ? true : undefined,
          receiptRemoved: true
        }
        await openRecentSession(page, initialPrompt)
        const banner = page.getByTestId('env-status-banner')
        if (await banner.isVisible()) {
          const details = banner.locator('summary')
          if (await details.count()) await details.click()
          evidence.recoveryNotice = await banner.innerText()
          await page.screenshot({
            path: testInfo.outputPath('recovery-notice.png'),
            fullPage: true
          })
          await page.getByTestId('env-status-banner-dismiss').click()
        }
      }
      const secondCode = [
        'from pathlib import Path',
        'import json',
        `result=json.loads(Path('research-result.json').read_text(encoding='utf-8'))`,
        `summary='# Diagnostic report\\n\\nDIAGNOSTIC_SUMMARY_OK\\n\\n'+json.dumps(result,ensure_ascii=False,sort_keys=True)`,
        `Path('research-summary.md').write_text(summary,encoding='utf-8')`,
        `print(summary)`
      ].join('\n')
      await request('continued', secondCode, true)
      const runs = await app.readNotebookFixtureRuns(projectId, session.id)
      evidence.runs = runs
      const pythonRuns = runs.filter((r) => r.kernelKind === 'python')
      expect(pythonRuns).toHaveLength(2)
      expect(pythonRuns.every((r) => r.status === 'completed')).toBe(true)
      expect(JSON.stringify(runs)).not.toMatch(forbidden)
      if (scenario === 'normal')
        expect(pythonRuns[1].kernelEpochId).toBe(pythonRuns[0].kernelEpochId)
      const summaryFile = pythonRuns[1].workingFiles.find((f) =>
        f.path.endsWith('research-summary.md')
      )
      expect(summaryFile).toBeTruthy()
      const summary = await readFile(summaryFile!.path, 'utf8')
      expect(summary).toContain('DIAGNOSTIC_SUMMARY_OK')
      await writeFile(testInfo.outputPath('research-summary.md'), summary)
      await page.screenshot({ path: testInfo.outputPath('published-result.png'), fullPage: true })
      page = await app.restart()
      await openRecentSession(page, initialPrompt)
      await request(
        'after-restart',
        "from pathlib import Path\nprint('RESTART_RESULT_OK', Path('research-summary.md').read_text(encoding='utf-8'))"
      )
      await page.getByRole('button', { name: 'All projects', exact: true }).click()
      await createProject(page, `New session ${scenario}`)
      await request('new-session', "print('NEW_SESSION_PYTHON_OK', sum([20,22]))")
      await expect(page.locator('body')).not.toContainText(forbidden)
      evidence.outcome = 'passed'
    } catch (error) {
      evidence.outcome = 'failed'
      evidence.error = String(error)
      throw error
    } finally {
      await rm(faultLease, { force: true })
      if (dataRoot) {
        evidence.finalSessions = await page
          .evaluate(async () => (await window.api.sessions.loadAll()).sessions)
          .catch(() => [])
        const log = await app.captureMainLog('macos-' + scenario + '.log').catch(() => undefined)
        if (log) {
          await copyFile(log, testInfo.outputPath('main.log'))
          evidence.logCodes =
            (await readFile(log, 'utf8')).match(new RegExp(forbidden.source, 'g')) ?? []
        }
        await page
          .screenshot({ path: testInfo.outputPath('final.png'), fullPage: true })
          .catch(() => undefined)
      }
      await writeFile(testInfo.outputPath('evidence.json'), JSON.stringify(evidence, null, 2))
      if (faultChildPid)
        await expect
          .poll(
            () => {
              try {
                process.kill(faultChildPid!, 0)
                return false
              } catch {
                return true
              }
            },
            { timeout: 10000 }
          )
          .toBe(true)
      if (evidence.outcome === 'passed') expect(evidence.logCodes).toEqual([])
    }
  })
}
