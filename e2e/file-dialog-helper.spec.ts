import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import type { FileDialogHelperRequest, FileDialogResult } from '../src/main/file-dialog-protocol'
let publishUserFile: typeof import('../src/main/user-file-publisher').publishUserFile

const runtimeRequire = createRequire(__filename)

test.beforeAll(async () => {
  const info = test.info()
  const outfile = info.outputPath('publisher.mjs')
  await build({
    entryPoints: [resolve('src/main/user-file-publisher.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external'
  })
  publishUserFile = (await import(pathToFileURL(outfile).href)).publishUserFile
})

async function launchHelper(
  root: string,
  kind: 'save' | 'open' = 'save'
): Promise<{
  page: Page
  result: Promise<FileDialogResult>
  child: ChildProcess
  close: () => Promise<void>
}> {
  const profile = join(dirname(root), 'profiles', randomUUID())
  await mkdir(profile, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPEN_SCIENCE_FILE_DIALOG_PROFILE: profile
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(
    runtimeRequire('electron') as string,
    [resolve('.'), '--open-science-file-dialog-helper', '--remote-debugging-port=0', '--lang=en'],
    {
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    }
  )
  let browser: Browser | undefined
  const result = new Promise<FileDialogResult>((resolveResult, reject) => {
    let selection: FileDialogResult | undefined
    child.on('message', (raw: unknown) => {
      const message = raw as { type?: string; result?: FileDialogResult }
      if (message.type === 'ready') {
        const request: FileDialogHelperRequest = {
          type: 'show',
          presentation: 'html',
          operationId: randomUUID(),
          appVersion: 'e2e',
          crashDumpsPath: join(dirname(root), 'dumps'),
          ...(kind === 'save'
            ? {
                kind: 'save',
                options: {
                  defaultPath: join(root, 'default.txt'),
                  filters: [{ name: 'Text', extensions: ['txt'] }]
                }
              }
            : {
                kind: 'open',
                options: { defaultPath: root, properties: ['openDirectory', 'createDirectory'] }
              })
        }
        child.send(request)
      } else if (message.type === 'result') selection = message.result
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 && selection ? resolveResult(selection) : reject(new Error(`Helper exit ${code}`))
    )
  })
  // Early crashes remain observable while the test waits for the Chromium endpoint.
  void result.catch(() => undefined)
  const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Helper debugging endpoint did not start')),
      15_000
    )
    child.stderr!.on('data', (data: Buffer) => {
      const match = data.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) {
        clearTimeout(timer)
        resolveEndpoint(match[1])
      }
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('Helper exited before debugging connected'))
    })
  }).catch((error) => {
    child.kill('SIGKILL')
    throw error
  })
  try {
    browser = await chromium.connectOverCDP(endpoint)
    const context = browser.contexts()[0]
    const page = context.pages()[0] ?? (await context.waitForEvent('page'))
    await expect(
      page.getByRole('heading', { name: kind === 'save' ? 'Save file' : 'Select folder' })
    ).toBeVisible()
    return {
      page,
      result,
      child,
      close: async () => {
        await browser?.close()
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    }
  } catch (error) {
    await browser?.close()
    child.kill('SIGKILL')
    throw error
  }
}

test('HTML destination selection saves Unicode names and requires explicit replacement', async () => {
  const info = test.info()
  const root = info.outputPath('destinations')
  await mkdir(root, { recursive: true })
  const file = join(root, '中文-Abc_123.txt')
  const first = await launchHelper(root)
  try {
    await first.page.getByRole('textbox', { name: 'File name', exact: true }).fill('中文-Abc_123')
    await first.page
      .getByRole('textbox', { name: 'File name', exact: true })
      .dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    await expect(first.page.getByRole('heading', { name: 'Save file' })).toBeVisible()
    await first.page.screenshot({ path: info.outputPath('01-html-save.png') })
    await first.page.getByRole('button', { name: 'Save', exact: true }).click()
    const selection = await first.result
    expect(selection).toEqual({ canceled: false, filePath: file })
    await publishUserFile(file, (path) => writeFile(path, 'original UTF-8 content'))
    expect(await readFile(file, 'utf8')).toBe('original UTF-8 content')
  } finally {
    await first.close()
  }
  const second = await launchHelper(root)
  try {
    const page = second.page
    await page.getByRole('textbox', { name: 'File name', exact: true }).fill('中文-Abc_123.txt')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.screenshot({ path: info.outputPath('02-overwrite-confirmation.png') })
    await page.getByRole('button', { name: 'Keep existing file' }).click()
    expect(await readFile(file, 'utf8')).toBe('original UTF-8 content')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await writeFile(file, 'changed while confirmation was open')
    await page.getByRole('button', { name: 'Replace', exact: true }).click()
    await expect(page.getByText('The destination changed. Review it and save again.')).toBeVisible()
    expect(await readFile(file, 'utf8')).toBe('changed while confirmation was open')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('button', { name: 'Replace', exact: true }).click()
    expect(await second.result).toEqual({ canceled: false, filePath: file })
    await publishUserFile(file, (path) => writeFile(path, 'confirmed replacement'))
    expect(await readFile(file, 'utf8')).toBe('confirmed replacement')
  } finally {
    await second.close()
  }
})

test('a crashed HTML picker fails the selection and a fresh helper remains usable', async () => {
  const root = test.info().outputPath('crash-destination')
  await mkdir(root, { recursive: true })
  const crashed = await launchHelper(root)
  try {
    const failed = expect(crashed.result).rejects.toThrow('Helper exit')
    const cdp = await crashed.page.context().newCDPSession(crashed.page)
    await cdp.send('Page.crash').catch(() => undefined)
    await failed
  } finally {
    await crashed.close()
  }
  const retry = await launchHelper(root)
  try {
    await retry.page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await retry.result).toEqual({ canceled: true, filePath: '' })
  } finally {
    await retry.close()
  }
})

test('HTML folder selection and invalid-name recovery do not open native dialogs', async () => {
  const info = test.info()
  const root = info.outputPath('folders')
  await mkdir(join(root, '中文目录'), { recursive: true })
  const folder = await launchHelper(root, 'open')
  try {
    await folder.page.getByRole('button', { name: '中文目录', exact: true }).click()
    await expect(folder.page.getByRole('textbox', { name: 'Folder path' })).toHaveValue(
      join(root, '中文目录')
    )
    await folder.page.getByRole('button', { name: 'New folder' }).click()
    await folder.page.getByRole('textbox', { name: 'Folder name' }).fill('新建-Abc')
    await folder.page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(folder.page.getByRole('textbox', { name: 'Folder path' })).toHaveValue(
      join(root, '中文目录', '新建-Abc')
    )
    await folder.page.screenshot({ path: info.outputPath('03-html-folder.png') })
    await folder.page.getByRole('button', { name: 'Select folder', exact: true }).click()
    expect(await folder.result).toEqual({
      canceled: false,
      filePaths: [join(root, '中文目录', '新建-Abc')]
    })
  } finally {
    await folder.close()
  }
  const invalid = await launchHelper(root)
  try {
    await invalid.page.getByRole('textbox', { name: 'File name', exact: true }).fill('CON.txt')
    await invalid.page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(invalid.page.getByText('Enter a valid Windows file name.')).toBeVisible()
    await invalid.page.screenshot({ path: info.outputPath('04-invalid-filename.png') })
    await invalid.page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await invalid.result).toEqual({ canceled: true, filePath: '' })
  } finally {
    await invalid.close()
  }
})
