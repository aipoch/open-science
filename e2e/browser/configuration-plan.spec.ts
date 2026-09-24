import { expect, test } from '@playwright/test'

test('reviews exact configuration content and submits a one-time decision', async ({
  page
}, testInfo) => {
  await page.goto('/configuration-plan.html')
  await expect(page.getByText('Review configuration changes', { exact: true }).last()).toBeVisible()
  await expect(
    page.getByText('Approval applies only to the target and content shown below.')
  ).toBeVisible()
  await expect(page.getByTestId('permission-card')).toContainText(
    'Review data and document uncertainty.'
  )
  await expect(page.getByRole('button', { name: 'Choose authorization scope' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('configuration-plan.png'), fullPage: true })
  await page.getByTestId('allow-primary').click()
  expect(
    await page.evaluate(() => (window as unknown as { planResponses: unknown[] }).planResponses)
  ).toEqual([{ requestId: 'plan', optionId: 'approve' }])
})

test('shows the complete package plan in Chinese and supports rejection', async ({
  page
}, testInfo) => {
  await page.goto('/configuration-plan.html?lang=zh-Hans&packages')
  await expect(page.getByText('审阅安装方案', { exact: true })).toBeVisible()
  await expect(page.getByTestId('permission-card')).toContainText('dependency')
  await page.screenshot({ path: testInfo.outputPath('package-plan-zh.png'), fullPage: true })
  await page.getByTestId('deny-button').click()
  expect(
    await page.evaluate(() => (window as unknown as { planResponses: unknown[] }).planResponses)
  ).toEqual([{ requestId: 'plan', optionId: 'decline' }])
})

test('renders the end of a large plan after production projection', async ({ page }) => {
  const { AcpPermissionBroker } = await import('../../src/main/acp/permission-broker')
  const { projectPermissionRequest } = await import('../../src/main/acp/runtime-publication-owner')
  let projected: unknown
  const broker = new AcpPermissionBroker((request) => {
    projected = projectPermissionRequest(projectPermissionRequest(request))
  })
  const controller = new AbortController()
  const approval = broker.requestAppApproval({
    sessionId: 's',
    title: 'Review configuration changes',
    rawInput: {},
    signal: controller.signal,
    configurationPlan: {
      kind: 'agent-configuration',
      target: 'large-agent',
      changes: { systemPrompt: 'review line\n'.repeat(2000) + 'FINAL_REVIEW_MARKER' }
    }
  })
  await page.addInitScript((request) => {
    Object.assign(window, { projectedPlan: request })
  }, projected)
  await page.goto('/configuration-plan.html')
  await expect(page.getByTestId('permission-card')).toContainText('FINAL_REVIEW_MARKER')
  await page.getByTestId('allow-primary').click()
  expect(
    await page.evaluate(() => (window as unknown as { planResponses: unknown[] }).planResponses)
  ).toHaveLength(1)
  controller.abort()
  await approval
})
