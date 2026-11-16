import { test, expect } from '@playwright/test'

test.use({ timezoneId: 'UTC' })

test('edits a task from its message and creates a script from the project sidebar', async ({
  page
}) => {
  await page.setViewportSize({ width: 1000, height: 540 })
  await page.goto('/session-schedules.html')
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await expect(dialog.getByText('History', { exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Pause' })).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Training check')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Training check', { exact: true })).toBeVisible()
  await page.locator('aside').getByRole('button', { name: 'Schedule', exact: true }).click()
  await page.getByRole('button', { name: 'New task' }).click()
  await dialog.getByText('Advanced', { exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeInViewport()
  await dialog.getByRole('combobox', { name: 'Action', exact: true }).click()
  await page.getByRole('option', { name: 'Run a script', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Script', exact: true }).fill('print(42)')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('aside').getByText('Scheduled script', { exact: true })).toBeVisible()
})

test('explains why a script cannot be selected without a conversation', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?zh&no-session')
  await page.locator('aside').getByRole('button', { name: '定时任务', exact: true }).click()
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText('高级选项', { exact: true }).click()
  await dialog.getByRole('combobox', { name: '操作', exact: true }).click()
  const script = page.getByRole('option', { name: '运行脚本', exact: true })
  await expect(script).toHaveAttribute('aria-disabled', 'true')
  await script.hover()
  await expect(page.getByRole('tooltip')).toHaveText('运行脚本需要选择已有会话。')
  await page.screenshot({ path: testInfo.outputPath('schedule-disabled-script-tooltip.png') })
})

test('explains locked fields and unavailable task actions', async ({ page }, testInfo) => {
  await page.goto('/session-schedules.html')
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const save = dialog.getByRole('button', { name: 'Save', exact: true })
  await expect(save).toBeDisabled()
  await dialog.getByLabel('No changes to save.', { exact: true }).focus()
  await expect(page.getByRole('tooltip')).toHaveText('No changes to save.')
  await page.keyboard.press('Escape')
  await expect(dialog.getByRole('combobox', { name: 'Conversation' })).toHaveCount(0)
  await expect(dialog.getByRole('combobox', { name: 'Action' })).toHaveCount(0)
  await expect(dialog.getByText('Send a message', { exact: true })).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Updated task')
  await expect(save).toBeEnabled()
  await expect(dialog.getByRole('button', { name: 'Pause' })).toBeDisabled()
  await dialog
    .getByLabel('Save your changes before changing the task status.', { exact: true })
    .hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    'Save your changes before changing the task status.'
  )
  await page.screenshot({ path: testInfo.outputPath('schedule-disabled-actions.png') })
  await save.click()
})

test('opens the bound branch and latest Notebook result after a skipped script run', async ({
  page
}) => {
  await page.goto('/session-schedules.html?script')
  await expect(page.getByRole('main')).toHaveAttribute('data-branch', 'revised')
  await page.locator('aside').getByRole('button', { name: 'Schedule', exact: true }).click()
  await page
    .locator('aside')
    .getByRole('button', { name: /Training script/ })
    .click()
  await expect(page.getByRole('main')).toHaveAttribute('data-notebook-run', 'previous-run')
  const outcome = page
    .getByRole('region', { name: 'Schedule', exact: true })
    .getByText('Skipped', { exact: true })
  await expect(outcome).toHaveText('Skipped')
  await expect(page.getByRole('main')).toHaveAttribute('data-branch', 'revised')
  await page
    .locator('aside')
    .getByRole('button', { name: /Check training progress/ })
    .click()
  await expect(page.getByRole('main')).toHaveAttribute('data-branch', 'message-branch-training')
})

test('combines task name search and status filters in the schedule sidebar', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 940, height: 600 })
  await page.goto('/session-schedules.html?zh')
  await page.locator('aside').getByRole('button', { name: '定时任务', exact: true }).click()
  await page.evaluate(async () => {
    const api = window.api.schedules
    const [summary] = await api.list({ projectId: 'research' })
    const source = (await api.get({
      projectId: 'research',
      sessionId: summary.target.sessionId,
      scheduleId: summary.id
    }))!
    for (const [name, kind] of [
      ['汇总训练结果', 'pause'],
      ['归档论文', 'close']
    ] as const) {
      const task = await api.create({
        target: source.target,
        draft: { ...source.draft, name },
        requestId: crypto.randomUUID()
      })
      await api.edit({
        projectId: 'research',
        sessionId: task.target.sessionId,
        scheduleId: task.id,
        expectedRevision: task.revision,
        change: { kind }
      })
    }
  })
  const sidebar = page.getByRole('region', { name: '定时任务' })
  const searchToggle = sidebar.getByRole('button', { name: '搜索定时任务' })
  await searchToggle.click()
  const search = sidebar.getByRole('searchbox')
  await expect(search).toBeFocused()
  await search.fill('训练')
  await expect(sidebar.getByRole('button', { name: /汇总训练结果/ })).toBeVisible()
  const filter = sidebar.getByRole('button', { name: '按状态筛选' })
  await filter.click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(3)
  await expect(menu.getByRole('menuitemcheckbox', { checked: true })).toHaveCount(3)
  await page.screenshot({ path: testInfo.outputPath('schedule-filter-menu.png') })
  await menu.getByRole('menuitemcheckbox').first().click()
  await expect(menu.getByRole('menuitemcheckbox', { checked: true })).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(sidebar.getByRole('button', { name: /检查训练进度/ })).toHaveCount(0)
  await expect(sidebar.getByRole('button', { name: /归档论文/ })).toHaveCount(0)
  await expect(sidebar.getByRole('button', { name: /汇总训练结果/ })).toBeVisible()
  await search.fill('未命中')
  await expect(sidebar.getByRole('status')).toHaveText('未找到结果')
  await page.screenshot({ path: testInfo.outputPath('schedule-filter-empty.png') })
  await sidebar.getByRole('button', { name: '清除筛选' }).click()
  await expect(sidebar.getByRole('button', { name: /检查训练进度/ })).toBeVisible()
  await search.press('Escape')
  await expect(searchToggle).toBeFocused()
  await expect(search).toHaveCount(0)
})

test('pauses and resumes from the task menu and creates another task from an example', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 720 })
  await page.goto('/session-schedules.html?zh')
  await page.locator('aside').getByRole('button', { name: '定时任务', exact: true }).click()
  const sidebar = page.getByRole('region', { name: '定时任务' })
  const menu = page.getByRole('menu')
  const actions = sidebar.getByRole('button', { name: '更多操作' })
  const row = sidebar.getByRole('button', { name: /检查训练进度/ })
  await row.click({ button: 'right' })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const contextActions = await menu.getByRole('menuitem').allTextContents()
  await page.screenshot({ path: testInfo.outputPath('schedule-context-menu.png') })
  await page.keyboard.press('Escape')
  await expect(row).toBeFocused()
  await actions.click()
  expect(await menu.getByRole('menuitem').allTextContents()).toEqual(contextActions)
  await expect(menu.getByRole('menuitem').first()).toHaveText('暂停')
  await page.screenshot({ path: testInfo.outputPath('schedule-task-actions.png') })
  await menu.getByRole('menuitem', { name: '暂停', exact: true }).click()
  const paused = sidebar
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: '已暂停' }) })
  await expect(paused).toHaveAttribute('open', '')
  await paused.getByRole('button', { name: '更多操作' }).click()
  await menu.getByRole('menuitem', { name: '继续', exact: true }).click()
  await expect(sidebar.getByRole('button', { name: /检查训练进度/ })).toBeVisible()
  await expect(paused).toHaveCount(0)
  await sidebar.getByRole('button', { name: '新建任务' }).click()
  const editor = page.getByRole('dialog')
  await editor.getByText('从示例开始', { exact: true }).click()
  await expect(editor.getByRole('button', { name: /整理本周文献/ })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('schedule-new-task-examples.png') })
  await editor.getByRole('button', { name: /整理本周文献/ }).click()
  await expect(editor.getByRole('textbox', { name: '名称' })).toHaveValue('整理本周文献')
  await expect(editor.getByRole('checkbox', { name: '周五' })).toBeChecked()
  await expect(editor.getByLabel('时间', { exact: true })).toHaveValue('16:00')
  await editor.getByRole('button', { name: '创建', exact: true }).click()
  await expect(sidebar.getByRole('button', { name: /整理本周文献/ })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: /检查训练进度/ })).toBeVisible()
})

test('offers explicit catch-up only for a paused past one-shot', async ({ page }) => {
  await page.goto('/session-schedules.html')
  await page.locator('aside').getByRole('button', { name: 'Schedule', exact: true }).click()
  await page.evaluate(async () => {
    const api = window.api.schedules
    const [summary] = await api.list({ projectId: 'research' })
    const task = (await api.get({
      projectId: 'research',
      sessionId: summary.target.sessionId,
      scheduleId: summary.id
    }))!
    const scope = { projectId: 'research', sessionId: task.target.sessionId, scheduleId: task.id }
    const once = await api.edit({
      ...scope,
      expectedRevision: task.revision,
      change: {
        kind: 'edit',
        draft: { ...task.draft, rule: { kind: 'once', at: Date.now() - 60000, timeZone: 'UTC' } }
      }
    })
    await api.edit({ ...scope, expectedRevision: once.revision, change: { kind: 'pause' } })
  })
  const sidebar = page.getByRole('region', { name: 'Schedule' })

  await sidebar.getByRole('button', { name: 'More actions' }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Run now', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Resume', exact: true })).toHaveCount(0)
})

test('shows the failed run in its conversation and once in the selected task row', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?zh&failed')
  const card = page.locator('[data-slot="card"]')
  const failure = card.getByRole('button', { name: '上次执行失败', exact: true })
  await expect(failure).toBeVisible()
  await page.locator('aside').getByRole('button', { name: '定时任务', exact: true }).click()
  const schedules = page.getByRole('region', { name: '定时任务' })

  await expect(schedules.getByText('上次执行失败', { exact: true })).toHaveCount(1)
  await schedules.getByRole('button', { name: /检查训练进度/ }).click()
  await expect(page.getByRole('main')).not.toHaveAttribute('data-notebook-run', /.+/)
  await expect(schedules.getByRole('button', { name: '上次执行失败', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开 Notebook' })).toHaveCount(0)
  await failure.focus()
  await failure.press('Enter')
  await expect(page.getByRole('main')).toHaveAttribute('data-notebook-run', 'failed-run')
  await failure.evaluate((button) => button.blur())
  await page.screenshot({ path: testInfo.outputPath('schedule-failed-session.png') })
})

test('reviews the scheduled script and shows the same task in tool history', async ({
  page
}, testInfo) => {
  await page.goto('/web-permission.html?schedule&light')
  const summary = page.getByTestId('tool-summary-card')
  await expect(summary).toHaveCount(1)
  await expect(summary.getByText('PubMed literature tracking')).toBeVisible()
  await expect(summary.getByText(/Python/)).toBeVisible()
  await expect(page.locator('summary').filter({ hasText: /^Input$/ })).toHaveCount(0)
  await page.locator('summary').filter({ hasText: 'Script' }).click()
  await expect(page.getByText('from datetime import date', { exact: false }).first()).toBeVisible()
  await page.getByRole('button', { name: /Schedule a task.*PubMed/ }).click()
  await expect(summary).toHaveCount(2)
  await expect(page.locator('summary').filter({ hasText: /^Input$/ })).toHaveCount(0)
  await expect(page.getByText('private-test-ref', { exact: false })).toHaveCount(0)
  await page.screenshot({
    animations: 'disabled',
    fullPage: true,
    path: testInfo.outputPath('schedule-permission-tool.png')
  })
})

test('keeps one schedule approval explanation and readable instructions in tool history', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/web-permission.html?schedule&message&light')
  const request = page.getByRole('group', {
    name: 'Permission request: Schedule a task',
    exact: true
  })
  await expect(request.getByTestId('permission-category-badge')).toHaveCount(0)
  await expect(request.getByTestId('permission-tool-info')).toHaveCount(0)
  const info = request.getByRole('button', { name: 'Permission impact information', exact: true })
  await info.focus()
  await expect(page.getByRole('tooltip')).toContainText('Approval applies to this call only.')
  await expect(page.getByRole('tooltip')).toContainText('Open-Science Schedule')
  await page.keyboard.press('Escape')
  const instruction = request
    .locator('dd')
    .filter({ hasText: 'Search PubMed for recently published papers' })
  await expect(instruction.locator('p')).not.toBeVisible()
  await instruction.locator('summary').click()
  await expect(instruction.locator('p')).toBeVisible()
  expect(await instruction.evaluate((node) => getComputedStyle(node).fontSize)).toBe('12px')
  await page.getByTestId('tool-chip').click()
  const history = page.getByTestId('tool-details')
  await expect(history.getByRole('heading')).toHaveCount(0)
  const body = history
    .locator('dd')
    .filter({ hasText: 'Search PubMed for recently published papers' })
  await expect(body.locator('p')).not.toBeVisible()
  await body.locator('summary').click()
  await expect(body.locator('p')).toBeVisible()
  await expect(page.getByTestId('tool-chip')).not.toContainText('·')
  await expect(page.locator('summary').filter({ hasText: /^Input$/ })).toHaveCount(0)
  await expect(page.getByText('private-test-ref', { exact: false })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('keeps task essentials visible and the editor usable at narrow widths', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 1000 })
  await page.goto('/session-schedules.html?zh')
  await page.locator('aside').getByRole('button', { name: '定时任务', exact: true }).click()
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('combobox', { name: '操作', exact: true })).toBeVisible()
  await dialog.getByText('从示例开始', { exact: true }).click()
  await dialog.getByRole('button', { name: /整理本周文献/ }).click()
  await expect(dialog.getByRole('textbox', { name: '名称' })).toHaveCount(1)
  await expect(dialog.getByRole('checkbox', { name: '周五' })).toBeChecked()
  await page.screenshot({ path: testInfo.outputPath('schedule-editor-layout.png') })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('schedule-editor-dark.png')
  })
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
  await dialog.getByText('高级选项', { exact: true }).click()
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(dialog.getByRole('button', { name: '创建', exact: true })).toBeInViewport()
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    const box = await dialog.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
  }
  await page.screenshot({ path: testInfo.outputPath('schedule-editor-advanced.png') })
})

test('retains invalid edits and confirms dismissal without changing task state', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html')
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  const editor = page.getByRole('dialog')
  const name = editor.getByRole('textbox', { name: 'Name', exact: true })
  await name.fill('')
  await name.press('Tab')
  await expect(editor.getByText('Enter a name between 1 and 200 characters.')).toBeVisible()
  await expect(editor.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled()
  await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await name.focus()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(name).toHaveValue('')
  await name.fill('Updated name')
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('schedule-discard-edits.png')
  })
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(page.getByText('Check training progress', { exact: true })).toBeVisible()
})

test('validates ending and expired time in the computer timezone without losing form values', async ({
  page
}, testInfo) => {
  await page.clock.install({ time: new Date('2026-11-13T10:00:00Z') })
  await page.goto('/session-schedules.html')
  await page.locator('aside').getByRole('button', { name: 'Schedule', exact: true }).click()
  await page.getByRole('button', { name: 'New task', exact: true }).click()
  const editor = page.getByRole('dialog')
  await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Check progress')
  await expect(editor.getByLabel('Time zone', { exact: true })).toHaveText(/^GMT(?:\+0)?$/)
  await editor.getByText('Advanced', { exact: true }).click()
  await editor.getByRole('combobox', { name: 'End condition' }).click()
  await page.getByRole('option', { name: 'Maximum runs', exact: true }).click()
  await editor.getByLabel('Maximum runs', { exact: true }).fill('3')
  await editor.getByRole('combobox', { name: 'End condition' }).click()
  await page.getByRole('option', { name: 'End time', exact: true }).click()
  await editor.getByLabel('End time', { exact: true }).fill('2026-11-12T09:00')
  await editor.getByRole('textbox', { name: 'Instructions', exact: true }).focus()
  await expect(editor.getByText('End time must be after the next run.')).toBeVisible()
  await editor.getByRole('combobox', { name: 'Repeat', exact: true }).click()
  await page.getByRole('option', { name: 'Once', exact: true }).click()
  await editor.getByLabel('Time', { exact: true }).fill('2026-11-13T10:01')
  await page.clock.fastForward(62000)
  await expect(editor.getByText('Choose a future time.')).toBeVisible()
  await expect(editor.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('schedule-field-errors.png') })
})

test('shows wait reasons only for the scheduled prompt and reacts to live updates', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?waiting&no-session')
  const status = page.getByRole('status')
  await expect(status).toHaveText('Waiting for permission')
  await page.screenshot({ path: testInfo.outputPath('schedule-wait-status.png') })
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('schedule-test-status', {
        detail: { status: 'running', promptId: 'message' }
      })
    )
  )
  await expect(status).toHaveText('Running')
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('schedule-test-status', {
        detail: { status: 'waiting-plan-approval', promptId: 'message' }
      })
    )
  )
  await expect(status).toHaveText('Waiting for plan approval')
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('schedule-test-status', {
        detail: { status: 'waiting-permission', promptId: 'unrelated-message' }
      })
    )
  )
  await expect(status).toHaveText('Running')
})

test('confirms closing a task and restores focus when cancelled', async ({ page }, testInfo) => {
  await page.goto('/session-schedules.html?zh')
  await page.locator('aside').getByRole('button', { name: '定时任务', exact: true }).click()
  const sidebar = page.getByRole('region', { name: '定时任务' })
  const trigger = sidebar.getByRole('button', { name: /检查训练进度/ })
  await trigger.click({ button: 'right' })
  await page.getByRole('menuitem', { name: '关闭任务', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText('已有结果会保留')
  await page.screenshot({
    path: testInfo.outputPath('schedule-close-confirmation.png'),
    animations: 'disabled'
  })
  await confirm.getByRole('button', { name: '取消', exact: true }).click()
  await expect(trigger).toBeFocused()
  await sidebar.getByRole('button', { name: '更多操作' }).press('Enter')
  await page.getByRole('menuitem', { name: '关闭任务', exact: true }).click()
  await confirm.getByRole('button', { name: '关闭任务', exact: true }).click()
  await expect(confirm).toHaveCount(0)
  const [task] = await page.evaluate(() => window.api.schedules.list({ projectId: 'research' }))
  expect(task.finishedAt).not.toBeNull()
})

test.describe('computer timezone with daylight saving', () => {
  test.use({ timezoneId: 'Australia/Sydney' })
  test('preserves the chosen instant in a repeated daylight-saving minute', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-03-01T00:00:00Z') })
    await page.goto('/session-schedules.html')
    await page.locator('aside').getByRole('button', { name: 'Schedule', exact: true }).click()
    await page.getByRole('button', { name: 'New task', exact: true }).click()
    const editor = page.getByRole('dialog')
    await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Check progress')
    await editor.getByRole('combobox', { name: 'Repeat', exact: true }).click()
    await page.getByRole('option', { name: 'Once', exact: true }).click()
    await editor.locator('input[type="datetime-local"]').fill('2026-04-05T02:30')
    await editor.getByRole('combobox', { name: 'Time', exact: true }).click()
    await expect(
      page.getByRole('option', { name: '2026-04-04T15:30:00.000Z', exact: true })
    ).toBeVisible()
    await page.getByRole('option', { name: '2026-04-04T16:30:00.000Z', exact: true }).click()
    await editor.getByRole('button', { name: 'Create', exact: true }).click()
    const tasks = await page.evaluate(() => window.api.schedules.list({ projectId: 'research' }))
    expect(tasks.at(-1)?.draft.rule).toEqual({
      kind: 'once',
      at: Date.parse('2026-04-04T16:30Z'),
      timeZone: 'Australia/Sydney'
    })
  })
})

test('opens a failed message occurrence before admission and locates a committed wake', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?zh&failed-message')
  await page.getByRole('button', { name: '上次执行失败', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('检查训练进度', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('status')).toHaveText('失败')
  await expect(dialog.getByRole('button', { name: '打开会话', exact: true })).toHaveCount(0)
  await expect(
    dialog.getByText('本次运行无法启动。请检查对话和运行时设置。', { exact: true })
  ).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('schedule-failed-message-result.png'),
    animations: 'disabled'
  })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '上次执行失败', exact: true })).toBeFocused()
  await page.goto('/session-schedules.html?zh&committed-failure')
  await page.getByRole('button', { name: '上次执行失败', exact: true }).click()
  await dialog.getByRole('button', { name: '打开会话', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('main')).toHaveAttribute('data-message-focus', 'failed-wake')
})

test('shows a readable request error and preserves the edited draft', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?zh&request-error')
  await page.getByRole('button', { name: '打开', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('实验日报')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByText('无法完成定时任务操作，请重试。')).toBeVisible()
  await expect(dialog.getByText('无法完成定时任务操作，请重试。')).toBeInViewport()
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('实验日报')
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
  await expect(page.getByText(/SQLITE_BUSY|\/private\/research/)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('schedule-request-error.png') })
})

test('reviews a concurrent update without losing the draft or silently overwriting it', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?zh')
  await page.getByRole('button', { name: '打开', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('实验日报')
  await page.evaluate(() => window.dispatchEvent(new Event('schedule-test-edit')))
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByText('编辑期间任务已发生变化。')).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('实验日报')
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('schedule-edit-conflict.png') })
  await dialog.getByRole('button', { name: '检查我的修改', exact: true }).click()
  await expect(dialog.getByText('请检查合并后的设置，然后保存。')).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('实验日报')
  await expect(dialog.locator('input[type="time"]')).toHaveValue('10:30')
  // A second concurrent update must still be checked with CAS.
  await page.evaluate(() => window.dispatchEvent(new Event('schedule-test-edit')))
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByText('编辑期间任务已发生变化。')).toBeVisible()
  await dialog.getByRole('button', { name: '检查我的修改', exact: true }).click()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('实验日报', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expect(dialog.locator('input[type="time"]')).toHaveValue('10:30')
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('放弃的草稿')
  await page.evaluate(() => window.dispatchEvent(new Event('schedule-test-edit')))
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await dialog.getByRole('button', { name: '放弃更改', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('实验日报')
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
})

test('shows a queued one-shot as pending in both the card and task panel', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?zh&pending')
  await expect(page.getByText('待处理', { exact: true })).toBeVisible()
  await expect(page.getByText('运行中', { exact: true })).toHaveCount(0)
  await page.locator('aside').getByRole('button', { name: '定时任务', exact: true }).click()
  await expect(page.getByText('待处理', { exact: true })).toHaveCount(2)
  await page.screenshot({ path: testInfo.outputPath('schedule-pending.png') })
})

test('protects the draft when an independent task detail receives a live revision', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?zh&independent')
  await page.getByRole('button', { name: '编辑定时任务', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('实验日报')
  await page.evaluate(() => window.dispatchEvent(new Event('schedule-test-edit')))
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByText('编辑期间任务已发生变化。')).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('实验日报')
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('schedule-independent-conflict.png') })
  await dialog.getByRole('button', { name: '检查我的修改', exact: true }).click()
  await expect(dialog.locator('input[type="time"]')).toHaveValue('10:30')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '实验日报', exact: true })).toBeVisible()
})

test('places the computer timezone beside time and preserves an existing task zone', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto('/session-schedules.html?zh')
  await page.getByRole('button', { name: '打开', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const zone = dialog.getByLabel('时区', { exact: true })
  await expect(dialog.getByRole('textbox', { name: '时区', exact: true })).toHaveCount(0)
  await expect(zone).toHaveText('GMT+7')
  const time = dialog.locator('input[type="time"]')
  const timeBox = await time.boundingBox(),
    zoneBox = await zone.boundingBox()
  expect(
    Math.abs(timeBox!.y + timeBox!.height / 2 - zoneBox!.y - zoneBox!.height / 2)
  ).toBeLessThan(2)
  await zone.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Asia/Ho_Chi_Minh')
  await time.focus()
  await page.screenshot({ path: testInfo.outputPath('schedule-inline-timezone.png') })
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('时区检查')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  expect(
    (await page.evaluate(() => window.api.schedules.list({ projectId: 'research' })))[0].draft.rule
      .timeZone
  ).toBe('Asia/Ho_Chi_Minh')
  await page.locator('aside').getByRole('button', { name: '定时任务', exact: true }).click()
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  await expect(zone).toHaveText(/^GMT(?:\+0)?$/)
  await zone.focus()
  await expect(page.getByRole('tooltip')).toHaveText('UTC')
  await dialog.getByRole('textbox', { name: '说明', exact: true }).fill('汇总今日进度')
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  expect(
    (await page.evaluate(() => window.api.schedules.list({ projectId: 'research' }))).at(-1)?.draft
      .rule.timeZone
  ).toBe('UTC')
})

test('explains pending execution locks while allowing a name-only edit', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto('/session-schedules.html?zh&pending')
  await page.getByRole('button', { name: '打开', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const reason = '任务正在等待执行，暂时无法修改执行内容和时间。'
  await expect(dialog.getByText(reason, { exact: true })).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: '说明', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('combobox', { name: '重复', exact: true })).toBeDisabled()
  await expect(dialog.getByLabel('时间', { exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
  const locked = dialog.getByLabel(reason, { exact: true })
  await locked.hover()
  await expect(page.getByRole('tooltip')).toHaveText(reason)
  await page.mouse.move(0, 0)
  await locked.focus()
  await expect(page.getByRole('tooltip')).toHaveText(reason)
  await page.screenshot({ path: testInfo.outputPath('schedule-pending-edit.png') })
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('等待中的训练检查')
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const [saved] = await page.evaluate(() => window.api.schedules.list({ projectId: 'research' }))
  expect(saved.draft.name).toBe('等待中的训练检查')
  expect(saved.currentRun?.status).toBe('dispatching')
})

for (const entry of ['message', 'sidebar'] as const) {
  test(`keeps the ${entry} editor live through claim and completion without losing its draft`, async ({
    page
  }, testInfo) => {
    await page.goto('/session-schedules.html?zh')
    if (entry === 'message') await page.getByRole('button', { name: '打开', exact: true }).click()
    else {
      await page.locator('aside').getByRole('button', { name: '定时任务', exact: true }).click()
      await page.getByRole('button', { name: '更多操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '编辑定时任务', exact: true }).click()
    }
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('保留我的草稿')
    await page.evaluate(async () => {
      const [task] = await window.api.schedules.list({ projectId: 'research' })
      task.nextDueAt = null
      task.currentRun = {
        status: 'dispatching',
        scheduledAt: 123,
        reason: null,
        runSessionId: null,
        scriptRunId: null
      }
      window.api.schedules.list = async () => structuredClone([task])
      window.dispatchEvent(new Event('schedule-test-edit'))
    })
    await expect(
      dialog.getByText('任务正在等待执行，暂时无法修改执行内容和时间。', { exact: true })
    ).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: '说明', exact: true })).toBeDisabled()
    await expect(dialog.getByText('下次执行', { exact: true })).toHaveCount(0)
    await page.evaluate(async () => {
      const [task] = await window.api.schedules.list({ projectId: 'research' })
      delete task.currentRun
      task.nextDueAt = Date.UTC(2026, 10, 15, 2)
      window.api.schedules.list = async () => structuredClone([task])
      window.dispatchEvent(new Event('schedule-test-edit'))
    })
    await expect(dialog.getByRole('textbox', { name: '说明', exact: true })).toBeEnabled()
    await expect(dialog.getByText('2026年11月15日 09:00', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(
      '保留我的草稿'
    )
    await page.screenshot({ path: testInfo.outputPath(`schedule-${entry}-live-editor.png`) })
  })
}

test('validates an extended end against the rearmed slot while keeping the task paused', async ({
  page
}, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-11-14T08:30:00Z'))
  await page.goto('/session-schedules.html?zh')
  await page.evaluate(async () => {
    const [summary] = await window.api.schedules.list({ projectId: 'research' })
    const task = (await window.api.schedules.get({
      projectId: 'research',
      sessionId: summary.target.sessionId,
      scheduleId: summary.id
    }))!
    task.pausedAt = Date.now()
    task.pauseReason = 'failed'
    task.nextDueAt = null
    task.draft.rule = { kind: 'daily', time: '09:00', timeZone: 'UTC' }
    task.draft.endAt = Date.parse('2026-11-14T08:00:00Z')
    window.api.schedules.get = async () => structuredClone(task)
    window.api.schedules.list = async () => structuredClone([task])
    window.dispatchEvent(new Event('schedule-test-edit'))
  })
  await page.getByRole('button', { name: '打开', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText('高级选项', { exact: true }).click()
  const end = dialog.getByLabel('结束时间', { exact: true })
  await end.fill('2026-11-14T08:45')
  await end.blur()
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await expect(end).toHaveAttribute('aria-invalid', 'true')
  await end.fill('2026-11-14T10:00')
  await end.blur()
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
  await expect(end).not.toHaveAttribute('aria-invalid', 'true')
  await expect(dialog.getByRole('button', { name: '继续', exact: true })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('schedule-extended-end.png') })
})

test('opens Schedule from the sidebar without a duplicate conversation header entry', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 760 })
  await page.goto('/session-schedules.html?zh')
  await expect(page.getByTestId('session-schedule-entry')).toHaveCount(0)
  await page.locator('aside').getByRole('button', { name: '定时任务', exact: true }).click()
  const panel = page.locator('aside').getByRole('region', { name: '定时任务', exact: true })
  await expect(panel.getByRole('button', { name: '新建任务' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('schedule-shared-panel.png') })
  await expect(panel.getByText('此对话', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(1)
})

test('saves independent permissions and keeps bound tasks on conversation permissions', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?zh&independent')
  await page.getByRole('button', { name: '编辑定时任务', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const permissions = dialog.getByRole('combobox', { name: '执行权限', exact: true })
  await expect(permissions).toHaveText('仅使用已有授权')
  await permissions.click()
  await page.getByRole('option', { name: '完全访问', exact: true }).click()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: '编辑定时任务', exact: true }).click()
  await expect(permissions).toHaveText('完全访问')
  await expect(dialog.getByText('运行时不弹出审批；需要审批的操作会被拒绝。')).toBeVisible()
  await expect(dialog).toHaveCSS('opacity', '1')
  await permissions.scrollIntoViewIfNeeded()
  await page.screenshot({
    path: testInfo.outputPath('schedule-independent-permissions.png'),
    animations: 'disabled'
  })
  await page.goto('/session-schedules.html?zh')
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expect(dialog.getByText('跟随会话权限')).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: '执行权限' })).toHaveCount(0)
  await expect(dialog).toHaveCSS('opacity', '1')
  await dialog.getByText('跟随会话权限').scrollIntoViewIfNeeded()
  await page.screenshot({
    path: testInfo.outputPath('schedule-bound-permissions.png'),
    animations: 'disabled'
  })
})

test('chooses an exact time without a native popup or submitting the editor', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 720, height: 600 })
  await page.goto('/session-schedules.html')
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true })
  const choose = editor.getByRole('button', { name: 'Choose time', exact: true })
  await choose.click()
  const picker = page.getByRole('dialog', { name: 'Choose time', exact: true })
  await expect(picker).toBeInViewport()
  await expect(
    picker
      .getByRole('radiogroup', { name: 'Hours', exact: true })
      .getByRole('radio', { checked: true })
  ).toHaveText('09')
  await picker
    .getByRole('radiogroup', { name: 'Hours', exact: true })
    .getByRole('radio', { name: '23', exact: true })
    .click()
  await picker
    .getByRole('radiogroup', { name: 'Minutes', exact: true })
    .getByRole('radio', { name: '37', exact: true })
    .click()
  await expect(editor.locator('input[type=time]')).toHaveValue('23:37')
  await page.keyboard.press('ArrowDown')
  await expect(editor.locator('input[type=time]')).toHaveValue('23:38')
  await page.screenshot({ path: testInfo.outputPath('schedule-time-picker.png') })
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(choose).toBeFocused()
  await editor.locator('input[type=time]').fill('06:07')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  const saved = await page.evaluate(async () => {
    const [task] = await window.api.schedules.list({ projectId: 'research' })
    return window.api.schedules.get({ ...task.target, scheduleId: task.id })
  })
  expect(saved?.draft.rule).toMatchObject({ time: '06:07' })
})

test('starts a similar task from a closed task without reopening or duplicating it immediately', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html')
  await page.evaluate(async () => {
    const [task] = await window.api.schedules.list({ projectId: 'research' })
    await window.api.schedules.edit({
      ...task.target,
      scheduleId: task.id,
      expectedRevision: task.revision,
      change: { kind: 'close' }
    })
  })
  await page.locator('aside').getByRole('button', { name: 'Schedule', exact: true }).click()

  await page.locator('[data-schedule-id]').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'View task', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('schedule-closed-menu.png') })
  await page.getByRole('menuitem', { name: 'Create similar task', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Schedule a task', exact: true })
  await expect(editor.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue(
    'Check the training job. Report the results and close this schedule when it finishes.'
  )
  expect(
    await page.evaluate(() => window.api.schedules.list({ projectId: 'research' }))
  ).toHaveLength(1)
  await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Next training check')
  await editor.getByRole('button', { name: 'Create', exact: true }).click()
  const tasks = await page.evaluate(() => window.api.schedules.list({ projectId: 'research' }))
  expect(tasks).toHaveLength(2)
  expect(tasks[0].finishedAt).not.toBeNull()
  expect(tasks[1].finishedAt).toBeNull()
  expect(tasks[1].target.sessionId).toBe(tasks[0].target.sessionId)
})

test('renders result markdown and distinct run states with navigation icons', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?independent&run-results')
  await expect(page.getByRole('heading', { name: 'Training complete', exact: true })).toBeVisible()
  await expect(page.getByText('Accuracy improved', { exact: true })).toHaveCSS('font-weight', '600')
  const running = page.getByRole('status').filter({ hasText: /^Running$/ })
  const failed = page.getByRole('status').filter({ hasText: /^Failed$/ })
  const completed = page.getByRole('status').filter({ hasText: /^Run completed$/ })
  const colors = await Promise.all(
    [running, failed, completed].map((node) =>
      node.evaluate((element) => getComputedStyle(element).color)
    )
  )
  expect(new Set(colors).size).toBe(3)
  await expect(
    page.getByRole('button', { name: 'Open session', exact: true }).first().locator('svg')
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Edit task', exact: true }).locator('svg')
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('schedule-results-states.png') })
})

test('separates execution mode from the target conversation and follows its permissions', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?zh')
  await page.locator('aside').getByRole('button', { name: '定时任务', exact: true }).click()
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '新建定时任务', exact: true })
  const mode = editor.getByRole('combobox', { name: '执行方式', exact: true })
  await expect(mode).toHaveText('每次新建对话')
  await expect(editor.getByRole('combobox', { name: '目标对话', exact: true })).toHaveCount(0)
  await expect(editor.getByRole('combobox', { name: '执行权限', exact: true })).toBeVisible()
  await editor.getByRole('textbox', { name: '说明', exact: true }).fill('继续跟踪训练进度')
  await expect(editor).toHaveCSS('opacity', '1')
  await page.screenshot({
    path: testInfo.outputPath('schedule-new-conversation-mode.png'),
    animations: 'disabled'
  })
  await mode.click()
  await page.getByRole('option', { name: '继续已有对话', exact: true }).click()
  const target = editor.getByRole('combobox', { name: '目标对话', exact: true })
  await expect(target).toHaveText('模型训练')
  await expect(editor.getByRole('combobox', { name: '执行权限', exact: true })).toHaveCount(0)
  await expect(editor.getByText('跟随会话权限', { exact: true })).toBeVisible()
  await target.click()
  await expect(page.getByRole('option', { name: '每次新建对话', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCSS('opacity', '1')
  await page.screenshot({
    path: testInfo.outputPath('schedule-existing-conversation-mode.png'),
    animations: 'disabled'
  })
  await editor.getByRole('button', { name: '创建', exact: true }).click()
  const saved = await page.evaluate(async () =>
    (await window.api.schedules.list({ projectId: 'research' })).at(-1)
  )
  expect(saved?.target).toMatchObject({
    sessionId: 'training',
    messageBranchId: 'message-branch-training'
  })
  expect(saved?.draft.permissionProfile).toBeUndefined()
})

test('defaults conversation creation to its session and keeps script execution bound', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?zh&banner')
  await page.getByTestId('session-schedule-banner').getByRole('button').click()
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  const editor = page.getByRole('dialog')
  const mode = editor.getByRole('combobox', { name: '执行方式', exact: true })
  await expect(mode).toHaveText('继续已有对话')
  await expect(editor.getByRole('combobox', { name: '目标对话', exact: true })).toHaveText(
    '模型训练'
  )
  await mode.click()
  await page.getByRole('option', { name: '每次新建对话', exact: true }).click()
  await editor.getByRole('combobox', { name: '操作', exact: true }).click()
  await page.getByRole('option', { name: '运行脚本', exact: true }).click()
  await expect(mode).toHaveCount(0)
  await expect(editor.getByRole('combobox', { name: '目标对话', exact: true })).toHaveText(
    '模型训练'
  )
  await expect(editor.getByText('在所选对话的 Notebook 中运行。', { exact: true })).toBeVisible()
  await expect(editor.getByRole('combobox', { name: '执行权限', exact: true })).toHaveCount(0)
  await editor.getByRole('textbox', { name: '脚本', exact: true }).fill('print(42)')
  await expect(editor).toHaveCSS('opacity', '1')
  await page.screenshot({
    path: testInfo.outputPath('schedule-script-target.png'),
    animations: 'disabled'
  })
  await editor.getByRole('button', { name: '创建', exact: true }).click()
  const saved = await page.evaluate(async () =>
    (await window.api.schedules.list({ projectId: 'research' })).at(-1)
  )
  expect(saved?.target.sessionId).toBe('training')
  expect(saved?.draft.action.kind).toBe('run_script')
})

test('requires an explicit target when no existing conversation is available', async ({ page }) => {
  await page.goto('/session-schedules.html?no-session')
  await page.locator('aside').getByRole('button', { name: 'Schedule', exact: true }).click()
  await page.getByRole('button', { name: 'New task', exact: true }).click()
  const editor = page.getByRole('dialog')
  await editor
    .getByRole('textbox', { name: 'Instructions', exact: true })
    .fill('Check experiment progress')
  await editor.getByRole('combobox', { name: 'How to run', exact: true }).click()
  await page.getByRole('option', { name: 'Continue an existing conversation', exact: true }).click()
  await expect(
    editor.getByRole('combobox', { name: 'Target conversation', exact: true })
  ).toHaveText('No conversations available')
  await expect(editor.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
  await editor.getByRole('combobox', { name: 'How to run', exact: true }).click()
  await page.getByRole('option', { name: 'New conversation for each run', exact: true }).click()
  await expect(editor.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
})

test('searches all conversation summaries and selects a target beyond the first page', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?many-sessions&banner')
  await page.getByTestId('session-schedule-banner').getByRole('button').click()
  await page.getByRole('button', { name: 'New task', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Schedule a task', exact: true })
  await editor
    .getByRole('textbox', { name: 'Instructions', exact: true })
    .fill('Review experiment progress')
  const loads: string[] = []
  await page.exposeFunction('recordTargetLoad', (id: string) => loads.push(id))
  await page.evaluate(() => {
    const original = window.api.sessions.loadOne
    window.api.sessions.loadOne = async (input) => {
      await (
        window as unknown as { recordTargetLoad: (id: string) => Promise<void> }
      ).recordTargetLoad(input.sessionId)
      return original(input)
    }
  })
  const target = editor.getByRole('combobox', { name: 'Target conversation', exact: true })
  await target.click()
  const search = page.getByRole('combobox', { name: 'Search conversations', exact: true })
  await expect(search).toBeFocused()
  await expect(page.getByRole('option')).toHaveCount(10)
  await page.getByRole('button', { name: 'Load more', exact: true }).click()
  await expect(page.getByRole('option')).toHaveCount(20)
  expect(loads).toEqual([])
  await search.fill('absent experiment')
  await expect(page.getByText('No matching conversations', { exact: true })).toBeVisible()
  await search.press('Enter')
  await expect(editor).toBeVisible()
  await search.fill('Experiment 35')
  await expect(page.getByRole('option')).toHaveCount(1)
  await search.fill('#35')
  await expect(page.getByRole('option')).toContainText('Experiment 35')
  await page.screenshot({
    path: testInfo.outputPath('schedule-search-conversation.png'),
    animations: 'disabled'
  })
  await search.press('Enter')
  await expect(search).toHaveCount(0)
  await expect(target).toHaveText('Experiment 35')
  await expect(target).toBeFocused()
  await expect.poll(() => loads).toEqual(['experiment-35'])
  await editor.getByRole('button', { name: 'Create', exact: true }).click()
  const saved = await page.evaluate(async () =>
    (await window.api.schedules.list({ projectId: 'research' })).at(-1)
  )
  expect(saved?.target).toMatchObject({
    sessionId: 'experiment-35',
    messageBranchId: 'message-branch-experiment-35'
  })
})

test('keeps invalid schedule arguments readable in approval and failed tool cards', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/web-permission.html?schedule&message&invalid-schedule&light')
  const approval = page.getByRole('group', {
    name: 'Permission request: Schedule a task',
    exact: true
  })
  await expect(approval.getByText('PubMed literature tracking', { exact: true })).toBeVisible()
  await expect(
    approval.getByText('One-time tasks run once. Remove the end time and maximum runs.', {
      exact: true
    })
  ).toBeVisible()
  await expect(approval.getByText('Follow conversation permissions', { exact: true })).toBeVisible()
  await page.getByTestId('tool-chip').click()
  const history = page.getByTestId('tool-details')
  await expect(
    history.getByText('One-time tasks run once. Remove the end time and maximum runs.', {
      exact: true
    })
  ).toBeVisible()
  await expect(page.locator('summary').filter({ hasText: /^(Input|Result)$/ })).toHaveCount(0)
  await expect(page.getByText('MCP error', { exact: false })).toHaveCount(0)
  const instructions = history
    .locator('dd')
    .filter({ hasText: 'Search PubMed for recently published papers' })
  await expect(instructions.locator('p')).not.toBeVisible()
  expect(await instructions.evaluate((node) => getComputedStyle(node).fontSize)).toBe('12px')
  await page.screenshot({
    path: testInfo.outputPath('schedule-readable-approval-tools.png'),
    animations: 'disabled',
    fullPage: true
  })
})

for (const closed of [false, true]) {
  test(`reveals the associated task and selects its sidebar row (closed=${closed})`, async ({
    page
  }, testInfo) => {
    await page.goto(`/session-schedules.html?zh&banner${closed ? '&closed-schedule' : ''}`)
    const banner = page.getByTestId('session-schedule-banner')
    await expect(banner.getByText('检查训练进度', { exact: true })).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('schedule-session-banner.png'),
      animations: 'disabled'
    })
    await banner.getByRole('button').click()
    await expect(page.locator('aside').getByText('此对话', { exact: true })).toBeVisible()
    const selected = page.locator('aside [aria-current="true"]')
    await expect(selected).toBeVisible()
    await expect(selected).toContainText('检查训练进度')
    if (closed)
      await expect(selected.locator('xpath=ancestor::details')).toHaveAttribute('open', '')
    await page.screenshot({
      path: testInfo.outputPath('schedule-task-navigation.png'),
      animations: 'disabled'
    })
  })
}

test('preserves the sidebar and shared reads on repeated task navigation', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?banner')
  await page.getByTestId('session-schedule-banner').waitFor()
  const typography = await page.locator('button[title="Training research"]').evaluate((node) => {
    const style = getComputedStyle(node)
    return [style.fontFamily, style.fontSize, style.fontWeight, style.letterSpacing]
  })
  await page.locator('aside').getByRole('button', { name: 'Schedule', exact: true }).click()
  await page.locator('aside [data-schedule-id]').waitFor()
  expect(
    await page.locator('aside h1').evaluate((node) => {
      const style = getComputedStyle(node)
      return [style.fontFamily, style.fontSize, style.fontWeight, style.letterSpacing]
    })
  ).toEqual(typography)

  await page.evaluate(() => {
    const api = window.api.schedules
    const original = api.list
    Object.assign(window, {
      scheduleListReads: 0,
      scheduleHeader: document.querySelector('aside header'),
      scheduleRow: document.querySelector('aside [data-schedule-id]')
    })
    api.list = async (...args) => {
      const counters = window as unknown as { scheduleListReads: number }
      counters.scheduleListReads++
      return original(...args)
    }
  })
  const banner = page.getByTestId('session-schedule-banner').getByRole('button')
  for (let i = 0; i < 3; i++) await banner.click()
  await expect(page.locator('aside [aria-current="true"]')).toBeVisible()
  expect(
    await page.evaluate(() => {
      const previous = window as unknown as {
        scheduleListReads: number
        scheduleHeader: Element
        scheduleRow: Element
      }
      return {
        reads: previous.scheduleListReads,
        headerPreserved: document.querySelector('aside header') === previous.scheduleHeader,
        rowPreserved: document.querySelector('aside [data-schedule-id]') === previous.scheduleRow
      }
    })
  ).toEqual({ reads: 0, headerPreserved: true, rowPreserved: true })
  await page.screenshot({
    path: testInfo.outputPath('schedule-navigation-stable.png'),
    animations: 'disabled'
  })
})

test('collapses read-only instructions and retains closed tasks alongside active tasks', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?closed-schedule')
  const offset = await page.locator('[data-slot=card] [role=status]').evaluate((node) => {
    const repeat = node.parentElement!.firstElementChild!.getBoundingClientRect()
    const status = node.getBoundingClientRect()
    return Math.abs(repeat.y + repeat.height / 2 - status.y - status.height / 2)
  })
  expect(offset).toBeLessThanOrEqual(0.5)
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const instructions = dialog
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'Instructions' }) })
  await expect(instructions).not.toHaveAttribute('open', '')
  await expect(dialog.getByRole('textbox', { name: 'Instructions' })).toHaveCount(0)
  await expect(dialog).toHaveCSS('opacity', '1')
  await page.screenshot({
    path: testInfo.outputPath('schedule-readonly-collapsed.png'),
    animations: 'disabled'
  })
  await instructions.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(instructions).toHaveAttribute('open', '')
  await expect(
    instructions.getByText(
      'Check the training job. Report the results and close this schedule when it finishes.'
    )
  ).toBeVisible()
  await instructions.locator('summary').click()
  await expect(instructions).not.toHaveAttribute('open', '')
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  // Include both tasks in the association, as on a later reply.
  await page.goto('/session-schedules.html?banner&closed-schedule')
  await page.evaluate(async () => {
    const api = window.api.schedules
    const [task] = await api.list({ projectId: 'research' })
    const source = (await api.get({ ...task.target, scheduleId: task.id }))!
    await api.create({ target: task.target, requestId: 'another-task', draft: source.draft })
  })
  const banner = page.getByTestId('session-schedule-banner')
  await expect(banner).toContainText('2 scheduled tasks')
  await banner.getByRole('button').click()
  await expect(
    page.getByRole('region', { name: 'Schedule', exact: true }).locator('details[open]')
  ).toHaveCount(2)
})

test('reflects task state in the message card icon without repeating it in the metadata', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?banner')
  const card = page.getByTestId('session-schedule-banner')
  await expect(card.locator('svg.lucide-clock-3')).toBeVisible()
  await page.evaluate(async () => {
    const [task] = await window.api.schedules.list({ projectId: 'research' })
    await window.api.schedules.edit({
      ...task.target,
      scheduleId: task.id,
      expectedRevision: task.revision,
      change: { kind: 'pause' }
    })
  })
  await expect(card.locator('svg.lucide-circle-pause')).toBeVisible()
  await expect(card.getByRole('status')).toHaveText('Paused')
  await expect(card.getByRole('status').locator('svg')).toHaveCount(0)
  await page.evaluate(async () => {
    const [task] = await window.api.schedules.list({ projectId: 'research' })
    await window.api.schedules.edit({
      ...task.target,
      scheduleId: task.id,
      expectedRevision: task.revision,
      change: { kind: 'close' }
    })
  })
  const icon = card.locator('svg.lucide-circle-stop')
  await expect(icon).toBeVisible()
  await expect(card.getByRole('status')).toHaveText('Cancelled')
  const alignment = await card.getByRole('status').evaluate((node) => {
    const repeat = node.parentElement!.firstElementChild!.getBoundingClientRect()
    const status = node.getBoundingClientRect()
    return { offset: Math.abs(repeat.y - status.y), height: repeat.height - status.height }
  })
  expect(alignment).toEqual({ offset: 0, height: 0 })
  expect(await icon.evaluate((node) => getComputedStyle(node).color)).toBe(
    await card.getByRole('status').evaluate((node) => getComputedStyle(node).color)
  )
  await page.screenshot({
    path: testInfo.outputPath('schedule-closed-card-status.png'),
    animations: 'disabled'
  })
})

test('shows a completed task with a check icon and a completion label', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?banner&completed-schedule')
  const card = page.getByTestId('session-schedule-banner')
  await expect(card.locator('svg.lucide-circle-check')).toBeVisible()
  await expect(card.getByRole('status')).toHaveText('Completed')
  await card.getByRole('button').click()
  await expect(page.locator('aside [aria-current="true"]')).toContainText('Completed')
  await page.screenshot({
    path: testInfo.outputPath('schedule-completed-card-status.png'),
    animations: 'disabled'
  })
})

for (const stopped of [false, true]) {
  test(`keeps stopped cards at their scheduled reply (stopped=${stopped})`, async ({
    page
  }, testInfo) => {
    await page.goto(
      `/session-schedules.html?banner&timeline${stopped ? '&completed-schedule' : ''}`
    )
    const earlier = page.getByRole('region', { name: 'Scheduled reply', exact: true })
    await expect(earlier.getByTestId('session-schedule-banner')).toBeVisible()
    await page.getByRole('button', { name: 'Continue conversation' }).click()
    const later = page.getByRole('region', { name: 'Later reply', exact: true })
    await expect(earlier.getByTestId('session-schedule-banner')).toHaveCount(stopped ? 1 : 0)
    await expect(later.getByTestId('session-schedule-banner')).toHaveCount(stopped ? 0 : 1)
    if (stopped)
      await page.screenshot({
        path: testInfo.outputPath('schedule-stopped-card-anchor.png'),
        animations: 'disabled'
      })
  })
}

test('confirms task deletion from the shared menu and preserves its historical message', async ({
  page
}, testInfo) => {
  await page.goto('/session-schedules.html?zh')
  await page.setViewportSize({ width: 1050, height: 650 })
  await page.locator('aside').getByRole('button', { name: '定时任务', exact: true }).click()
  const row = page.locator('[data-schedule-id="check"]')
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: '删除任务' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('对话和文件会保留')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '删除任务' }).click()
  await expect(dialog).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('schedule-delete-confirm.png'),
    animations: 'disabled'
  })
  await dialog.getByRole('button', { name: '删除任务', exact: true }).click()
  await expect(row).toHaveCount(0)
  await expect(page.getByText('任务已删除', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '打开', exact: true })).toHaveCount(0)
  await expect(dialog).toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath('schedule-deleted-message.png'),
    animations: 'disabled'
  })
})

test('disables deletion of a running task with an explanation', async ({ page }) => {
  await page.goto('/session-schedules.html?final-run')
  await page.locator('aside').getByRole('button', { name: 'Schedule', exact: true }).click()
  await page.locator('[data-schedule-id="check"]').click({ button: 'right' })
  const remove = page.getByRole('menuitem', { name: 'Delete task' })
  await expect(remove).toHaveAttribute('aria-disabled', 'true')
  await remove.hover()
  await expect(remove).toHaveAttribute(
    'title',
    'This task is running. Wait for it to finish or stop the current run before deleting it.'
  )
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
})
