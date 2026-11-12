import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import WebSocket from 'ws'
import type { FileDialogHelperRequest, FileDialogResult } from '../src/main/file-dialog-protocol'
import type { SaveDialogOptions } from 'electron'
import type { Locale } from '../src/shared/locale'
let publishUserFile: typeof import('../src/main/user-file-publisher').publishUserFile

const runtimeRequire = createRequire(__filename)
type WindowBounds = { x: number; y: number; width: number; height: number }
type WindowGeometry = {
  content: WindowBounds
  referenceContent: WindowBounds
  viewport: { width: number; height: number }
  reference: { width: number; height: number }
  scaleFactor: number
  zoomFactor: number
}

async function inspectMain<T>(endpoint: string, expression: string): Promise<T> {
  return new Promise((resolveResult, reject) => {
    const socket = new WebSocket(endpoint)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('Main inspector timed out'))
    }, 10000)
    socket.once('open', () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      )
    )
    socket.on('message', (data) => {
      const reply = JSON.parse(data.toString())
      if (reply.id !== 1) return
      clearTimeout(timer)
      socket.close()
      if (reply.error || reply.result?.exceptionDetails) reject(new Error(JSON.stringify(reply)))
      else resolveResult(reply.result.result.value)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      socket.terminate()
      reject(error)
    })
  })
}

// Calibrate against an independent, undecorated HTML page in a native Electron window on the
// same display. This separates OS non-client/DPI conversion from application layout, without
// weakening geometry to an arbitrary +/- pixel threshold.
async function assertCompactGeometry(
  helper: Awaited<ReturnType<typeof launchHelper>>
): Promise<WindowGeometry> {
  await expect.poll(() => helper.page.evaluate(() => innerHeight)).toBeLessThan(400)
  const geometry = await helper.measureWindow(340)
  expect(geometry.zoomFactor).toBe(1)
  expect(geometry.viewport).toEqual(geometry.reference)
  expect([geometry.content.width, geometry.content.height]).toEqual([
    geometry.referenceContent.width,
    geometry.referenceContent.height
  ])
  return geometry
}

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
  kind: 'save' | 'open' = 'save',
  theme: 'light' | 'dark' = 'light',
  options: SaveDialogOptions = {},
  locale: Locale = 'en',
  unavailablePaths: string[] = []
): Promise<{
  page: Page
  result: Promise<FileDialogResult>
  child: ChildProcess
  measureWindow: (height: number) => Promise<WindowGeometry>
  probeWindow: (action?: 'minimum' | 'bottom') => Promise<WindowBounds>
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
    [
      resolve('.'),
      '--open-science-file-dialog-helper',
      '--remote-debugging-port=0',
      '--inspect=0',
      '--lang=en'
    ],
    {
      env,
      windowsHide: false,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    }
  )
  const states: Array<{ phase?: string; visible?: boolean; focused?: boolean }> = []
  let inspectorEndpoint: string | undefined
  child.stderr!.on('data', (data: Buffer) => {
    const match = data.toString().match(/Debugger listening on (ws:\/\/[^\s]+)/)
    if (match) inspectorEndpoint = match[1]
  })
  let browser: Browser | undefined
  const result = new Promise<FileDialogResult>((resolveResult, reject) => {
    let selection: FileDialogResult | undefined
    child.on('message', (raw: unknown) => {
      const message = raw as {
        type?: string
        result?: FileDialogResult
        phase?: string
        visible?: boolean
        focused?: boolean
      }
      if (message.type === 'window-state') states.push(message)
      if (message.type === 'ready') {
        const request: FileDialogHelperRequest = {
          type: 'show',
          presentation: 'html',
          appearance: { theme, followsSystem: false, locale },
          operationId: randomUUID(),
          appVersion: 'e2e',
          crashDumpsPath: join(dirname(root), 'dumps'),
          ...(kind === 'save'
            ? {
                kind: 'save',
                options: {
                  defaultPath: join(root, 'default.txt'),
                  filters: [{ name: 'Text', extensions: ['txt'] }],
                  ...options
                }
              }
            : {
                kind: 'open',
                options: { defaultPath: root, properties: ['openDirectory', 'createDirectory'] }
              })
        }
        if (unavailablePaths.length) {
          void (async () => {
            await expect.poll(() => inspectorEndpoint).toBeTruthy()
            await inspectMain(
              inspectorEndpoint!,
              `(() => {
              const {app} = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
              const original = app.getPath.bind(app);
              app.getPath = kind => { if (${JSON.stringify(unavailablePaths)}.includes(kind)) throw new Error('fixture missing OS folder'); return original(kind); };
            })()`
            )
            child.send(request)
          })().catch(reject)
        } else child.send(request)
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
    await expect(page.locator('h1')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    // DOM visibility alone also passes for a hidden BrowserWindow. Require the OS host acknowledgement.
    await expect
      .poll(() => states)
      .toContainEqual(expect.objectContaining({ visible: true, focused: true }))
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/)
    return {
      page,
      result,
      child,
      measureWindow: async (height) => {
        await expect.poll(() => inspectorEndpoint).toBeTruthy()
        return inspectMain<WindowGeometry>(
          inspectorEndpoint!,
          `(async () => {
          const {BrowserWindow, screen} = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
          const window = BrowserWindow.getAllWindows()[0];
          const bounds = window.getBounds();
          const reference = new BrowserWindow({x:bounds.x,y:bounds.y,width:600,height:${height},minWidth:480,minHeight:340,useContentSize:true,show:false,autoHideMenuBar:true});
          reference.setMenu(null);
          try {
            await reference.loadURL('data:text/html,<html></html>');
            const expression = '({width:innerWidth,height:innerHeight})';
            return { content:window.getContentBounds(), referenceContent:reference.getContentBounds(), viewport:await window.webContents.executeJavaScript(expression), reference:await reference.webContents.executeJavaScript(expression), scaleFactor:screen.getDisplayMatching(bounds).scaleFactor, zoomFactor:window.webContents.getZoomFactor() };
          } finally { reference.destroy(); }
        })()`
        )
      },
      probeWindow: async (action) => {
        await expect.poll(() => inspectorEndpoint).toBeTruthy()
        // Electron omits Chrome's Browser.setWindowBounds CDP domain. Resize the actual native
        // window through its main-process inspector instead of emulating a renderer viewport.
        return new Promise<WindowBounds>((resolveResize, reject) => {
          const socket = new WebSocket(inspectorEndpoint!)
          const timer = setTimeout(() => {
            socket.terminate()
            reject(new Error('Window resize timed out'))
          }, 10_000)
          socket.once('open', () =>
            socket.send(
              JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: {
                  expression: `(() => {
                    const { BrowserWindow, screen } = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
                    const window = BrowserWindow.getAllWindows()[0];
                    if ('${action ?? 'read'}' === 'minimum') window.setSize(480, window.getSize()[1]);
                    if ('${action ?? 'read'}' === 'bottom') {
                      const bounds = window.getBounds();
                      const area = screen.getDisplayMatching(bounds).workArea;
                      window.setPosition(bounds.x, area.y + area.height - bounds.height);
                    }
                    return window.getBounds();
                  })()`,
                  returnByValue: true
                }
              })
            )
          )
          socket.on('message', (data) => {
            const reply = JSON.parse(data.toString())
            if (reply.id !== 1) return
            clearTimeout(timer)
            socket.close()
            if (reply.error || reply.result?.exceptionDetails)
              reject(new Error(JSON.stringify(reply)))
            else resolveResize(reply.result.result.value)
          })
          socket.once('error', (error) => {
            clearTimeout(timer)
            socket.terminate()
            reject(error)
          })
        })
      },
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
    expect(selection).toMatchObject({ canceled: false, filePath: file })
    await publishUserFile(file, (path) => writeFile(path, 'original UTF-8 content'), {
      target: 'target' in selection ? selection.target : undefined
    })
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
    const selected = await second.result
    expect(selected).toMatchObject({ canceled: false, filePath: file })
    await publishUserFile(file, (path) => writeFile(path, 'confirmed replacement'), {
      target: 'target' in selected ? selected.target : undefined
    })
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
    await expect(folder.page.getByRole('textbox', { name: 'Save path' })).toHaveValue(
      join(root, '中文目录')
    )
    await folder.page.getByRole('button', { name: 'New folder' }).click()
    await folder.page.getByRole('textbox', { name: 'Folder name' }).fill('新建-Abc')
    await folder.page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(folder.page.getByRole('textbox', { name: 'Save path' })).toHaveValue(
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
    await invalid.page
      .getByRole('textbox', { name: 'File name', exact: true })
      .fill('../escape.txt')
    await invalid.page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(invalid.page.getByText('Enter a valid file name.')).toBeVisible()
    await invalid.page.screenshot({ path: info.outputPath('04-invalid-filename.png') })
    await invalid.page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await invalid.result).toEqual({ canceled: true, filePath: '' })
  } finally {
    await invalid.close()
  }
})

for (const theme of ['light', 'dark'] as const) {
  test(`repeated ${theme} pickers are visible, focused and themed`, async () => {
    const root = test.info().outputPath('repeated')
    await mkdir(root, { recursive: true })
    for (let index = 0; index < 5; index++) {
      const helper = await launchHelper(root, 'save', theme)
      try {
        if (index === 0) await assertCompactGeometry(helper)
        if (index === 0)
          await helper.page.screenshot({ path: test.info().outputPath(`picker-${theme}.png`) })
        if (index === 0) {
          await helper.page.getByRole('button', { name: 'Browse', exact: true }).click()
          await expect(helper.page.getByRole('region', { name: 'Folders' })).toBeVisible()
          await expect(
            helper.page.getByRole('button', { name: /^(Downloads|Home|Desktop)$/ })
          ).toHaveCount(0)
          await expect.poll(() => helper.page.evaluate(() => innerHeight)).toBeGreaterThan(500)
          await helper.page.screenshot({
            path: test.info().outputPath(`picker-${theme}-expanded.png`)
          })
          await helper.page.getByRole('button', { name: 'Hide folders' }).click()
          await assertCompactGeometry(helper)
        }
        await helper.page.getByRole('button', { name: 'Cancel', exact: true }).click()
        expect(await helper.result).toEqual({ canceled: true, filePath: '' })
      } finally {
        await helper.close()
      }
    }
  })
}

test('compact save navigation updates the destination and keyboard actions preserve composition', async () => {
  const root = test.info().outputPath('compact-navigation')
  const nested = join(root, '中文目录')
  await mkdir(nested, { recursive: true })
  const helper = await launchHelper(root)
  try {
    const name = helper.page.getByRole('textbox', { name: 'File name', exact: true })
    await expect(name).toBeFocused()
    expect(
      await name.evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])
    ).toEqual([0, 7])
    const path = helper.page.getByRole('textbox', { name: 'Save path' })
    await path.fill(nested)
    await path.press('Enter')
    await expect(helper.page.getByRole('region', { name: 'Folders' })).toBeVisible()
    await expect(helper.page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    const parent = helper.page.getByRole('button', { name: 'Parent folder', exact: true })
    await expect(parent).toHaveCount(1)
    await expect(parent).toHaveText('Parent folder')
    await parent.click()
    await expect(path).toHaveValue(root)
    await helper.page.getByRole('button', { name: '中文目录', exact: true }).click()
    await expect(path).toHaveValue(nested)
    await name.fill('analysis.v2.TXT')
    await name.dispatchEvent('keydown', { key: 'Escape', isComposing: true })
    await expect(name).toBeVisible()
    await name.press('Enter').catch((error) => {
      if (!helper.page.isClosed()) throw error
    })
    expect(await helper.result).toMatchObject({
      canceled: false,
      filePath: join(nested, 'analysis.v2.TXT')
    })
  } finally {
    await helper.close()
  }
  const cancel = await launchHelper(root)
  try {
    await cancel.page
      .getByRole('textbox', { name: 'File name', exact: true })
      .press('Escape')
      .catch((error) => {
        if (!cancel.page.isClosed()) throw error
      })
    expect(await cancel.result).toEqual({ canceled: true, filePath: '' })
  } finally {
    await cancel.close()
  }
})

test('actual export types preserve aliases and compound suffixes and require explicit mismatch resolution', async () => {
  const root = test.info().outputPath('file-formats')
  await mkdir(root, { recursive: true })
  const cases = [
    {
      original: 'plan.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      entered: 'plan.pdf',
      message: 'File type: Markdown (.md); suggested name: “plan.pdf.md”.',
      correction: 'plan.pdf.md',
      expected: 'plan.pdf.md'
    },
    {
      original: 'report.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      entered: 'analysis.v2',
      message: 'File type: Markdown (.md); suggested name: “analysis.v2.md”.',
      correction: 'analysis.v2.md',
      expected: 'analysis.v2.md'
    },
    {
      original: 'photo.jpg',
      filters: [{ name: 'JPEG', extensions: ['jpg', 'jpeg'] }],
      entered: '图片.JPEG',
      expected: '图片.JPEG'
    },
    { original: 'archive.tar.gz', filters: [], entered: '数据', expected: '数据.tar.gz' },
    {
      original: 'archive.tar.gz',
      filters: [],
      entered: 'data.tar',
      message: 'File type: Original file (.tar.gz); suggested name: “data.tar.tar.gz”.',
      correction: 'data.tar.gz',
      expected: 'data.tar.gz'
    }
  ]
  for (const [index, scenario] of cases.entries()) {
    const helper = await launchHelper(root, 'save', 'light', {
      defaultPath: join(root, scenario.original),
      filters: scenario.filters
    })
    try {
      await expect(
        helper.page.getByRole('textbox', { name: 'File type', exact: true })
      ).toHaveCount(0)
      await expect(helper.page.getByRole('combobox')).toHaveCount(0)
      const name = helper.page.getByRole('textbox', { name: 'File name', exact: true })
      await name.fill(scenario.entered)
      await name.press('Enter').catch((error) => {
        if (!helper.page.isClosed()) throw error
      })
      if (scenario.correction) {
        await expect(helper.page.getByText(scenario.message!, { exact: true })).toBeVisible()
        await helper.page.screenshot({
          path: test.info().outputPath(`filename-review-${index}.png`)
        })
        await expect(helper.page.getByRole('button', { name: /^Use “/ })).toHaveCount(0)
        await expect(name).toHaveValue(scenario.entered)
        await name.fill(scenario.correction)
        await expect(name).toHaveValue(scenario.correction)
        await helper.page.getByRole('button', { name: 'Save', exact: true }).click()
      }
      const target = join(root, scenario.expected)
      expect(await helper.result).toMatchObject({ canceled: false, filePath: target })
      const bytes = Buffer.from(`unchanged encoded payload ${index}`)
      await publishUserFile(target, (path) => writeFile(path, bytes))
      expect(await readFile(target)).toEqual(bytes)
    } finally {
      await helper.close()
    }
  }
})

for (const locale of ['en', 'de', 'fr', 'ru', 'es', 'zh-Hans', 'zh-Hant', 'ja', 'ko'] as const) {
  test(`localized save layout preserves the standard width: ${locale}`, async () => {
    const info = test.info()
    const catalog: Record<string, Record<string, string>> = locale === 'en'
      ? { renderer: {}, common: {} }
      : JSON.parse(await readFile(resolve(`src/shared/i18n/locales/${locale}.json`), 'utf8'))
    const copy = (key: string): string => catalog.renderer[key] ?? catalog.common[key] ?? key
    const root = info.outputPath(
      'long-path-目录',
      'research-project-with-a-long-directory-name',
      'export-destination'
    )
    const childName = '实际子目录-subfolder'
    await mkdir(join(root, childName), { recursive: true })
    const enteredName = `研究-analysis.${'long-filename-'.repeat(7)}v2`
    const target = join(root, `${enteredName}.txt`)
    await writeFile(target, 'keep existing bytes')
    const measurements: unknown[] = []
    for (const theme of ['light', 'dark'] as const) {
      const helper = await launchHelper(
        root,
        'save',
        theme,
        {
          defaultPath: join(root, 'report.txt'),
          filters: [{ name: 'TXT', extensions: ['txt'] }]
        },
        locale
      )
      try {
        const page = helper.page
        // Observe the real default width; resizing here would hide locale-dependent regressions.
        const baseline = await assertCompactGeometry(helper)
        measurements.push({ locale, theme, state: 'native-calibration', ...baseline })
        const inspect = async (state: string): Promise<void> => {
          const measurement = await page.evaluate(() => {
            const issues: string[] = []
            const visible = (element: HTMLElement): boolean => {
              const r = element.getBoundingClientRect()
              return r.width > 0 && r.height > 0 && !element.closest('[aria-hidden="true"]')
            }
            const controls = [
              ...document.querySelectorAll<HTMLElement>('button, label, input, h1')
            ].filter(visible)
            const boxes = controls.map((element) => ({
              element,
              rect: element.getBoundingClientRect(),
              label: element.textContent?.trim() || element.getAttribute('aria-label') || element.id
            }))
            for (const { element, rect, label } of boxes) {
              if (
                rect.left < -1 ||
                rect.right > innerWidth + 1 ||
                rect.top < -1 ||
                rect.bottom > innerHeight + 1
              )
                issues.push(`outside viewport: ${label}`)
              if (
                element.tagName !== 'INPUT' &&
                (element.scrollWidth > element.clientWidth + 1 ||
                  element.scrollHeight > element.clientHeight + 1)
              )
                issues.push(`clipped control: ${label}`)
            }
            for (let i = 0; i < boxes.length; i++)
              for (let j = i + 1; j < boxes.length; j++) {
                const a = boxes[i],
                  b = boxes[j]
                if (a.element.contains(b.element) || b.element.contains(a.element)) continue
                if (
                  Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left) > 1 &&
                  Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) > 1
                )
                  issues.push(`overlap: ${a.label} / ${b.label}`)
              }
            for (const element of document.querySelectorAll<HTMLElement>(
              '[role="alert"], [role="alertdialog"]'
            )) {
              if (visible(element) && element.scrollWidth > element.clientWidth + 1)
                issues.push('horizontal overflow in message')
            }
            const hint = document.querySelector<HTMLElement>('#save-name-hint')
            if (hint) {
              const rect = hint.getBoundingClientRect()
              const body = document.querySelector('fieldset')!.getBoundingClientRect()
              if (rect.top < body.top || rect.bottom > body.bottom)
                issues.push('filename hint is vertically clipped')
              if (
                getComputedStyle(hint).color ===
                getComputedStyle(document.querySelector('main')!).color
              )
                issues.push('filename hint is not visually muted')
            }
            if (document.documentElement.scrollWidth > innerWidth)
              issues.push('horizontal page overflow')
            return { width: innerWidth, height: innerHeight, issues }
          })
          measurements.push({ locale, theme, state, ...measurement })
          await page.screenshot({ path: info.outputPath(`${locale}-${theme}-${state}.png`) })
          expect(measurement.width, `${locale} ${theme} ${state}`).toBe(baseline.reference.width)
          expect(measurement.issues, `${locale} ${theme} ${state}`).toEqual([])
        }
        const path = page.locator('#save-path')
        const name = page.locator('#save-name')
        await expect(
          page.getByRole('heading', { name: copy('Save file'), exact: true })
        ).toBeVisible()
        await inspect('compact')
        await name.fill(`${enteredName}.txt`)
        await page.getByRole('button', { name: copy('Browse'), exact: true }).click()
        const parent = page.getByRole('button', { name: copy('Parent folder'), exact: true })
        await expect(parent).toHaveCount(1)
        await expect(parent).toHaveText(copy('Parent folder'))
        await expect(page.getByRole('button', { name: childName, exact: true })).toBeVisible()
        await expect.poll(() => page.evaluate(() => innerHeight)).toBeGreaterThan(500)
        const expandedGeometry = await helper.measureWindow(536)
        expect(expandedGeometry.viewport).toEqual(expandedGeometry.reference)
        measurements.push({
          locale,
          theme,
          state: 'expanded-native-calibration',
          ...expandedGeometry
        })
        await inspect('expanded')
        await parent.click()
        await expect(path).toHaveValue(dirname(root))
        await path.fill(root)
        await path.press('Enter')
        await expect(page.getByRole('button', { name: childName, exact: true })).toBeVisible()
        if (locale === 'de' && theme === 'light') {
          await path.fill(parse(root).root)
          await path.press('Enter')
          await expect(page.getByRole('button', { name: copy('Save'), exact: true })).toBeEnabled()
          await expect(parent).toBeDisabled()
          await path.fill(root)
          await path.press('Enter')
          await expect(parent).toBeEnabled()
        }
        await page.getByRole('button', { name: copy('New folder'), exact: true }).click()
        await expect(page.getByRole('textbox', { name: copy('Folder name') })).toBeVisible()
        await inspect('new-folder')
        await page
          .locator('form')
          .getByRole('button', { name: copy('Cancel'), exact: true })
          .click()
        await page.getByRole('button', { name: copy('Hide folders'), exact: true }).click()
        await assertCompactGeometry(helper)
        const collapsedBounds = await helper.probeWindow('bottom')
        const footerBounds = await page.locator('main > footer').boundingBox()
        await name.fill(enteredName)
        await page.getByRole('button', { name: copy('Save'), exact: true }).click()
        const suggestion = copy('File type: {{type}}; suggested name: “{{name}}”.')
          .replace('{{type}}', 'TXT (.txt)')
          .replace('{{name}}', `${enteredName}.txt`)
        const hint = page.getByText(suggestion, { exact: true })
        await expect(hint).toBeVisible()
        await expect(name).toHaveAttribute('aria-describedby', 'save-name-hint')
        await expect(hint).toHaveCSS('font-weight', '400')
        expect(await helper.probeWindow()).toEqual(collapsedBounds)
        expect(await page.locator('main > footer').boundingBox()).toEqual(footerBounds)
        await inspect('suffix-hint')
        await name.fill(`${enteredName}.txt`)
        await expect(hint).toHaveCount(0)
        expect(await helper.probeWindow()).toEqual(collapsedBounds)
        expect(await page.locator('main > footer').boundingBox()).toEqual(footerBounds)
        await page.getByRole('button', { name: copy('Save'), exact: true }).click()
        const confirmation = page.getByRole('alertdialog')
        await expect(confirmation).toBeVisible()
        await expect(
          confirmation.getByRole('heading', { name: copy('Replace existing file?') })
        ).toBeVisible()
        // Wait for the real modal transition before measuring its transformed bounds.
        await expect
          .poll(() =>
            confirmation.evaluate((node) =>
              node.getAnimations().some((animation) => animation.playState === 'running')
            )
          )
          .toBe(false)
        expect(await helper.probeWindow()).toEqual(collapsedBounds)
        await inspect('overwrite')
        await confirmation
          .getByRole('button', { name: copy('Keep existing file'), exact: true })
          .click()
        expect(await readFile(target, 'utf8')).toBe('keep existing bytes')
        await page.getByRole('button', { name: copy('Cancel'), exact: true }).click()
        expect(await helper.result).toEqual({ canceled: true, filePath: '' })
      } finally {
        await helper.close()
        await writeFile(
          info.outputPath('layout-measurements.json'),
          JSON.stringify(measurements, null, 2)
        )
      }
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`destination feedback stays visible and recovers in ${theme}`, async () => {
    const info = test.info()
    const root = info.outputPath('feedback')
    await mkdir(root, { recursive: true })
    const helper = await launchHelper(root, 'save', theme)
    const records: unknown[] = []
    const check = async (state: string): Promise<void> => {
      const box = await helper.page.getByRole('alert').evaluate((node) => {
        const text = node.getBoundingClientRect()
        const body = document.querySelector('fieldset')!.getBoundingClientRect()
        return {
          top: text.top,
          bottom: text.bottom,
          left: text.left,
          right: text.right,
          body: { top: body.top, bottom: body.bottom, left: body.left, right: body.right },
          scrollTop: document.querySelector('fieldset')!.scrollTop
        }
      })
      records.push({ state, ...box })
      expect(box.top).toBeGreaterThanOrEqual(box.body.top)
      expect(box.bottom).toBeLessThanOrEqual(box.body.bottom)
      expect(box.left).toBeGreaterThanOrEqual(box.body.left)
      expect(box.right).toBeLessThanOrEqual(box.body.right)
      expect(box.scrollTop).toBe(0)
      await helper.page.screenshot({ path: info.outputPath(`${theme}-${state}.png`) })
    }
    try {
      const page = helper.page
      const path = page.locator('#save-path')
      const name = page.locator('#save-name')
      await assertCompactGeometry(helper)
      const bounds = await helper.probeWindow()
      const footer = await page.locator('main > footer').boundingBox()
      await path.fill(join(root, 'missing'))
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByRole('alert')).toHaveText(
        'Cannot use this destination. Choose another file or folder.'
      )
      await check('destination')
      expect(await helper.probeWindow()).toEqual(bounds)
      expect(await page.locator('main > footer').boundingBox()).toEqual(footer)
      await path.fill(root)
      await expect(page.getByRole('alert')).toHaveCount(0)
      await path.fill(join(root, 'missing'))
      await path.press('Enter')
      await expect(page.getByRole('alert')).toHaveText(
        'Cannot open this folder. Check the path and permissions.'
      )
      await expect(path).toHaveAttribute('aria-describedby', 'save-path-hint')
      await check('folder')
      await path.fill(root)
      await path.press('Enter')
      await expect(page.getByRole('alert')).toHaveCount(0)
      await page.getByRole('button', { name: 'Hide folders' }).click()
      await assertCompactGeometry(helper)
      await writeFile(join(root, 'existing.txt'), 'before')
      await name.fill('existing.txt')
      const changedBounds = await helper.probeWindow()
      const changedFooter = await page.locator('main > footer').boundingBox()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await writeFile(join(root, 'existing.txt'), 'external change')
      await page.getByRole('button', { name: 'Replace', exact: true }).click()
      await expect(page.getByRole('alert')).toHaveText(
        'The destination changed. Review it and save again.'
      )
      await check('changed')
      expect(await helper.probeWindow()).toEqual(changedBounds)
      expect(await page.locator('main > footer').boundingBox()).toEqual(changedFooter)
      await name.fill('recovered.txt')
      await expect(page.getByRole('alert')).toHaveCount(0)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const selected = await helper.result
      expect(selected).toMatchObject({ canceled: false, filePath: join(root, 'recovered.txt') })
      await publishUserFile(join(root, 'recovered.txt'), (p) => writeFile(p, 'recovered'), {
        target: 'target' in selected ? selected.target : undefined
      })
      expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('external change')
    } finally {
      await helper.close()
      await writeFile(
        info.outputPath('feedback-measurements.json'),
        JSON.stringify(records, null, 2)
      )
    }
  })

  test(`invalid new directory feedback recovers in ${theme}`, async () => {
    const info = test.info()
    const root = info.outputPath('mkdir-feedback')
    await mkdir(root, { recursive: true })
    const helper = await launchHelper(root, 'open', theme)
    try {
      const page = helper.page
      await page.getByRole('button', { name: 'New folder', exact: true }).click()
      const name = page.getByRole('textbox', { name: 'Folder name', exact: true })
      const invalid = process.platform === 'win32' ? 'CON' : '../escape'
      await name.fill(invalid)
      const bounds = await helper.probeWindow()
      const footer = await page.locator('main > footer').boundingBox()
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await expect(name).toHaveValue(invalid)
      await expect(name).toHaveAttribute('aria-invalid', 'true')
      const hint = page.getByRole('alert')
      await expect(hint).toHaveText('Enter a valid folder name.')
      const layout = await hint.evaluate((node) => ({
        bottom: node.getBoundingClientRect().bottom,
        limit: document.querySelector('fieldset')!.getBoundingClientRect().bottom
      }))
      expect(layout.bottom).toBeLessThanOrEqual(layout.limit)
      expect(await helper.probeWindow()).toEqual(bounds)
      expect(await page.locator('main > footer').boundingBox()).toEqual(footer)
      await page.screenshot({ path: info.outputPath(`${theme}-invalid-directory.png`) })
      await name.fill('新建-recovered')
      await expect(hint).toHaveCount(0)
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await expect(page.locator('#save-path')).toHaveValue(join(root, '新建-recovered'))
      await page.getByRole('button', { name: 'Select folder', exact: true }).click()
      expect(await helper.result).toEqual({
        canceled: false,
        filePaths: [join(root, '新建-recovered')]
      })
    } finally {
      await helper.close()
    }
  })
}

test('missing optional OS folders do not prevent a valid destination', async () => {
  const root = test.info().outputPath('optional-folders')
  await mkdir(root, { recursive: true })
  const helper = await launchHelper(root, 'save', 'light', {}, 'en', [
    'desktop',
    'downloads',
    'home'
  ])
  try {
    await expect(helper.page.locator('#save-path')).toHaveValue(root)
    await helper.page.getByRole('button', { name: 'Save', exact: true }).click()
    expect(await helper.result).toMatchObject({
      canceled: false,
      filePath: join(root, 'default.txt')
    })
  } finally {
    await helper.close()
  }
})

test('confirmed targets stay protected through final file publication', async () => {
  const root = test.info().outputPath('publication-races')
  await mkdir(root, { recursive: true })
  for (const scenario of ['modified', 'replaced', 'appeared', 'cancelled'] as const) {
    const destination = join(root, `${scenario}.txt`)
    if (scenario !== 'appeared') await writeFile(destination, 'original')
    const helper = await launchHelper(root, 'save', 'light', { defaultPath: destination })
    try {
      await helper.page.getByRole('button', { name: 'Save', exact: true }).click()
      if (scenario !== 'appeared')
        await helper.page.getByRole('button', { name: 'Replace', exact: true }).click()
      const selected = await helper.result
      if (!('target' in selected) || !selected.target) throw new Error('Missing trusted target')
      const controller = new AbortController()
      await expect(
        publishUserFile(
          destination,
          async (temporary) => {
            await writeFile(temporary, 'export')
            if (scenario === 'modified' || scenario === 'appeared')
              await writeFile(destination, 'other writer')
            if (scenario === 'replaced') {
              await writeFile(destination + '.other', 'other writer')
              await rename(destination + '.other', destination)
            }
            if (scenario === 'cancelled') controller.abort()
          },
          { target: selected.target, signal: controller.signal }
        )
      ).rejects.toThrow()
      expect(await readFile(destination, 'utf8')).toBe(
        scenario === 'cancelled' ? 'original' : 'other writer'
      )
    } finally {
      await helper.close()
    }
  }
})
