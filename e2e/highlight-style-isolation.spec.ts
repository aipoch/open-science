import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProject, sendPrompt } from './certification/helpers'

test('keeps inherited text highlights inside annotation surfaces', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'Highlight isolation')
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'highlight-notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Highlight fixture\n\nDeterministic **nested** preview content.')
  })
  await expect(
    page.getByRole('button', { name: 'Remove attachment highlight-notes.md' })
  ).toBeVisible()
  await sendPrompt(page, 'Use the attached research notes.', 'Deterministic reply:')
  await page.getByRole('button', { name: 'Preview uploaded attachment highlight-notes.md' }).click()
  const preview = page.locator('[data-preview-text-annotation-surface]')
  const text = preview.locator('p').filter({ hasText: 'Deterministic nested preview content.' })
  await expect(text).toBeVisible()

  // Exercise the actual preview lifecycle so its dynamically generated rules are installed.
  const box = await text.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const rect = range.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  await page.mouse.move(box.x + 1, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Annotate', exact: true }).click()
  await page.getByRole('tab', { name: 'For me', exact: true }).click()
  await page.getByRole('button', { name: 'Bookmark', exact: true }).click()
  await expect(page.locator('#preview-personal-bookmark-highlight-yellow-style')).toHaveCount(1)
  await expect(page.locator('#preview-annotation-draft-style')).toHaveCount(1)

  for (const dark of [false, true]) {
    const results = await page.evaluate((dark) => {
      document.documentElement.classList.toggle('dark', dark)
      const fixture = document.createElement('div')
      document.body.appendChild(fixture)
      const cases = [
        ['data-annotation-surface', 'agent-annotation-draft'],
        ['data-annotation-surface', 'personal-bookmark'],
        ['data-annotation-surface', 'agent-annotation-reveal'],
        ['data-preview-text-annotation-surface', 'agent-annotation-reveal'],
        ['data-preview-text-annotation-surface', 'preview-personal-bookmark'],
        ['data-preview-text-annotation-surface', 'preview-personal-bookmark-highlight-yellow'],
        ['data-preview-text-annotation-surface', 'preview-annotation-draft'],
        ['pdf-text-layer', 'pdf-search-results'],
        ['pdf-text-layer', 'pdf-search-current']
      ]
      const results = cases.map(([surface, name]) => {
        const root = document.createElement('div')
        if (surface.startsWith('data-')) root.setAttribute(surface, '')
        else root.className = surface
        // Nested tokens must inherit the highlight; unrelated Notebook tokens must not.
        root.innerHTML = '<pre><code><span>Selected text</span></code></pre>'
        const outside = document.createElement('span')
        outside.textContent = 'Unrelated Notebook token'
        fixture.append(root, outside)
        const pseudo = `::highlight(${name})`
        return {
          name,
          root: getComputedStyle(root, pseudo).backgroundColor,
          nested: getComputedStyle(root.querySelector('span')!, pseudo).backgroundColor,
          outside: getComputedStyle(outside, pseudo).backgroundColor
        }
      })
      fixture.remove()
      return results
    }, dark)
    for (const result of results) {
      expect(result.nested, `${result.name}, dark=${dark}`).not.toBe('rgba(0, 0, 0, 0)')
      expect(result.nested, `${result.name}, dark=${dark}`).toBe(result.root)
      expect(result.outside, `${result.name}, dark=${dark}`).toBe('rgba(0, 0, 0, 0)')
    }
    // The actual Markdown descendant receives the saved bookmark style too.
    await expect
      .poll(() =>
        text.evaluate(
          (element) =>
            getComputedStyle(element, '::highlight(preview-personal-bookmark-highlight-yellow)')
              .backgroundColor
        )
      )
      .not.toBe('rgba(0, 0, 0, 0)')
  }
})
