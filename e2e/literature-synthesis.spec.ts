import { literatureItemInputSchema } from '@aipoch/literature-library/contracts'
import { expect, type TestInfo } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { test, type ElectronApp } from './fixtures/electron-app'
import { openAllReferences } from './fixtures/library'

test('creates, arranges, reopens and exports a cross-paper note with a real PDF source jump', async ({
  app
}, testInfo) => {
  test.setTimeout(240_000)
  let page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await app.setMainWindowSize(1440, 1000)
  const directory = await app.createTestDirectory('synthesis-sources')
  const tagId = await page.evaluate(async () => {
    const snapshot = await window.api.tags.create({
      name: 'evidence-tag',
      iconKey: 'tag',
      colorKey: 'blue'
    })
    const tag = snapshot.tags.find((entry) => 'name' in entry && entry.name === 'evidence-tag')
    if (!tag || !('name' in tag)) throw new Error('Test tag was not created.')
    return tag.id
  })
  for (const index of [1, 2]) {
    const title = `Synthesis source ${index}`
    const record = await page.evaluate(
      (item) => window.api.literature.transact({ kind: 'create-item', item }),
      literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title,
        creators: [
          { nameMode: 'person', givenName: 'Ada', familyName: 'Lovelace', creatorType: 'author' }
        ],
        issuedYear: 2026,
        identifiers: [{ scheme: 'doi', value: `10.1234/synthesis-${index}`, isPrimary: true }]
      })
    )
    expect(record.id).toBeTruthy()
    const pdf = await PDFDocument.create()
    pdf.addPage([400, 600]).drawText(`Evidence from source ${index}`, { x: 30, y: 500, size: 14 })
    const path = join(directory, `source-${index}.pdf`)
    await writeFile(path, await pdf.save())
    if (index === 1) await openAllReferences(page)
    await page.getByText(title, { exact: true }).click()
    await page.locator('input[aria-label="Add files"]').setInputFiles(path)
    await expect(
      page.getByRole('button', { name: `Preview source-${index}.pdf`, exact: true })
    ).toBeEnabled()
    const source = await page.evaluate(async (itemId) => {
      const item = (await window.api.literature.get(itemId))!
      const attachment = item.attachments[0]
      return { attachmentId: attachment.id, version: attachment.versions[0] }
    }, record.id!)
    const annotationId = `synthesis-annotation-${index}`
    await page.evaluate(
      async ({ source, annotationId, index, tagId }) => {
        await window.api.pdfAnnotations.create({
          id: annotationId,
          literatureVersionId: source.version.id,
          kind: index === 1 ? 'highlight' : 'page-note',
          note: `Evidence note ${index}`,
          tagIds: [tagId],
          target: {
            source: {
              kind: 'literature-attachment-version',
              sourceFileId: source.attachmentId,
              versionId: source.version.id,
              checksum: source.version.checksum,
              name: source.version.filename,
              path: `literature-attachment-version:${source.version.id}`
            },
            selector:
              index === 1
                ? {
                    kind: 'text',
                    pageNumber: 1,
                    pageRotation: 0,
                    coordinateVersion: 1,
                    extractorVersion: 'pdfjs-test',
                    exact: 'Evidence from source 1',
                    position: { start: 0, end: 22 },
                    quads: [{ x: 0.075, y: 0.14, width: 0.5, height: 0.035 }]
                  }
                : { kind: 'page-note', pageNumber: 1, pageRotation: 0, coordinateVersion: 1 }
          }
        })
      },
      { source, annotationId, index, tagId }
    )
    await page.keyboard.press('Escape')
  }
  for (const index of [1, 2])
    await page
      .getByRole('checkbox', { name: `Select Synthesis source ${index}`, exact: true })
      .check()
  await page.getByRole('button', { name: 'Create synthesis note', exact: true }).click()
  let workspace = page.getByRole('dialog', { name: 'Choose excerpts.', exact: true })
  await workspace
    .getByRole('textbox', { name: 'Note title', exact: true })
    .fill('Across-paper synthesis')
  const candidateSourceButton = workspace.getByRole('button', {
    name: 'Open source: Synthesis source 1',
    exact: true
  })
  await candidateSourceButton.click()
  const candidatePreview = page.locator('[data-slot="file-preview-dialog"]')
  await expect(candidatePreview).toBeVisible()
  await expect(candidatePreview.locator('.textLayer')).toContainText('Evidence from source')
  await page.screenshot({ path: testInfo.outputPath('synthesis-candidate-source-preview.png') })
  await candidatePreview
    .getByRole('button', { name: 'Close preview of source-1.pdf', exact: true })
    .click()
  await expect(candidateSourceButton).toBeFocused()
  await workspace.getByRole('button', { name: 'Select current results', exact: true }).click()
  await workspace.getByRole('button', { name: /^Create synthesis note/ }).click()
  workspace = page.getByRole('dialog', { name: 'Synthesis notes', exact: true })
  const proseInput = workspace.getByRole('textbox', {
    name: /^(Overall analysis|Excerpt analysis)$/,
    exact: true
  })
  await expect(proseInput).toBeFocused()
  await page.keyboard.insertText('My cross-paper reasoning')
  await expect(proseInput).toHaveValue('My cross-paper reasoning')
  await expect(workspace.getByText('Evidence note 1', { exact: true })).toBeVisible()
  await expect(workspace.getByText('Evidence note 2', { exact: true })).toBeVisible()
  const prose = workspace.getByRole('listitem', { name: 'Block 1 of 3', exact: true })
  await prose.getByRole('button', { name: 'Block actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Move down', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeVisible()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await workspace.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(workspace.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  const sourceButton = workspace.getByRole('button', { name: /Synthesis source 1/ }).first()
  await expect(sourceButton).toContainText('Synthesis source 1')
  await expect(sourceButton).toContainText('Page 1')
  await sourceButton.click()
  const preview = page.locator('[data-slot="file-preview-dialog"]')
  await expect(preview).toBeVisible()
  await expect(preview.locator('.textLayer')).toContainText('Evidence from source')
  await expect(preview.locator('[data-pdf-bookmark-revealed="true"]')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('synthesis-source-preview.png') })
  await preview.getByRole('button', { name: 'Close preview of source-1.pdf', exact: true }).click()
  await expect(sourceButton).toBeFocused()
  await expect(
    workspace.getByRole('textbox', { name: 'Excerpt analysis', exact: true })
  ).toHaveValue('My cross-paper reasoning')
  await workspace.getByRole('button', { name: 'Close', exact: true }).click()
  page = await app.restart()
  await openAllReferences(page)
  await page.getByRole('button', { name: 'Synthesis notes', exact: true }).click()
  workspace = page.getByRole('dialog', { name: 'Synthesis notes', exact: true })
  const notesSearch = workspace.getByRole('searchbox', {
    name: 'Search synthesis notes',
    exact: true
  })
  await notesSearch.fill('Ada Lovelace')
  await expect(
    workspace.getByRole('button', { name: 'Across-paper synthesis', exact: true })
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('synthesis-note-search-author.png') })
  await notesSearch.fill('evidence-tag')
  await expect(
    workspace.getByRole('button', { name: 'Across-paper synthesis', exact: true })
  ).toBeVisible()
  await notesSearch.fill('')
  await workspace.getByRole('button', { name: 'Across-paper synthesis', exact: true }).click()
  await expect(
    workspace.getByRole('listitem', { name: 'Block 3 of 4', exact: true }).getByRole('textbox')
  ).toHaveValue('My cross-paper reasoning')
  const outputPath = testInfo.outputPath('synthesis.md')
  await mkdir(testInfo.outputPath(), { recursive: true })
  const application = (app as unknown as { application: ElectronApplication }).application
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, outputPath)
  await workspace.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('synthesis-export-menu.png') })
  await page.getByRole('menuitem', { name: 'Export Markdown', exact: true }).click()
  await expect
    .poll(async () => readFile(outputPath, 'utf8').catch(() => ''))
    .toContain('My cross\\-paper reasoning')
  const markdown = await readFile(outputPath, 'utf8')
  expect(markdown).toContain('Synthesis source 1')
  expect(markdown).toContain('Synthesis source 2')
  expect(markdown.indexOf('Evidence note 1')).toBeLessThan(
    markdown.indexOf('My cross\\-paper reasoning')
  )
  expect(markdown.indexOf('My cross\\-paper reasoning')).toBeLessThan(
    markdown.indexOf('Evidence note 2')
  )
  expect(markdown).not.toContain(directory)
  await page.screenshot({ path: testInfo.outputPath('synthesis-reopened.png') })
  await testInfo.attach('synthesis-markdown', { path: outputPath, contentType: 'text/markdown' })
})

interface ChineseWorkspace {
  page: Page
  workspace: Locator
  capture(name: string): Promise<void>
}

async function prepareChineseCandidates(
  app: ElectronApp,
  testInfo: TestInfo
): Promise<
  ChineseWorkspace & {
    directory: string
    excerptLines: string[]
    longExcerpt: string
    application: ElectronApplication
  }
> {
  test.setTimeout(180_000)
  const application = (app as unknown as { application: ElectronApplication }).application
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'zh-Hans' }))
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
  await app.setMainWindowSizeAndViewport(1440, 1000)

  const directory = await app.createTestDirectory('synthesis-zh-sources')
  const tagId = await page.evaluate(async () => {
    const snapshot = await window.api.tags.create({
      name: '中文证据标签',
      iconKey: 'tag',
      colorKey: 'blue'
    })
    const tag = snapshot.tags.find((entry) => 'name' in entry && entry.name === '中文证据标签')
    if (!tag || !('name' in tag)) throw new Error('中文测试标签未创建。')
    return tag.id
  })
  const titles = ['中文综合来源一', '中文综合来源二']
  const excerptLines = [
    'Across the observation period, readers returned to the',
    'original passage most often when two papers appeared to',
    'disagree. Reading the sentences around a quotation helped',
    'them distinguish a difference in sampling from a difference',
    'in the reported outcome. The notes that remained useful',
    'during revision preserved both the claim and its limits:',
    'who was studied, how the outcome was measured, and when',
    'the observation was made. These details gave each reader',
    'a way to check an interpretation against its source before',
    'using the excerpt as evidence in a new argument.'
  ]
  const longExcerpt = excerptLines.join(' ')
  for (const [offset, title] of titles.entries()) {
    const index = offset + 1
    const record = await page.evaluate(
      (item) => window.api.literature.transact({ kind: 'create-item', item }),
      literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title,
        creators: [
          { nameMode: 'person', givenName: '李', familyName: '明', creatorType: 'author' }
        ],
        issuedYear: 2026,
        identifiers: [{ scheme: 'doi', value: `10.1234/synthesis-zh-${index}`, isPrimary: true }]
      })
    )
    expect(record.id).toBeTruthy()
    const pdf = await PDFDocument.create()
    const pdfPage = pdf.addPage([400, 600])
    const lines = index === 1 ? excerptLines : ['Evidence from Chinese source 2']
    lines.forEach((line, row) => pdfPage.drawText(line, { x: 30, y: 500 - row * 15, size: 12 }))
    const path = join(directory, `中文来源-${index}.pdf`)
    await writeFile(path, await pdf.save())
    if (index === 1) {
      await page.getByRole('button', { name: '文献库', exact: true }).click()
      await page.getByRole('button', { name: '全部文献', exact: true }).click()
    }
    await page.getByText(title, { exact: true }).click()
    await page.locator('input[aria-label="添加文件"]').setInputFiles(path)
    await expect(
      page.getByRole('button', { name: `预览 中文来源-${index}.pdf`, exact: true })
    ).toBeEnabled()
    const source = await page.evaluate(async (itemId) => {
      const item = (await window.api.literature.get(itemId))!
      const attachment = item.attachments[0]
      return { attachmentId: attachment.id, version: attachment.versions[0] }
    }, record.id!)
    await page.evaluate(
      async ({ source, index, longExcerpt, lineCount, tagId }) => {
        await window.api.pdfAnnotations.create({
          id: `synthesis-zh-annotation-${index}`,
          literatureVersionId: source.version.id,
          kind: index === 1 ? 'highlight' : 'page-note',
          note: `中文证据批注 ${index}`,
          tagIds: [tagId],
          target: {
            source: {
              kind: 'literature-attachment-version',
              sourceFileId: source.attachmentId,
              versionId: source.version.id,
              checksum: source.version.checksum,
              name: source.version.filename,
              path: `literature-attachment-version:${source.version.id}`
            },
            selector:
              index === 1
                ? {
                    kind: 'text',
                    pageNumber: 1,
                    pageRotation: 0,
                    coordinateVersion: 1,
                    extractorVersion: 'pdfjs-test',
                    exact: longExcerpt,
                    position: { start: 0, end: longExcerpt.length },
                    quads: Array.from({ length: lineCount }, (_, row) => ({
                      x: 0.075,
                      y: (90 + row * 15) / 600,
                      width: 0.85,
                      height: 0.022
                    }))
                  }
                : { kind: 'page-note', pageNumber: 1, pageRotation: 0, coordinateVersion: 1 }
          }
        })
      },
      { source, index, longExcerpt, lineCount: lines.length, tagId }
    )
    await page.keyboard.press('Escape')
  }

  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(375, 200)
  })
  for (const title of titles)
    await page.getByRole('checkbox', { name: `选择 ${title}`, exact: true }).check()
  await page.getByRole('button', { name: '创建综合笔记', exact: true }).click()
  const workspace = page.getByRole('dialog', { name: '选择摘录。', exact: true })
  await expect(workspace.getByRole('heading', { name: '选择摘录。', exact: true })).toBeVisible()
  await expect(workspace.locator('[aria-busy="true"]')).toHaveCount(0)
  await workspace.getByRole('button', { name: '选择当前结果', exact: true }).click()
  await expect(workspace.getByRole('status')).toContainText('已选择 2 项')

  const capture = async (name: string): Promise<void> => {
    if (process.env.SYNTHESIS_GALLERY !== '1') return
    const directory = join(process.cwd(), '.scratch', 'synthesis-zh-tight-review')
    await mkdir(directory, { recursive: true })
    const path = join(directory, name + '.png')
    await page.screenshot({ path })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  return { page, application, directory, excerptLines, longExcerpt, workspace, capture }
}

async function createChineseEditor(
  app: ElectronApp,
  testInfo: TestInfo
): Promise<ChineseWorkspace> {
  const { page, workspace: candidates, capture } = await prepareChineseCandidates(app, testInfo)
  await candidates.getByRole('textbox', { name: '笔记标题' }).fill('中文键盘综合笔记')
  await candidates.getByRole('button', { name: /^创建综合笔记/ }).click()
  const workspace = page.getByRole('dialog', { name: '综合笔记', exact: true })
  return { page, workspace, capture }
}

test('zh-Hans selects excerpts at 375px, writes, returns from the PDF and exports Markdown', async ({
  app
}, testInfo) => {
  const {
    page,
    application,
    directory,
    excerptLines,
    longExcerpt,
    workspace: candidates,
    capture
  } = await prepareChineseCandidates(app, testInfo)
  let workspace = candidates
  const candidateSourceButton = workspace.getByRole('button', {
    name: '打开来源: 中文综合来源一',
    exact: true
  })
  await candidateSourceButton.click()
  const candidatePreview = page.locator('[data-slot="file-preview-dialog"]')
  await expect(candidatePreview).toBeVisible()
  await expect(candidatePreview.locator('.textLayer')).toContainText(excerptLines[0])
  await capture('zh-candidate-source-preview')
  await candidatePreview
    .getByRole('button', { name: '关闭 中文来源-1.pdf 的预览', exact: true })
    .click()
  await expect(candidateSourceButton).toBeFocused()

  await capture('zh-desktop-candidates')
  await app.setMainWindowSizeAndViewport(375, 812)
  await expect(workspace.getByRole('heading', { name: '选择摘录。', exact: true })).toBeVisible()
  await expect(workspace.getByRole('button', { name: '关闭', exact: true })).toBeVisible()
  await expect(workspace.locator('[aria-busy="true"]')).toHaveCount(0)
  const titleInput = workspace.getByRole('textbox', { name: '笔记标题', exact: true })
  const confirmCandidates = workspace.getByRole('button', { name: /^创建综合笔记/ })
  await workspace.getByRole('checkbox').last().focus()
  const lastCandidate = workspace.getByRole('checkbox').last()
  await lastCandidate.scrollIntoViewIfNeeded()
  await expect(workspace.getByRole('searchbox', { name: '搜索摘录和批注' })).toBeInViewport()
  await expect(workspace.getByRole('status')).toBeInViewport()
  await lastCandidate.click()
  await expect(workspace.getByRole('status')).toContainText('已选择 1 项')
  await lastCandidate.check()
  await expect(workspace.getByRole('status')).toContainText('已选择 2 项')
  for (let step = 0; step < 4; step++) {
    if (await titleInput.evaluate((element) => element === document.activeElement)) break
    await page.keyboard.press('Tab')
  }
  await expect(titleInput).toBeFocused()
  await page.keyboard.insertText('中文键盘综合笔记')
  await expect(titleInput).toBeFocused()
  await expect(titleInput).toHaveValue('中文键盘综合笔记')
  await expect(confirmCandidates).toBeEnabled()
  const keyboardGeometry = await page.evaluate(
    ({ title, confirm }) => {
      const titleRect = title.getBoundingClientRect()
      const confirmRect = confirm.getBoundingClientRect()
      const overlap = !(
        titleRect.right <= confirmRect.left ||
        confirmRect.right <= titleRect.left ||
        titleRect.bottom <= confirmRect.top ||
        confirmRect.bottom <= titleRect.top
      )
      return {
        title: {
          left: titleRect.left,
          top: titleRect.top,
          right: titleRect.right,
          bottom: titleRect.bottom
        },
        confirm: {
          left: confirmRect.left,
          top: confirmRect.top,
          right: confirmRect.right,
          bottom: confirmRect.bottom
        },
        viewport: { width: innerWidth, height: innerHeight },
        overlap
      }
    },
    { title: await titleInput.elementHandle(), confirm: await confirmCandidates.elementHandle() }
  )
  expect(keyboardGeometry.overlap).toBe(false)
  expect(keyboardGeometry.title.left).toBeGreaterThanOrEqual(0)
  expect(keyboardGeometry.title.right).toBeLessThanOrEqual(keyboardGeometry.viewport.width)
  expect(keyboardGeometry.title.top).toBeGreaterThanOrEqual(0)
  expect(keyboardGeometry.title.bottom).toBeLessThanOrEqual(keyboardGeometry.viewport.height)
  const hitTargets = await page.evaluate(
    ({ title, confirm }) => {
      const center = (element: Element): [number, number] => {
        const rect = element.getBoundingClientRect()
        return [rect.left + rect.width / 2, rect.top + rect.height / 2]
      }
      const [titleX, titleY] = center(title)
      const [confirmX, confirmY] = center(confirm)
      const titleHit = document.elementFromPoint(titleX, titleY)
      const confirmHit = document.elementFromPoint(confirmX, confirmY)
      return {
        titleHit: titleHit === title || title.contains(titleHit),
        confirmHit: confirmHit === confirm || confirm.contains(confirmHit)
      }
    },
    { title: await titleInput.elementHandle(), confirm: await confirmCandidates.elementHandle() }
  )
  expect(hitTargets.titleHit).toBe(true)
  expect(hitTargets.confirmHit).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(titleInput).toBeFocused()
  await expect(titleInput).toHaveValue('中文键盘综合笔记')
  await expect(workspace.getByRole('status')).toContainText('已选择 2 项')
  await capture('zh-narrow-keyboard-title-focus')
  await confirmCandidates.click()
  workspace = page.getByRole('dialog', { name: '综合笔记', exact: true })
  const prose = workspace.getByRole('textbox', { name: /^(整篇分析|摘录分析)$/, exact: true })
  await expect(prose).toHaveAccessibleName('整篇分析')
  await expect(workspace.getByText('整篇分析', { exact: true })).toBeVisible()
  await expect(prose).toBeFocused()
  await page.keyboard.insertText('我的跨文献分析')
  await expect(prose).toBeFocused()
  await expect(prose).toHaveValue('我的跨文献分析')
  await expect(workspace.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveCount(1)
  await expect(workspace.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveValue(
    '中文键盘综合笔记'
  )
  await app.setMainWindowSizeAndViewport(1440, 1000)
  await expect(workspace.getByText('中文证据批注 1', { exact: true })).toBeVisible()
  await expect(workspace.getByText('中文证据批注 2', { exact: true })).toBeVisible()
  await expect(workspace.locator('[aria-busy="true"]')).toHaveCount(0)
  await expect
    .poll(async () => Math.abs((await workspace.boundingBox())!.height - 720))
    .toBeLessThanOrEqual(1)
  await expect(workspace.getByRole('textbox', { name: '笔记标题', exact: true })).toBeInViewport()
  await expect(workspace.getByRole('button', { name: '保存', exact: true })).toBeInViewport()
  await expect(workspace.getByRole('button', { name: '更多操作', exact: true })).toBeInViewport()
  await expect.poll(async () => (await workspace.boundingBox())!.width).toBe(840)
  const quotation = workspace.locator('blockquote').first()
  await expect(quotation).toHaveText(longExcerpt)
  const desktopQuoteHeight = (await quotation.boundingBox())!.height
  const checkAnalysisSizing = async (size: string): Promise<void> => {
    const dimensions = (): Promise<{ lines: number; height: number }> =>
      prose.evaluate((el) => {
        const style = getComputedStyle(el)
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
        return {
          lines: (el.clientHeight - padding) / parseFloat(style.lineHeight),
          height: el.clientHeight
        }
      })
    const short = await dimensions()
    expect(short.lines).toBeCloseTo(4, 1)
    const analysis = [
      '两篇论文都讨论了读者何时回到原文。',
      '这段摘录指出，表面上的分歧可能来自抽样差异。',
      '核对前后文时，需要分别记录三个问题。',
      '第一，研究纳入的是哪些人？',
      '第二，两项研究如何测量结果？',
      '第三，观察发生在什么时间？',
      '比较这些条件之后，再判断两篇论文的结论是否冲突。'
    ].join('\n')
    await prose.fill(analysis)
    expect((await dimensions()).height).toBeGreaterThan(short.height)
    expect(await prose.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
    await capture('zh-' + size + '-expanded-analysis')
    await prose.fill('我的跨文献分析')
    expect((await dimensions()).height).toBe(short.height)
  }
  await checkAnalysisSizing('desktop')
  await capture('zh-desktop-editor')

  await app.setMainWindowSizeAndViewport(375, 812)
  await expect(workspace.getByRole('textbox', { name: '笔记标题', exact: true })).toBeInViewport()
  await expect(workspace.getByRole('button', { name: '保存', exact: true })).toBeInViewport()
  await expect(workspace.getByRole('button', { name: '更多操作', exact: true })).toBeInViewport()
  await expect(workspace.getByRole('button', { name: '关闭', exact: true })).toBeVisible()
  await expect(workspace.locator('[aria-busy="true"]')).toHaveCount(0)
  const narrowLayout = await workspace.evaluate((root) => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
    scrollWidth: root.scrollWidth,
    clientWidth: root.clientWidth,
    left: root.getBoundingClientRect().left,
    right: root.getBoundingClientRect().right
  }))
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(narrowLayout.viewportWidth + 1)
  expect(narrowLayout.scrollWidth).toBeLessThanOrEqual(narrowLayout.clientWidth + 1)
  expect(narrowLayout.left).toBeGreaterThanOrEqual(0)
  expect(narrowLayout.right).toBeLessThanOrEqual(narrowLayout.viewportWidth)
  await expect(prose).toHaveValue('我的跨文献分析')
  expect(narrowLayout.right - narrowLayout.left).toBe(343)
  expect((await quotation.boundingBox())!.height).toBeGreaterThan(desktopQuoteHeight)
  expect(await quotation.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await checkAnalysisSizing('narrow')
  await capture('zh-narrow-editor')
  await workspace.getByText('中文证据批注 2', { exact: true }).scrollIntoViewIfNeeded()
  await expect(workspace.getByText('中文证据批注 2', { exact: true })).toBeInViewport()
  await workspace.getByRole('button', { name: '更多操作', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: '导出 Markdown', exact: true })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: '添加标题', exact: true })).toBeInViewport()
  await capture('zh-narrow-editor-menu')
  await page.keyboard.press('Escape')

  await workspace.getByRole('button', { name: '保存', exact: true }).click()
  await expect(workspace.getByText('已保存', { exact: true })).toBeVisible()
  await app.setMainWindowSizeAndViewport(1440, 1000)
  const sourceButton = workspace.getByRole('button', { name: /中文综合来源一/ }).first()
  await expect(sourceButton).toContainText('中文综合来源一')
  await expect(sourceButton).toContainText('第 1 页')
  await sourceButton.click()
  const preview = page.locator('[data-slot="file-preview-dialog"]')
  await expect(preview).toBeVisible()
  await expect(preview.locator('.textLayer')).toContainText(excerptLines[0])
  const highlights = preview.locator(
    '[data-pdf-bookmark-highlight="synthesis-zh-annotation-1"][data-pdf-bookmark-revealed="true"]'
  )
  await expect(highlights).toHaveCount(excerptLines.length)
  await expect(highlights.last()).toBeVisible()
  await capture('zh-pdf-preview')
  await preview.getByRole('button', { name: '关闭 中文来源-1.pdf 的预览', exact: true }).click()
  await expect(sourceButton).toBeFocused()
  await expect(
    workspace.getByRole('textbox', { name: /^(整篇分析|摘录分析)$/, exact: true })
  ).toHaveValue('我的跨文献分析')
  await capture('zh-editor-after-preview-close-focus')
  const outputPath = testInfo.outputPath('中文综合笔记.md')
  await mkdir(testInfo.outputPath(), { recursive: true })
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, outputPath)
  await workspace.getByRole('button', { name: '更多操作', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: '导出 Markdown', exact: true })).toBeEnabled()
  await capture('zh-desktop-export-menu')
  await page.getByRole('menuitem', { name: '导出 Markdown', exact: true }).click()
  await expect
    .poll(async () => readFile(outputPath, 'utf8').catch(() => ''))
    .toContain('我的跨文献分析')
  const markdown = await readFile(outputPath, 'utf8')
  expect(markdown).toContain('中文键盘综合笔记')
  expect(markdown).toContain('中文综合来源一')
  expect(markdown).toContain('中文综合来源二')
  expect(markdown).not.toContain(directory)
  await testInfo.attach('zh-synthesis-markdown', { path: outputPath, contentType: 'text/markdown' })
})

test('zh-Hans reorders, undoes removal and finds saved notes by author and tag', async ({
  app
}, testInfo) => {
  const { page, workspace, capture } = await createChineseEditor(app, testInfo)
  const prose = workspace.getByRole('textbox', { name: '整篇分析', exact: true })
  const comparison =
    '第一篇提供了研究条件和测量方式，第二篇只有批注，暂时不足以判断两篇研究是否矛盾。'
  await prose.fill(comparison)
  const blocks = workspace.getByRole('listitem')
  const analysisBlock = blocks.filter({
    has: page.getByRole('textbox', { name: '摘录分析', exact: true })
  })
  const blockMenu = analysisBlock.getByRole('button', { name: '区块操作' })
  const moveFromMenu = async (name: string): Promise<void> => {
    await blockMenu.click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
  await blocks.first().getByRole('button', { name: '区块操作' }).click()
  await page.getByRole('menuitem', { name: '下移', exact: true }).click()
  await moveFromMenu('下移')
  await expect(blocks.last().getByRole('textbox')).toHaveValue(comparison)

  const handle = analysisBlock.locator('[data-synthesis-drag-handle]')
  const target = blocks.nth(1)
  await handle.scrollIntoViewIfNeeded()
  const grip = (await handle.boundingBox())!
  const second = (await target.boundingBox())!
  const dropX = second.x + second.width / 2
  const first = (await blocks.first().boundingBox())!
  const gapTop = first.y + first.height
  expect(second.y - gapTop).toBeGreaterThan(0)
  const dropY = (gapTop + second.y) / 2
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(dropX, dropY, { steps: 20 })
  const indicator = target.locator('[data-synthesis-drop-indicator]')
  await expect(indicator).toBeVisible()
  const line = (await indicator.boundingBox())!
  expect(line.y).toBeGreaterThanOrEqual(gapTop)
  expect(line.y + line.height).toBeLessThanOrEqual(second.y)
  await capture('zh-drag-between-excerpts')
  await page.mouse.up()
  const saveAndReopen = async (): Promise<void> => {
    await workspace.getByRole('button', { name: '保存', exact: true }).click()
    await expect(workspace.getByText('已保存', { exact: true })).toBeVisible()
    await workspace.getByRole('button', { name: '返回综合笔记', exact: true }).click()
    await workspace.getByRole('button', { name: '中文键盘综合笔记', exact: true }).click()
    await expect(blocks).toHaveCount(4)
    await expect(blocks.nth(1)).toContainText('中文证据批注 1')
    await expect(blocks.nth(2).getByRole('textbox')).toHaveValue(comparison)
    await expect(blocks.last()).toContainText('中文证据批注 2')
  }
  await expect(blocks.nth(1).getByRole('textbox')).toHaveValue(comparison)
  await saveAndReopen()
  await capture('zh-desktop-reordered')

  await app.setMainWindowSizeAndViewport(375, 812)
  await expect(handle).toBeHidden()
  await moveFromMenu('下移')
  await expect(blocks.last().getByRole('textbox')).toHaveValue(comparison)
  await workspace.getByRole('button', { name: '保存', exact: true }).click()
  await expect(workspace.getByText('已保存', { exact: true })).toBeVisible()
  await blockMenu.click()
  await expect(page.getByRole('menuitem', { name: '上移' })).toBeEnabled()
  await capture('zh-narrow-reorder-menu')
  await page.getByRole('menuitem', { name: '上移', exact: true }).click()
  await saveAndReopen()
  await analysisBlock.scrollIntoViewIfNeeded()
  await capture('zh-narrow-reordered')

  await app.setMainWindowSizeAndViewport(1366, 768)
  const revisedTitle = '研究条件与证据的比较'
  const revisedAnalysis = comparison + '还需要核对随访时间。'
  const headingText = '待核对的研究条件'
  await workspace.getByRole('textbox', { name: '笔记标题' }).fill(revisedTitle)
  await analysisBlock.getByRole('textbox').fill(revisedAnalysis)
  await moveFromMenu('移除')
  const undo = workspace.getByRole('button', { name: '撤销', exact: true })
  await expect(undo).toBeInViewport()
  await expect(blocks).toHaveCount(3)
  await capture('zh-remove-undo')
  await workspace.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '添加标题', exact: true }).click()
  await workspace.getByRole('textbox', { name: '标题', exact: true }).fill(headingText)
  await undo.click()
  const expectRestoredDraft = async (): Promise<void> => {
    await expect(workspace.getByRole('textbox', { name: '笔记标题' })).toHaveValue(revisedTitle)
    await expect(blocks).toHaveCount(5)
    await expect(blocks.nth(1)).toContainText('中文证据批注 1')
    await expect(blocks.nth(2).getByRole('textbox')).toHaveValue(revisedAnalysis)
    await expect(blocks.nth(3)).toContainText('中文证据批注 2')
    await expect(blocks.last().getByRole('textbox')).toHaveValue(headingText)
  }
  await expectRestoredDraft()
  await capture('zh-undo-restored')
  await workspace.getByRole('button', { name: '保存', exact: true }).click()
  await expect(workspace.getByText('已保存', { exact: true })).toBeVisible()
  await workspace.getByRole('button', { name: '返回综合笔记', exact: true }).click()
  const notesSearch = workspace.getByRole('searchbox', { name: '搜索综合笔记', exact: true })
  await notesSearch.fill('李')
  await expect(workspace.getByRole('button', { name: revisedTitle, exact: true })).toBeVisible()
  await expect(workspace.getByText('参考文献', { exact: true }).first()).toBeVisible()
  await expect(workspace.getByText('作者', { exact: true }).first()).toBeVisible()
  await expect(workspace.getByText('标签：中文证据标签', { exact: true }).first()).toBeVisible()
  await capture('zh-note-search-author')
  await notesSearch.fill('中文证据标签')
  await expect(workspace.getByRole('button', { name: revisedTitle, exact: true })).toBeVisible()
  await expect(workspace.getByText('标签：中文证据标签', { exact: true }).first()).toBeVisible()
  await capture('zh-note-search-tag')
  await notesSearch.fill('')
  await workspace.getByRole('button', { name: revisedTitle, exact: true }).click()
  await expectRestoredDraft()
  await capture('zh-undo-reopened')
})

test('zh-Hans appends two independent analyses under the second excerpt on desktop and narrow screens', async ({
  app
}, testInfo) => {
  const { page, workspace, capture } = await createChineseEditor(app, testInfo)
  const revisedTitle = '中文键盘综合笔记'
  const headingText = '待核对的研究条件'
  await workspace.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '添加标题', exact: true }).click()
  await workspace.getByRole('textbox', { name: '标题', exact: true }).fill(headingText)
  const blocks = workspace.getByRole('listitem')
  const notesSearch = workspace.getByRole('searchbox', { name: '搜索综合笔记', exact: true })
  const secondExcerpt = blocks.filter({ hasText: '中文证据批注 2' })
  const desktopAnalysis = '桌面：第二篇的批注仍需要结合研究条件核对。'
  const narrowAnalysis = '窄屏：补充第二篇研究的随访时间与限制。'
  const expectBelowSecondExcerpt = async (texts: string[]): Promise<void> => {
    await expect(secondExcerpt).toHaveCount(1)
    const secondExcerptIndex = await secondExcerpt.evaluate((element) =>
      Array.from(element.parentElement!.children).indexOf(element)
    )
    for (const [offset, text] of texts.entries()) {
      await expect(blocks.nth(secondExcerptIndex + offset + 1).getByRole('textbox')).toHaveValue(
        text
      )
    }
    await expect(blocks.last().getByRole('textbox')).toHaveValue(headingText)
  }
  const saveFindByAuthorAndReopen = async (name: string, texts: string[]): Promise<void> => {
    await workspace.getByRole('button', { name: '保存', exact: true }).click()
    await expect(workspace.getByText('已保存', { exact: true })).toBeVisible()
    await capture(name + '-saved')
    await workspace.getByRole('button', { name: '返回综合笔记', exact: true }).click()
    await expect(notesSearch).toHaveAttribute('placeholder', '搜索标题、作者或标签')
    await notesSearch.fill('李')
    await expect(workspace.getByRole('button', { name: revisedTitle, exact: true })).toBeVisible()
    await expect(workspace.getByText('作者', { exact: true }).first()).toBeVisible()
    await capture(name + '-author-search')
    await workspace.getByRole('button', { name: revisedTitle, exact: true }).click()
    await expectBelowSecondExcerpt(texts)
    await secondExcerpt.scrollIntoViewIfNeeded()
    await capture(name + '-reopened')
  }

  await app.setMainWindowSizeAndViewport(1440, 1000)
  const desktopWriteBelow = secondExcerpt.getByRole('button', {
    name: '在下方写分析',
    exact: true
  })
  await workspace.getByRole('textbox', { name: '笔记标题', exact: true }).focus()
  await page.mouse.move(0, 0)
  await expect(desktopWriteBelow).toBeHidden()
  const secondSource = secondExcerpt.getByRole('button', { name: /中文综合来源二/ })
  await secondSource.focus()
  await expect(desktopWriteBelow).toBeVisible()
  for (let step = 0; step < 4; step++) {
    if (await desktopWriteBelow.evaluate((element) => element === document.activeElement)) break
    await page.keyboard.press('Tab')
  }
  await expect(desktopWriteBelow).toBeFocused()
  await capture('zh-desktop-write-below-entry')
  await desktopWriteBelow.press('Enter')
  const desktopProse = workspace
    .getByRole('textbox', { name: /^(整篇分析|摘录分析)$/, exact: true })
    .last()
  await expect(desktopProse).toHaveAccessibleName('摘录分析')
  await expect(desktopProse).toBeFocused()
  await desktopProse.fill(desktopAnalysis)
  await expectBelowSecondExcerpt([desktopAnalysis])
  await saveFindByAuthorAndReopen('zh-desktop-write-below', [desktopAnalysis])

  await app.setMainWindowSizeAndViewport(375, 812)
  await expect(desktopWriteBelow).toBeHidden()
  await secondExcerpt.getByRole('button', { name: '区块操作', exact: true }).click()
  const narrowWriteBelow = page.getByRole('menuitem', { name: '在下方写分析', exact: true })
  await expect(narrowWriteBelow).toBeInViewport()
  await capture('zh-narrow-write-below-menu')
  await narrowWriteBelow.click()
  const narrowProse = workspace
    .getByRole('textbox', { name: /^(整篇分析|摘录分析)$/, exact: true })
    .last()
  await expect(narrowProse).toHaveAccessibleName('摘录分析')
  await expect(narrowProse).toBeFocused()
  await narrowProse.fill(narrowAnalysis)
  await expectBelowSecondExcerpt([desktopAnalysis, narrowAnalysis])
  await saveFindByAuthorAndReopen('zh-narrow-write-below', [desktopAnalysis, narrowAnalysis])

  await workspace.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '添加段落', exact: true }).click()
  const overallAnalysis = '整篇比较：两篇研究的条件、结论与证据边界需要分别核对。'
  await expect(blocks).toHaveCount(7)
  await expect(blocks.last().getByRole('textbox', { name: '整篇分析', exact: true })).toBeFocused()
  const overallProse = blocks.first().getByRole('textbox', { name: '整篇分析', exact: true })
  await overallProse.fill(overallAnalysis)
  const expectAnalysisLabelsAndContents = async (): Promise<void> => {
    await expect(blocks).toHaveCount(6)
    await expect(blocks.first().getByRole('textbox', { name: '整篇分析' })).toHaveValue(
      overallAnalysis
    )
    await expectBelowSecondExcerpt([desktopAnalysis, narrowAnalysis])
  }
  await workspace.getByRole('button', { name: '保存', exact: true }).click()
  await expect(workspace.getByText('已保存', { exact: true })).toBeVisible()
  await workspace.getByRole('button', { name: '返回综合笔记', exact: true }).click()
  await notesSearch.fill('李')
  await workspace.getByRole('button', { name: revisedTitle, exact: true }).click()
  await expectAnalysisLabelsAndContents()
  await app.setMainWindowSizeAndViewport(1440, 1000)
  await overallProse.scrollIntoViewIfNeeded()
  await expect(overallProse).toBeInViewport()
  await capture('zh-desktop-analysis-labels-reopened')
  await app.setMainWindowSizeAndViewport(375, 812)
  await overallProse.scrollIntoViewIfNeeded()
  await expect(overallProse).toBeInViewport()
  await capture('zh-narrow-analysis-labels-reopened')
})
