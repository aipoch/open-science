import type { SmartCollectionView } from '../src/shared/literature-smart-collections'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

test('creates a smart collection without a model and preserves the setup path', async ({
  app
}, testInfo) => {
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: 'All references', exact: true }).click()
  await page.getByRole('button', { name: 'New collection', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('switch', { name: 'Smart collection', exact: true }).check()
  await dialog.getByLabel('Name', { exact: true }).fill('Clinical trials')
  await expect(
    dialog.getByRole('button', { name: 'Create collection', exact: true })
  ).toBeDisabled()
  await dialog
    .getByLabel(/Inclusion criteria/)
    .fill('Randomized clinical trials evaluating treatments in adults.')
  await dialog.getByLabel(/Exclusion criteria/).fill('Reviews and animal studies.')
  await page.screenshot({ path: testInfo.outputPath('smart-collection-create.png') })
  const viewport =
    page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 720 })
    const bounds = await dialog.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    const save = await dialog
      .getByRole('button', { name: 'Create collection', exact: true })
      .boundingBox()
    expect(save!.y + save!.height).toBeLessThanOrEqual(720)
    await page.screenshot({ path: testInfo.outputPath(`smart-rule-editor-${width}.png`) })
  }
  await page.setViewportSize(viewport)
  await dialog.getByRole('button', { name: 'Create collection', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Clinical trials', exact: true })).toBeVisible()
  const panel = page.getByRole('region', { name: 'Smart collection', exact: true })
  await expect(panel.getByRole('button', { name: 'Update collection' })).toHaveCount(0)
  await expect(page.getByText('No references found', { exact: true })).toHaveCount(0)
  await expect(
    panel.getByText('Choose a classification model to start organizing papers.')
  ).toBeVisible()
  await expect(page.locator('input[placeholder="Search references"]:visible')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('smart-collection-unconfigured.png') })
  await panel.getByRole('button', { name: 'Configure classification model' }).click()
  await expect(page.getByText('Smart collections', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('smart-collection-settings.png') })
  await page.getByRole('button', { name: 'Smart collections', exact: true }).click()
  await expect(
    page.getByText(
      'Shared by all smart collections. You can choose a different model from automatic capability selection.'
    )
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('smart-collection-model-help.png') })
})

test('selects the first classification model for both features after saving a provider', async ({
  app
}, testInfo) => {
  const { createServer } = await import('node:http')
  const service = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        model: 'fixture',
        answers: { test: { type: 'noul', noul: 1 } },
        usage: { input_tokens: 3, output_tokens: 1 }
      })
    )
  })
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
  try {
    const port = (service.address() as { port: number }).port
    const page = await app.completeOnboarding()
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    await page.getByRole('button', { name: 'Model settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('tab', { name: 'Classification models' }).click()
    await settings.getByText('Add service').click()
    await settings.getByRole('combobox', { name: 'Provider' }).press('Enter')
    await page.getByRole('option', { name: 'Custom HTTP service' }).click()
    await settings.getByLabel('Service name').fill('Test classifier')
    await settings.getByLabel('Endpoint URL').fill(`http://127.0.0.1:${port}`)
    await settings.getByLabel('Model', { exact: true }).fill('fixture')
    await settings.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(settings.getByRole('heading', { name: 'Test classifier' })).toBeVisible()
    await expect(
      settings.getByRole('combobox', { name: 'Automatic capability selection' })
    ).toHaveText('Test classifier / fixture')
    await expect(settings.getByRole('combobox', { name: 'Smart collections' })).toHaveText(
      'Test classifier / fixture'
    )
    await page.screenshot({ path: testInfo.outputPath('classification-model-auto-selected.png') })
  } finally {
    service.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      service.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('opens the Library table named by a smart collection scope', async ({ app }, testInfo) => {
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await page.evaluate(async () => {
    const project = await window.api.projects.create({ name: 'Source project', description: '' })
    const source = await window.api.literature.transact({
      kind: 'create-collection',
      name: 'Source collection'
    })
    const description = JSON.stringify({ description: '', inclusion: 'Research', exclusion: '' })
    for (const [name, scope] of [
      ['Library rule', { kind: 'library' }],
      ['Project rule', { kind: 'project', id: project.id }],
      ['Collection rule source', { kind: 'collection', id: source.id }]
    ] as const) {
      await window.api.literature.transact({
        kind: 'create-smart-collection',
        name,
        description,
        scope
      })
    }
  })
  await page.reload()
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: 'All references', exact: true }).click()

  for (const [rule, scope, destination] of [
    ['Library rule', 'All references', 'All references'],
    ['Project rule', 'Project: Source project', 'Source project'],
    ['Collection rule source', 'Collection: Source collection', 'Source collection']
  ] as const) {
    await page.getByRole('button', { name: rule, exact: true }).click()
    const panel = page.getByRole('region', { name: 'Smart collection', exact: true })
    await panel.getByRole('button', { name: 'Collection rule', exact: true }).click()
    const scopeButton = panel.getByRole('button', { name: scope, exact: true })
    await expect(scopeButton).toBeVisible()
    if (rule === 'Project rule')
      await page.screenshot({ path: testInfo.outputPath('smart-project-scope-link.png') })
    if (rule === 'Collection rule source')
      await page.screenshot({ path: testInfo.outputPath('smart-collection-scope-link.png') })
    await scopeButton.click()
    await expect(page.getByRole('heading', { name: destination, exact: true })).toBeVisible()
    if (rule === 'Project rule')
      await page.screenshot({ path: testInfo.outputPath('smart-project-scope-destination.png') })
  }
})

test('reviews classified papers in the library table using a local fixture service', async ({
  app
}, testInfo) => {
  test.setTimeout(240_000)
  const { createServer } = await import('node:http')
  const { literatureItemInputSchema } = await import('../src/shared/literature')
  let failClassification = false
  const classifiedInputs: string[] = []
  let holdAfter = 0
  let holdClassification: Promise<void> | undefined
  let releaseClassification: (() => void) | undefined
  const service = createServer(async (request, response) => {
    let data = ''
    for await (const chunk of request) data += chunk
    const body = JSON.parse(data)
    if (body.questions.membership) {
      classifiedInputs.push(body.state)
      if (classifiedInputs.length >= holdAfter) await holdClassification
    }
    if (failClassification && body.questions.membership) {
      response.writeHead(401)
      response.end('fixture unauthorized')
      return
    }
    const verdict = body.state.includes('Review of')
      ? 'no-match'
      : body.state.includes('Pilot')
        ? 'uncertain'
        : 'match'
    const answers = body.questions.membership
      ? {
          membership: {
            type: 'choice',
            choice: verdict,
            confidence: 1,
            probabilities: {
              match: verdict === 'match' ? 1 : 0,
              'no-match': verdict === 'no-match' ? 1 : 0,
              uncertain: verdict === 'uncertain' ? 1 : 0
            }
          }
        }
      : { test: { type: 'noul', noul: 1 } }
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        model: 'fixture-classifier',
        answers,
        usage: { input_tokens: 42, output_tokens: 5 }
      })
    )
  })
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
  try {
    const address = service.address() as { port: number }
    const page = await app.completeOnboarding()
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    const papers = [
      'Randomized trial of rehabilitation after stroke',
      'Blood pressure treatment in adults: a randomized trial',
      'Pilot study of home monitoring',
      'Review of cardiovascular prevention'
    ].map((title) =>
      literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title,
        abstract: 'A fixture abstract used only for local interface testing.',
        issuedYear: 2025
      })
    )
    const id = await page.evaluate(
      async ({ papers, port }) => {
        await window.api.literature.transact({
          kind: 'create-collection',
          name: 'Manual collection'
        })
        for (const item of papers)
          await window.api.literature.transact({ kind: 'create-item', item })
        const snapshot = await window.api.settings.getClassification()
        const saved = await window.api.settings.updateClassification({
          kind: 'save',
          revision: snapshot.revision,
          id: '55555555-5555-4555-8555-555555555555',
          adapter: 'custom',
          name: 'Local fixture service',
          baseUrl: `http://127.0.0.1:${port}`,
          modelId: 'fixture-classifier'
        })
        if (saved.validation && !saved.validation.ok)
          throw new Error(JSON.stringify(saved.validation))
        await window.api.settings.updateClassification({
          kind: 'bind',
          feature: 'smart-collections',
          revision: saved.revision,
          binding: {
            serviceId: '55555555-5555-4555-8555-555555555555',
            modelId: 'fixture-classifier'
          }
        })
        return (
          await window.api.literature.transact({
            kind: 'create-smart-collection',
            name: 'Clinical trials',
            description: JSON.stringify({
              description: 'Clinical trials',
              inclusion: 'Randomized clinical trials in adults.',
              exclusion: 'Reviews.'
            }),
            scope: { kind: 'library' }
          })
        ).id
      },
      { papers, port: address.port }
    )
    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await page.getByRole('button', { name: 'Manual collection', exact: true }).click()
    const ordinaryTop = (await page
      .getByRole('heading', { name: 'No references found' })
      .locator('..')
      .boundingBox())!.y
    await page.screenshot({ path: testInfo.outputPath('ordinary-collection-empty.png') })
    const ordinaryTrigger = (await page
      .getByRole('button', { name: 'More actions', exact: true })
      .boundingBox())!
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Edit collection', exact: true })).toBeVisible()
    await expect
      .poll(async () => {
        const menu = (await page.getByRole('menu').boundingBox())!
        return Math.abs(menu.x + menu.width - ordinaryTrigger.x - ordinaryTrigger.width)
      })
      .toBeLessThan(2)

    await expect(page.getByRole('menuitem', { name: 'Export', exact: true })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath('ordinary-collection-export-menu.png') })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Clinical trials', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Smart collection', exact: true })
    await expect(page.getByText('Ready to organize')).toBeVisible()
    const setupTop = (await page
      .getByRole('heading', { name: 'Ready to organize' })
      .locator('..')
      .boundingBox())!.y
    expect(Math.abs(setupTop - ordinaryTop)).toBeLessThan(2)
    await page.screenshot({ path: testInfo.outputPath('smart-collection-ready.png') })
    await panel.getByRole('button', { name: 'Collection actions', exact: true }).click()
    await page
      .getByRole('menuitem', { name: 'Trial run (up to 20 references)', exact: true })
      .click()
    await expect(
      page.getByRole('region', { name: 'Trial run (up to 20 references)' })
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('smart-trial-confirm.png') })
    await page
      .getByRole('region', { name: 'Trial run (up to 20 references)' })
      .getByRole('button', { name: 'Cancel' })
      .click()
    await panel.getByRole('button', { name: 'Update collection', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Updated', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('smart-collection-updated.png') })
    await expect(
      panel.getByRole('button', { name: 'Update collection', exact: true })
    ).toBeVisible()
    await expect
      .poll(
        async () =>
          await page.evaluate(
            async (id) =>
              (
                await window.api.literature.transact({
                  kind: 'smart-collection',
                  collectionId: id,
                  action: 'read',
                  offset: 0
                })
              ).smart?.run?.state,
            id
          )
      )
      .toBe('completed')
    await expect(
      page.getByText('Randomized trial of rehabilitation after stroke', { exact: true })
    ).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Included 2', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Needs review 1', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Excluded 1', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Not evaluated 0', exact: true })).toBeVisible()
    const includedTab = page.getByRole('tab', { name: 'Included 2', exact: true })
    const decisionTabs = page.getByRole('tablist', { name: 'Filter decisions' }).getByRole('tab')
    const tabGeometry = (): Promise<{ x: number; y: number; width: number; height: number }[]> =>
      decisionTabs.evaluateAll((tabs) =>
        tabs.map((tab) => {
          const { x, y, width, height } = tab.getBoundingClientRect()
          return { x, y, width, height }
        })
      )
    const initialGeometry = await tabGeometry()
    for (let index = 0; index < 4; index++) {
      await decisionTabs.nth(index).click()
      expect(await tabGeometry()).toEqual(initialGeometry)
    }
    await includedTab.click()
    await includedTab.focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Needs review 1', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await page.keyboard.press('ArrowLeft')
    await expect(includedTab).toHaveAttribute('aria-selected', 'true')
    const decisionBounds = await page
      .getByRole('tablist', { name: 'Filter decisions' })
      .boundingBox()
    const sortBounds = await page.getByRole('combobox', { name: 'Sort references' }).boundingBox()
    expect(Math.abs(decisionBounds!.y - sortBounds!.y)).toBeLessThan(10)
    const searchBounds = await page
      .getByRole('textbox', { name: 'Search references' })
      .boundingBox()
    expect(searchBounds!.x + searchBounds!.width).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth)
    )
    const tableTop = (await page.getByRole('table').boundingBox())!.y
    expect(Math.abs(tableTop - ordinaryTop)).toBeLessThan(2)
    const smartTrigger = (await panel
      .getByRole('button', { name: 'Collection actions', exact: true })
      .boundingBox())!
    await panel.getByRole('button', { name: 'Collection actions', exact: true }).click()
    await expect
      .poll(async () => {
        const menu = (await page.getByRole('menu').boundingBox())!
        return Math.abs(menu.x + menu.width - smartTrigger.x - smartTrigger.width)
      })
      .toBeLessThan(2)

    await page.getByRole('menuitem', { name: 'Export included references', exact: true }).hover()
    await expect(page.getByRole('menuitem', { name: 'BibTeX', exact: true })).toBeEnabled()
    await expect(page.getByRole('menuitem', { name: 'RIS', exact: true })).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('smart-collection-export-menu.png') })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.getByRole('heading', { name: 'Clinical trials', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('smart-collection-included.png') })
    const reviewTab = page.getByRole('tab', { name: 'Needs review 1', exact: true })
    const hoverBorder = await reviewTab.evaluate((element) => getComputedStyle(element).color)
    await reviewTab.hover()
    await expect
      .poll(() => reviewTab.evaluate((element) => getComputedStyle(element).borderBottomColor))
      .toBe(hoverBorder)
    expect(await tabGeometry()).toEqual(initialGeometry)
    await expect(includedTab).toHaveAttribute('aria-selected', 'true')
    await page.screenshot({ path: testInfo.outputPath('smart-collection-hover.png') })

    await page.getByRole('tab', { name: 'Not evaluated 0', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'No papers in this view.' })).toBeVisible()
    const emptyTop = (await page
      .getByRole('heading', { name: 'No papers in this view.' })
      .locator('..')
      .boundingBox())!.y
    expect(Math.abs(emptyTop - ordinaryTop)).toBeLessThan(2)
    await page.screenshot({ path: testInfo.outputPath('smart-collection-empty.png') })
    await page.getByRole('tab', { name: 'Included 2', exact: true }).click()
    await panel.getByRole('button', { name: 'Collection rule', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('smart-collection-expanded.png') })
    const ruleDetails = panel.locator('[id^="smart-details-"]')
    await expect(ruleDetails.getByText('Inclusion criteria', { exact: true }).first()).toBeVisible()
    await expect(ruleDetails.getByText('Exclusion criteria', { exact: true }).first()).toBeVisible()
    await expect(ruleDetails).not.toContainText('## Description')
    const detailsViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    await page.getByRole('button', { name: 'Collapse sidebar panel' }).click()
    for (const width of [320, 375, 414, 768]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await ruleDetails.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
      await ruleDetails.screenshot({ path: testInfo.outputPath(`smart-rule-details-${width}.png`) })
    }
    await page.setViewportSize(detailsViewport)
    await page.getByRole('button', { name: 'Expand sidebar panel' }).click()

    await panel.getByRole('button', { name: 'Edit rule', exact: true }).click()
    const ruleDialog = page.getByRole('dialog', { name: 'Edit collection', exact: true })
    await expect(ruleDialog.getByLabel(/Inclusion criteria/)).toHaveValue(
      'Randomized clinical trials in adults.'
    )
    await expect(
      ruleDialog.getByRole('switch', { name: 'Use available full text', exact: true })
    ).not.toBeChecked()
    await expect(
      ruleDialog.getByRole('switch', { name: 'Update automatically', exact: true })
    ).not.toBeChecked()
    await expect(
      ruleDialog.getByText('Sends available PDF text to the classification service.')
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('smart-rule-compact-help.png') })
    await ruleDialog
      .getByRole('button', { name: 'About Use available full text', exact: true })
      .hover()
    await expect(page.getByRole('tooltip')).toContainText('Long papers use relevant passages')
    await page.screenshot({ path: testInfo.outputPath('smart-rule-help-tooltip.png') })
    await ruleDialog.getByRole('textbox', { name: 'Name', exact: true }).hover()
    await ruleDialog.getByRole('switch', { name: 'Use available full text', exact: true }).check()
    await page.screenshot({ path: testInfo.outputPath('smart-collection-edit-rule.png') })
    await ruleDialog.getByRole('switch', { name: 'Live rule preview', exact: true }).click()
    await expect(
      ruleDialog.getByText('Pilot study of home monitoring', { exact: true })
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('smart-collection-live-preview.png') })
    await ruleDialog
      .getByRole('button', { name: 'Evaluation details', exact: true })
      .first()
      .click()
    await expect(
      page.getByText('Evidence: available title and abstract; no PDF text used', { exact: true })
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('smart-evidence-fallback.png') })
    await page.keyboard.press('Escape')

    await ruleDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Included 2', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Collection rule', exact: true }).click()

    await page.getByRole('tab', { name: 'Needs review 1', exact: true }).click()
    await expect(page.getByText('Pilot study of home monitoring', { exact: true })).toBeVisible()
    await expect(
      page.getByText('Randomized trial of rehabilitation after stroke', { exact: true })
    ).toHaveCount(0)
    await expect(
      page.getByText('The model could not determine a match', { exact: true })
    ).toHaveCount(0)
    const reviewRow = page.getByRole('row').filter({ hasText: 'Pilot study of home monitoring' })
    const include = reviewRow.getByRole('button', { name: 'Include', exact: true })
    await include.hover()
    await expect(page.getByRole('tooltip', { name: 'Include', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('smart-collection-action-hover.png') })
    const actionBounds = await Promise.all(
      ['Include', 'Exclude', 'Re-evaluate'].map((name) =>
        reviewRow.getByRole('button', { name, exact: true }).boundingBox()
      )
    )
    expect(actionBounds.every((bounds) => bounds?.y === actionBounds[0]?.y)).toBe(true)
    const attachmentLeft = (await page
      .getByRole('columnheader', { name: 'Attachment', exact: true })
      .boundingBox())!.x
    expect(actionBounds[2]!.x + actionBounds[2]!.width).toBeLessThanOrEqual(attachmentLeft)
    await page.getByRole('heading', { name: 'Clinical trials', exact: true }).hover()
    await expect(page.getByRole('tooltip', { name: 'Include', exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('smart-collection-review.png') })
    await page.getByRole('button', { name: 'Evaluation details', exact: true }).hover()
    await expect(page.getByRole('heading', { name: 'Evaluation details' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('smart-assessment-hover.png') })
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await page.getByRole('button', { name: 'Match score', exact: true }).hover()
    await expect(page.getByRole('tooltip')).toContainText(
      'not paper quality or calibrated probabilities'
    )
    await page.screenshot({ path: testInfo.outputPath('smart-score-help.png') })
    await page.getByRole('heading', { name: 'Clinical trials', exact: true }).hover()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('smart-collection-review-scores.png') })
    await page.keyboard.press('Escape')
    const originalViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    await page.setViewportSize({ width: 650, height: 850 })
    const scrollArea = page.locator('[data-slot="literature-table-scroll"]')
    const assessmentButton = reviewRow.getByRole('button', {
      name: 'Evaluation details',
      exact: true
    })
    await assessmentButton.click()
    await expect(page.getByRole('heading', { name: 'Evaluation details' })).toBeVisible()
    await scrollArea.evaluate((element) => {
      const trigger = element.querySelector('button[aria-label="Evaluation details"]')!
      element.scrollLeft +=
        trigger.getBoundingClientRect().left -
        element.getBoundingClientRect().left +
        trigger.getBoundingClientRect().width / 2
    })
    const assessmentPopup = page.getByRole('dialog').filter({
      has: page.getByRole('heading', { name: 'Evaluation details' })
    })
    await expect(assessmentPopup).toBeVisible()
    await expect
      .poll(async () => {
        const popup = await assessmentPopup.boundingBox()
        const table = await scrollArea.boundingBox()
        return Boolean(
          popup && table && popup.x >= table.x && popup.x + popup.width <= table.x + table.width
        )
      })
      .toBe(true)
    await page.screenshot({ path: testInfo.outputPath('smart-assessment-scroll-boundary.png') })
    await scrollArea.evaluate((element) => {
      element.scrollLeft = element.scrollWidth - element.clientWidth
    })
    await expect(assessmentPopup).toHaveCount(0)
    await page.keyboard.press('Escape')
    await scrollArea.evaluate((element) => {
      element.scrollLeft = 0
    })
    await page.setViewportSize(originalViewport)
    await page.getByText('Pilot study of home monitoring', { exact: true }).click()
    await page.getByRole('button', { name: 'Include', exact: true }).last().click()
    await expect(
      page.getByRole('dialog').getByText('Manually included', { exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Include', exact: true })
    ).toBeDisabled()
    await expect
      .poll(
        async () =>
          await page.evaluate(
            async (id) =>
              (
                await window.api.literature.transact({
                  kind: 'smart-collection',
                  collectionId: id,
                  action: 'read',
                  offset: 0
                })
              ).smart?.overrides,
            id
          )
      )
      .toBe(1)
    await page.keyboard.press('Escape')
    await page.getByRole('tab', { name: 'Excluded 1', exact: true }).click()
    await expect(
      page.getByText('Review of cardiovascular prevention', { exact: true })
    ).toBeVisible()
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.screenshot({ path: testInfo.outputPath('smart-collection-compact.png') })
    await page.setViewportSize({ width: 1440, height: 1048 })
    await page.getByRole('tab', { name: 'Included 3', exact: true }).click()
    const decisionSource = page.getByRole('combobox', { name: 'Decision source', exact: true })
    await decisionSource.click()
    await page.getByRole('option', { name: 'Manual decisions', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Included 1', exact: true })).toBeVisible()
    await expect(
      page.getByRole('row').filter({ hasText: 'Pilot study of home monitoring' })
    ).toHaveCount(1)
    await decisionSource.click()
    await page.getByRole('option', { name: 'AI decisions', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Included 2', exact: true })).toBeVisible()
    await expect(
      page.getByRole('row').filter({ hasText: 'Pilot study of home monitoring' })
    ).toHaveCount(0)
    await decisionSource.click()
    await page.getByRole('option', { name: 'All decision sources', exact: true }).click()
    const pilotRow = page.getByRole('row').filter({ hasText: 'Pilot study of home monitoring' })
    await pilotRow.getByRole('button', { name: 'Use model decision', exact: true }).click()
    await page.getByRole('tab', { name: 'Needs review 1', exact: true }).click()
    await expect(page.locator('[data-slot="literature-selection-toolbar"]')).toHaveCount(0)
    await expect(page.getByText(/Decisions saved:/)).toHaveCount(0)
    await page
      .getByRole('row')
      .filter({ hasText: 'Pilot study of home monitoring' })
      .getByRole('button', { name: 'Exclude', exact: true })
      .click()
    await page.getByRole('tab', { name: 'Excluded 2', exact: true }).click()
    const tableBeforeSelection = await page.getByRole('table').boundingBox()
    const firstRowBeforeSelection = await page.getByRole('row').nth(1).boundingBox()
    await page.getByRole('checkbox', { name: 'Select all references', exact: true }).click()
    const selectedToolbar = page.locator('[data-slot="literature-selection-toolbar"]')
    await expect(selectedToolbar).toBeVisible()
    expect((await page.getByRole('table').boundingBox())!.y).toBe(tableBeforeSelection!.y)
    expect((await page.getByRole('row').nth(1).boundingBox())!.y).toBe(firstRowBeforeSelection!.y)
    await expect(page.getByRole('tab', { name: 'Excluded 2', exact: true })).toHaveCount(0)
    expect((await selectedToolbar.boundingBox())!.y).toBeLessThan(tableBeforeSelection!.y)
    await page.screenshot({ path: testInfo.outputPath('smart-selection-stable.png') })
    await selectedToolbar.getByRole('button', { name: 'More actions', exact: true }).click()
    await expect(
      page
        .locator('[data-slot="literature-selection-toolbar"]')
        .getByRole('button', { name: 'Re-evaluate selected', exact: true })
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('smart-selection-more.png') })
    await page.getByRole('button', { name: 'Move to collection', exact: true }).hover()
    const collectionChoices = page.locator('[data-slot="literature-batch-collection-popover"]')
    await expect(collectionChoices).toBeVisible()
    await collectionChoices.getByRole('button', { name: 'Manual collection', exact: true }).hover()
    await expect(collectionChoices).toBeVisible()
    await page.getByRole('button', { name: 'Add to project', exact: true }).hover()
    await expect(page.locator('[data-slot="literature-batch-project-popover"]')).toBeVisible()
    await expect(collectionChoices).toHaveCount(0)
    await page.getByRole('button', { name: 'Export', exact: true }).hover()
    await expect(page.getByRole('menuitem', { name: 'BibTeX', exact: true })).toBeVisible()
    await expect(page.locator('[data-slot="literature-batch-project-popover"]')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('smart-selection-hover-export.png') })
    await page.getByRole('menuitem', { name: 'RIS', exact: true }).hover()
    await expect(page.getByRole('menuitem', { name: 'RIS', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Actions', exact: true }).hover()
    await expect(
      page.getByRole('menuitem', { name: 'Complete metadata', exact: true })
    ).toBeVisible()
    const actionIcon = await page
      .getByRole('button', { name: 'Actions', exact: true })
      .locator('svg')
      .first()
      .boundingBox()
    const exportIcon = await page
      .getByRole('button', { name: 'Export', exact: true })
      .locator('svg')
      .first()
      .boundingBox()
    expect(actionIcon!.x).toBe(exportIcon!.x)
    await page.screenshot({ path: testInfo.outputPath('smart-selection-hover-actions.png') })
    await page.keyboard.press('Escape')

    await page.keyboard.press('Escape')
    await selectedToolbar.getByRole('button', { name: 'Clear selection', exact: true }).click()
    await expect(selectedToolbar).toHaveCount(0)
    expect((await page.getByRole('table').boundingBox())!.y).toBe(tableBeforeSelection!.y)
    await page.getByRole('checkbox', { name: 'Select all references', exact: true }).click()
    await page
      .locator('[data-slot="literature-selection-toolbar"]')
      .getByRole('button', { name: 'Include', exact: true })
      .click()
    await expect(page.getByRole('tab', { name: 'Included 4', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Collection actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Reset manual decisions', exact: true }).click()
    const reset = page.getByRole('region', { name: 'Reset manual decisions', exact: true })
    await expect(reset).toContainText('Reset manual decisions (2)?')
    await page.screenshot({ path: testInfo.outputPath('smart-reset-confirm.png') })
    await reset.getByRole('button', { name: 'Reset manual decisions', exact: true }).click()
    await page.getByRole('tab', { name: 'Needs review 1', exact: true }).click()
    const beforeSingle = classifiedInputs.length
    await page
      .getByRole('row')
      .filter({ hasText: 'Pilot study of home monitoring' })
      .getByRole('button', { name: 'Re-evaluate', exact: true })
      .click()
    await expect.poll(() => classifiedInputs.length).toBe(beforeSingle + 1)
    expect(classifiedInputs.at(-1)).toContain('Pilot study of home monitoring')
    await expect(page.locator('[data-slot="smart-reevaluation-dialog"]')).toHaveCount(0)
    await expect(
      page.getByRole('heading', { name: 'Collection decision', exact: true })
    ).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('smart-single-direct.png') })
    await page.getByRole('button', { name: 'Pilot study of home monitoring', exact: true }).click()
    const decisionSection = page
      .getByRole('heading', { name: 'Collection decision', exact: true })
      .locator('..')
    await expect(decisionSection.getByText('Inclusion criteria', { exact: true })).toBeVisible()
    await expect(decisionSection.getByText('Exclusion criteria', { exact: true })).toBeVisible()
    await expect(decisionSection).not.toContainText('"inclusion":')
    await page.screenshot({ path: testInfo.outputPath('smart-reference-rule.png') })
    await page.keyboard.press('Escape')

    await expect(
      panel.getByRole('button', { name: 'Update collection', exact: true })
    ).toBeEnabled()
    await page.getByRole('tab', { name: 'Included 2', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Select all references', exact: true }).click()
    const batchAction = page
      .locator('[data-slot="literature-selection-toolbar"]')
      .getByRole('button', { name: 'Re-evaluate selected', exact: true })
    const clickBatchAction = async (): Promise<void> => {
      await batchAction.click()
    }
    const beforeBatch = classifiedInputs.length
    await clickBatchAction()
    const batchDialog = page.getByRole('dialog', { name: 'Re-evaluate selected', exact: true })
    await expect(batchDialog).toContainText('selected references (2)')
    expect(classifiedInputs.length).toBe(beforeBatch)
    const cancel = batchDialog.getByRole('button', { name: 'Cancel', exact: true })
    const confirm = batchDialog.getByRole('button', { name: 'Re-evaluate selected', exact: true })
    expect((await cancel.boundingBox())!.x).toBeLessThan((await confirm.boundingBox())!.x)
    await cancel.click()
    expect(classifiedInputs.length).toBe(beforeBatch)
    await clickBatchAction()
    await batchDialog.getByRole('checkbox', { name: "Don't ask again", exact: true }).check()
    await confirm.click()
    await expect.poll(() => classifiedInputs.length).toBe(beforeBatch + 2)
    await expect(
      panel.getByRole('button', { name: 'Update collection', exact: true })
    ).toBeEnabled()
    await page.getByRole('checkbox', { name: 'Select all references', exact: true }).click()
    await clickBatchAction()
    await expect.poll(() => classifiedInputs.length).toBe(beforeBatch + 4)
    await expect(batchDialog).toHaveCount(0)
    await expect(
      panel.getByRole('button', { name: 'Update collection', exact: true })
    ).toBeEnabled()
    await panel.getByRole('button', { name: 'Collection actions', exact: true }).click()
    await page
      .getByRole('menuitem', { name: 'Restore re-analysis confirmation', exact: true })
      .click()
    await page.getByRole('checkbox', { name: 'Select all references', exact: true }).click()
    await clickBatchAction()
    await expect(batchDialog).toBeVisible()
    await batchDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
    await panel.getByRole('button', { name: 'Collection actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Run details', exact: true }).click()
    await expect(panel.locator('details').first()).toHaveAttribute('open', '')
    await expect(
      panel.getByText('This run used the current settings.', {
        exact: true
      })
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('smart-run-settings.png') })
    await panel.getByRole('button', { name: 'Collection rule', exact: true }).click()
    const savedTitles = await page.locator('tbody tr').allTextContents()
    const savedTableTop = (await page.locator('table').boundingBox())!.y
    const savedSearchLeft = (await page
      .getByRole('textbox', { name: 'Search references', exact: true })
      .boundingBox())!.x
    holdClassification = new Promise<void>((resolve) => {
      releaseClassification = resolve
    })
    await panel.getByRole('button', { name: 'Collection actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Re-evaluate all', exact: true }).click()
    await panel.getByRole('button', { name: 'Re-evaluate all', exact: true }).click()
    await expect(page.getByRole('progressbar', { name: 'Re-evaluate', exact: true })).toBeVisible()
    await expect(page.locator('tbody tr')).toHaveText(savedTitles)
    await expect(
      page.getByRole('tab', { name: 'Included 2', exact: true, includeHidden: true })
    ).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Needs review 1', exact: true })).toBeDisabled()
    await expect(
      page
        .locator('tbody tr')
        .first()
        .getByRole('button', { name: 'Evaluation details', exact: true })
    ).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Stop analysis', exact: true })).toBeEnabled()
    expect(Math.abs((await page.locator('table').boundingBox())!.y - savedTableTop)).toBeLessThan(2)
    expect(
      Math.abs(
        (await panel
          .getByRole('textbox', { name: 'Search references', exact: true, includeHidden: true })
          .boundingBox())!.x - savedSearchLeft
      )
    ).toBeLessThan(2)
    await page
      .locator('tbody tr')
      .first()
      .getByRole('button', { name: 'Evaluation details', exact: true })
      .click()
    await expect(
      page.getByText('Model scores for this rule, not paper quality or calibrated probabilities.')
    ).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.screenshot({ path: testInfo.outputPath('smart-reevaluate-progress.png') })
    await page.getByRole('button', { name: 'Manual collection', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Manual collection', exact: true })
    ).toBeVisible()
    releaseClassification!()
    holdClassification = undefined
    await expect(page.getByRole('progressbar', { name: 'Re-evaluate', exact: true })).toHaveCount(0)
    await expect(
      page.getByRole('heading', { name: 'Manual collection', exact: true })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Clinical trials', exact: true }).click()
    await expect(page.getByRole('progressbar', { name: 'Re-evaluate', exact: true })).toHaveCount(0)
    await expect(page.locator('tbody tr')).toHaveText(savedTitles)
    const inputsBeforeStop = classifiedInputs.length
    holdClassification = new Promise<void>((resolve) => {
      releaseClassification = resolve
    })
    await panel.getByRole('button', { name: 'Collection actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Re-evaluate all', exact: true }).click()
    await panel.getByRole('button', { name: 'Re-evaluate all', exact: true }).click()
    await expect.poll(() => classifiedInputs.length).toBeGreaterThan(inputsBeforeStop)
    await page.getByRole('button', { name: 'Stop analysis', exact: true }).click()
    await expect(panel.getByText(/Stopping analysis…|Stopped/)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('smart-analysis-stopping.png') })
    releaseClassification!()
    holdClassification = undefined
    await expect(page.getByRole('progressbar', { name: 'Re-evaluate', exact: true })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /^Included / })).toBeEnabled()
    failClassification = true
    await panel.getByRole('button', { name: 'Collection actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Re-evaluate all', exact: true }).click()
    await panel.getByRole('button', { name: 'Re-evaluate all', exact: true }).click()
    await panel.getByRole('button', { name: 'Analysis failed', exact: true }).click()
    await expect(
      page.getByText('Authentication failed. Check the classification service credentials.', {
        exact: true
      })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('tab', { name: 'Not evaluated 4', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('smart-failure-recovery.png') })
    failClassification = false
    await panel.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Included 2', exact: true })).toBeVisible()
    await page.evaluate(
      async ({ id, item }) => {
        await window.api.literature.transact({ kind: 'create-item', item })
        await window.api.literature.transact({
          kind: 'smart-collection',
          collectionId: id,
          action: 'refresh',
          offset: 0
        })
      },
      {
        id,
        item: literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: '31190621',
          abstract: ''
        })
      }
    )
    await expect(page.getByRole('tab', { name: 'Needs review 1', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Not evaluated 1', exact: true }).click()
    const missing = page.getByRole('row').filter({ hasText: '31190621' })
    await expect(missing.getByText('Not enough readable evidence')).toHaveCount(0)
    await expect(missing.getByLabel('Match score')).toHaveCount(0)
    await missing.getByRole('button', { name: 'Evaluation details', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Not evaluated by a model' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('smart-no-scores-details.png') })
    // Capacity regression uses disposable references and never classifies the added records.
    await page.keyboard.press('Escape')
    await page.evaluate(
      async (template) => {
        for (let i = 0; i < 1024; i++) {
          await window.api.literature.transact({
            kind: 'create-item',
            item: { ...template, title: `Capacity fixture ${i}` }
          })
        }
      },
      literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title: 'Capacity fixture',
        abstract: 'Local capacity evidence. '.repeat(40)
      })
    )
    await page.getByRole('tab', { name: 'Included 2', exact: true }).click()
    const capacityRow = page
      .getByRole('row')
      .filter({ hasText: 'Randomized trial of rehabilitation after stroke' })
    await expect(capacityRow).toBeVisible()
    await capacityRow.evaluate((row) => {
      const target = window as typeof window & { capacityTiming?: Promise<number> }
      target.capacityTiming = new Promise((resolve) => {
        row.addEventListener(
          'click',
          () => {
            const start = performance.now()
            const observer = new MutationObserver(() => {
              if (!row.isConnected) {
                observer.disconnect()
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve(performance.now() - start))
                )
              }
            })
            observer.observe(document.body, { childList: true, subtree: true })
          },
          { once: true }
        )
      })
    })
    await capacityRow.getByRole('button', { name: 'Exclude', exact: true }).click()
    await expect(capacityRow).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Included 1', exact: true })).toBeVisible()
    const clickToPaintMs = await page.evaluate(
      () => (window as typeof window & { capacityTiming: Promise<number> }).capacityTiming
    )
    await (
      await import('node:fs/promises')
    ).writeFile(
      testInfo.outputPath('single-decision-capacity.json'),
      JSON.stringify({ references: 1029, operation: 'exclude', clickToPaintMs })
    )
    await testInfo.attach('single-decision-capacity.json', {
      body: JSON.stringify({ references: 1029, operation: 'exclude', clickToPaintMs }),
      contentType: 'application/json'
    })

    // Repeated click-to-painted-result timings with 100 actual rows and several columns.
    await page.getByRole('tab', { name: /^Not evaluated/ }).click()
    await page.getByRole('combobox', { name: 'References per page', exact: true }).click()
    await page.getByRole('option', { name: '100', exact: true }).click()
    await expect(page.locator('tbody tr')).toHaveCount(100)
    await page.evaluate(() => {
      const target = window as typeof window & {
        longTasks: number[]
        longTaskObserver: PerformanceObserver
      }
      target.longTasks = []
      target.longTaskObserver = new PerformanceObserver((list) =>
        target.longTasks.push(...list.getEntries().map((entry) => entry.duration))
      )
      target.longTaskObserver.observe({ type: 'longtask', buffered: false })
    })
    const timings: number[] = []
    for (let i = 0; i < 12; i++) {
      const row = page.locator('tbody tr').filter({ hasText: 'Capacity fixture' }).first()
      await row.evaluate((element) => {
        const target = window as typeof window & { capacityTiming: Promise<number> }
        target.capacityTiming = new Promise((resolve) =>
          element.addEventListener(
            'click',
            () => {
              const start = performance.now()
              const observer = new MutationObserver(() => {
                if (!element.isConnected) {
                  observer.disconnect()
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve(performance.now() - start))
                  )
                }
              })
              observer.observe(document.body, { childList: true, subtree: true })
            },
            { once: true }
          )
        )
      })
      await row.getByRole('button', { name: 'Exclude', exact: true }).click()
      timings.push(
        await page.evaluate(
          () => (window as typeof window & { capacityTiming: Promise<number> }).capacityTiming
        )
      )
      await expect(page.locator('tbody tr')).toHaveCount(100)
    }
    const longTasks = await page.evaluate(() => {
      const target = window as typeof window & {
        longTasks: number[]
        longTaskObserver: PerformanceObserver
      }
      target.longTaskObserver.disconnect()
      return target.longTasks
    })
    const sorted = [...timings].sort((a, b) => a - b)
    const capacityMetrics = {
      references: 1029,
      visibleRows: 100,
      columns: await page.getByRole('columnheader').count(),
      samples: timings,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      longTasks
    }
    await (
      await import('node:fs/promises')
    ).writeFile(
      testInfo.outputPath('100-row-decision-performance.json'),
      JSON.stringify(capacityMetrics, null, 2)
    )
    await testInfo.attach('100-row-decision-performance.json', {
      path: testInfo.outputPath('100-row-decision-performance.json'),
      contentType: 'application/json'
    })

    holdAfter = 0
    holdClassification = new Promise((resolve) => {
      releaseClassification = resolve
    })
    for (let i = 0; i < 8; i++) await page.locator('tbody tr').nth(i).getByRole('checkbox').check()
    await page
      .locator('[data-slot="literature-selection-toolbar"]')
      .getByRole('button', { name: 'Re-evaluate selected', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: 'Re-evaluate selected', exact: true })
      .getByRole('button', { name: 'Re-evaluate selected', exact: true })
      .click()
    await expect(page.getByRole('button', { name: 'Stop analysis', exact: true })).toBeEnabled()
    await expect(page.locator('tbody tr')).toHaveCount(100)
    const stableRow = await page.locator('tbody tr').first().elementHandle()
    const batchInteractionMs: number[] = []
    for (let i = 0; i < 4; i++) {
      const toggle = page.getByRole('button', { name: 'Collection rule', exact: true })
      await toggle.evaluate((element) => {
        const target = window as typeof window & { batchTiming: Promise<number> }
        target.batchTiming = new Promise((resolve) =>
          element.addEventListener(
            'click',
            () => {
              const start = performance.now()
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve(performance.now() - start))
              )
            },
            { once: true }
          )
        )
      })
      await toggle.click()
      batchInteractionMs.push(
        await page.evaluate(
          () => (window as typeof window & { batchTiming: Promise<number> }).batchTiming
        )
      )
    }
    await testInfo.attach('batch-interaction-performance.json', {
      contentType: 'application/json',
      body: JSON.stringify({ samples: batchInteractionMs })
    })
    expect(await stableRow!.evaluate((row) => row.isConnected)).toBe(true)
    await expect(page.locator('tbody tr')).toHaveCount(100)
    await page.getByRole('button', { name: 'Stop analysis', exact: true }).click()
    releaseClassification?.()
    holdClassification = undefined
    await expect(page.getByRole('button', { name: 'Stop analysis', exact: true })).toHaveCount(0)

    // Use a separate seven-paper scope so recovery retries cannot evaluate the capacity library.
    const recovery = await page.evaluate(
      async (template) => {
        const source = await window.api.literature.transact({
          kind: 'create-collection',
          name: 'Recovery source'
        })
        const ids: string[] = []
        for (let i = 0; i < 7; i++) {
          const receipt = await window.api.literature.transact({
            kind: 'create-item',
            item: { ...template, title: `Recovery trial ${i}` }
          })
          ids.push(receipt.id)
          await window.api.literature.transact({
            kind: 'set-collection-item',
            collectionId: source.id,
            itemId: receipt.id,
            included: true
          })
        }
        const collection = await window.api.literature.transact({
          kind: 'create-smart-collection',
          name: 'Recovery trials',
          description: JSON.stringify({
            description: '',
            inclusion: 'Original trials',
            exclusion: ''
          }),
          scope: { kind: 'collection', id: source.id }
        })
        await window.api.literature.transact({
          kind: 'smart-collection',
          collectionId: collection.id,
          action: 'override',
          itemId: ids[0],
          decision: 'exclude',
          offset: 0
        })
        return { id: collection.id, manual: ids[0] }
      },
      literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title: 'Recovery trial',
        abstract: 'Readable evidence for a local recovery test.'
      })
    )
    holdClassification = new Promise((resolve) => {
      releaseClassification = resolve
    })
    holdAfter = classifiedInputs.length + 3
    await page.getByRole('button', { name: 'Recovery trials', exact: true }).click()
    await page.getByRole('tab', { name: /^Not evaluated/ }).click()
    await page.getByRole('button', { name: 'Update collection', exact: true }).click()
    const readRecovery = (target: typeof page): Promise<SmartCollectionView> =>
      target.evaluate(
        async (collectionId) =>
          (
            await window.api.literature.transact({
              kind: 'smart-collection',
              collectionId,
              action: 'read',
              offset: 0
            })
          ).smart!,
        recovery.id
      )
    await expect.poll(async () => (await readRecovery(page)).matches).toBe(2)
    // Progress remains interactive and the displayed rows do not get replaced by each checkpoint.
    await expect(page.getByRole('button', { name: 'Stop analysis', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Collection rule', exact: true }).click()
    await expect(page.getByText('Original trials', { exact: true })).toBeVisible()
    const beforeCrash = await readRecovery(page)
    expect(beforeCrash.run?.state).toBe('running')
    const restartPage = await app.restartAfterCrash({ force: true })
    releaseClassification?.()
    holdClassification = undefined
    const afterCrash = await readRecovery(restartPage)
    expect(afterCrash.run?.state).toBe('interrupted')
    expect(afterCrash.matches).toBe(2)
    expect(afterCrash.rows.find((row) => row.id === recovery.manual)?.override).toBe('exclude')
    const requestsBeforeRetry = classifiedInputs.length
    // A read after restart must not start any classification requests.
    await readRecovery(restartPage)
    expect(classifiedInputs.length).toBe(requestsBeforeRetry)
    await restartPage.evaluate(
      async (collectionId) =>
        window.api.literature.transact({
          kind: 'smart-collection',
          collectionId,
          action: 'refresh',
          offset: 0
        }),
      recovery.id
    )
    await expect.poll(async () => (await readRecovery(restartPage)).run?.state).toBe('completed')
    const recovered = await readRecovery(restartPage)
    expect(recovered.matches).toBe(6)
    expect(recovered.rows.find((row) => row.id === recovery.manual)?.override).toBe('exclude')
    expect(classifiedInputs.length - requestsBeforeRetry).toBe(4)
    await testInfo.attach('crash-recovery.json', {
      contentType: 'application/json',
      body: JSON.stringify({
        before: beforeCrash.run,
        interrupted: afterCrash.run,
        recovered: recovered.run,
        retried: classifiedInputs.length - requestsBeforeRetry,
        manualDecision: 'exclude'
      })
    })
  } finally {
    releaseClassification?.()
    await new Promise<void>((resolve) => {
      service.close(() => resolve())
      service.closeAllConnections()
    })
  }
})
