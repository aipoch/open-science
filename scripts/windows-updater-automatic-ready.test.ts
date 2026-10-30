import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { readAutomaticUpdateReady } from './windows-updater-certification.mjs'

const operationId = 'd128bd23-4cd0-4203-b3f2-92422fc79042'

describe('automatic updater completion evidence', () => {
  it('requires installer and visible-window/backend ready receipts before probing a successor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'automatic-update-ready-'))
    const directory = join(root, 'Open-Science', 'UpdateHandoffs', operationId)
    const configRoot = join(root, 'config')
    const executable = join(root, 'app', 'open-science.exe')
    const request = {
      operationId,
      parentPid: 100,
      successorPid: 200,
      createdAt: 1000,
      applicationPath: executable,
      targetVersion: '1.1.0',
      profilePath: join(root, 'profile'),
      startupOptions: { configRoot, profilePath: join(root, 'profile') }
    }
    const probeProcess = vi.fn(async () => ({
      pid: 200,
      executablePath: executable,
      startedAt: 1100
    }))
    const fetchImpl = vi.fn(async () =>
      Response.json({ appName: 'Open-Science', appVersion: '1.1.0', platform: 'win32', configRoot })
    )
    const options = {
      appDataRoots: [root],
      parentPid: 100,
      startedAt: 900,
      executable,
      expectedVersion: '1.1.0',
      expectedConfigRoot: configRoot,
      probeProcess,
      fetchImpl
    }
    try {
      await mkdir(directory, { recursive: true })
      await mkdir(configRoot, { recursive: true })
      await writeFile(join(directory, 'request.json'), JSON.stringify(request))
      await writeFile(join(configRoot, 'web-service.json'), JSON.stringify({ port: 12345 }))
      await writeFile(join(configRoot, 'web-token'), 'a'.repeat(32))
      await expect(readAutomaticUpdateReady(options)).resolves.toBeUndefined()
      expect(fetchImpl).not.toHaveBeenCalled()
      await writeFile(join(directory, 'installed.receipt'), `${operationId}\r\ninstalled\r\n`)
      await expect(readAutomaticUpdateReady(options)).resolves.toBeUndefined()
      expect(fetchImpl).not.toHaveBeenCalled()
      await writeFile(join(directory, 'ready.receipt'), `${operationId}\r\nready\r\n`)
      await expect(readAutomaticUpdateReady(options)).resolves.toMatchObject({
        operationId,
        successorPid: 200,
        version: '1.1.0',
        configRoot,
        automatic: true
      })
      expect(probeProcess).toHaveBeenCalledWith(executable, 200)
      expect(fetchImpl).toHaveBeenCalledOnce()
      probeProcess.mockResolvedValueOnce({ pid: 200, executablePath: executable, startedAt: 800 })
      await expect(readAutomaticUpdateReady(options)).rejects.toThrow(/process identity/)
      fetchImpl.mockResolvedValueOnce(
        Response.json({
          appName: 'Open-Science',
          appVersion: '1.0.5',
          platform: 'win32',
          configRoot
        })
      )
      await expect(readAutomaticUpdateReady(options)).rejects.toThrow(
        /Unexpected installed app bootstrap/
      )
      await writeFile(
        join(directory, 'request.json'),
        JSON.stringify({
          ...request,
          startupOptions: { ...request.startupOptions, configRoot: join(root, 'wrong') }
        })
      )
      await expect(readAutomaticUpdateReady(options)).rejects.toThrow(/profile/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
