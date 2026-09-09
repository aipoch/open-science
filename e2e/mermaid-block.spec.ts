import { expect, type Page } from '@playwright/test'

import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Mermaid block project'
const MERMAID_PROMPT = 'Render the mermaid block journey.'

const openMermaidConversation = async (app: {
  completeOnboarding: () => Promise<Page>
  configureFakeAgent: () => Promise<Page>
}): Promise<Page> => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(MERMAID_PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()

  const conversation = page.getByRole('region', { name: 'Conversation' })
  await expect(
    conversation.locator('[data-streamdown="mermaid-block"] [data-streamdown="mermaid"] svg')
  ).toBeVisible()
  return page
}

test('keeps a wheel-zoomed mermaid diagram clipped to the block', async ({ app }) => {
  const page = await openMermaidConversation(app)
  const block = page.locator('[data-streamdown="mermaid-block"]')

  // The block disables streamdown's pan-zoom buttons, but the wheel handler stays attached.
  const diagram = block.locator('[data-streamdown="mermaid"]')
  await diagram.hover()
  for (let step = 0; step < 12; step += 1) {
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(50)
  }
  await page.waitForTimeout(300)

  // Guard against a vacuous pass: the wheel zoom must have actually engaged.
  const scale = await block.evaluate((el) => {
    const viewport = el.querySelector('[role="application"]')
    return viewport instanceof HTMLElement ? viewport.style.transform : ''
  })
  expect(scale, 'wheel zoom did not engage').toContain('scale(')

  // Hit-test just past the block's right edge: the zoomed diagram must be clipped by the
  // pan-zoom viewport instead of painting into the surrounding transcript.
  const leaks = await block.evaluate((el) => {
    const describe = (hit: Element | null): string | null =>
      hit
        ? `${hit.tagName}[${hit.getAttribute('data-streamdown') ?? hit.getAttribute('role') ?? hit.className.toString().slice(0, 40)}]`
        : null
    const rect = el.getBoundingClientRect()
    const x = rect.right + 6
    if (x >= window.innerWidth) return { leak: false, reason: 'no room' }
    const hits = [0.25, 0.5, 0.75].map((ratio) => {
      const hit = document.elementFromPoint(x, rect.top + rect.height * ratio)
      return { contained: hit !== null && el.contains(hit), at: describe(hit) }
    })
    const viewport = el.querySelector('[data-streamdown="mermaid"] [role="application"]')
    const svg = el.querySelector('[data-streamdown="mermaid"] svg')
    return {
      leak: hits.some((hit) => hit.contained),
      hits,
      blockRight: rect.right,
      viewportTransform: viewport ? (viewport as HTMLElement).style.transform : null,
      viewportOverflow: viewport
        ? getComputedStyle(viewport.parentElement as HTMLElement).overflow
        : null,
      svgRect: svg?.getBoundingClientRect().toJSON()
    }
  })
  expect(
    leaks,
    `zoomed diagram paints past the block right edge: ${JSON.stringify(leaks)}`
  ).toMatchObject({ leak: false })
})

test('frames the mermaid source view without corner bleed and restores the diagram', async ({
  app
}) => {
  const page = await openMermaidConversation(app)
  const block = page.locator('[data-streamdown="mermaid-block"]')

  await block.hover()
  await block.getByRole('button', { name: 'View source' }).click()

  const sourceView = block.locator('[data-mermaid-source-view]')
  await expect(sourceView).toBeVisible()
  // Line-number gutter: one gutter span per source line, same class as fenced code blocks.
  await expect(sourceView.locator('code > span').first()).toHaveClass(/counter\(line\)/)
  await expect(sourceView).toContainText('graph LR')

  // Hit-test each rounded-corner cutout: paint there must belong behind the block, never to
  // the square-cornered source panel.
  const cornerBleed = await block.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return [
      [rect.left + 2, rect.top + 2],
      [rect.right - 2, rect.top + 2],
      [rect.left + 2, rect.bottom - 2],
      [rect.right - 2, rect.bottom - 2]
    ].some(([x, y]) => {
      const hit = document.elementFromPoint(x, y)
      return hit !== null && hit.closest('[data-mermaid-source-view]') !== null
    })
  })
  expect(cornerBleed, 'source view paint leaks outside the block frame corners').toBe(false)

  await block.hover()
  await block.getByRole('button', { name: 'View diagram' }).click()
  await expect(block.locator('[data-streamdown="mermaid"] svg')).toBeVisible()
  await expect(sourceView).toHaveCount(0)
})
