import { expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'

type ProbeWindow = Window & {
  collapseProbe: {
    mark: (label: string) => void
    stop: () => Record<string, unknown>[]
  }
}

test.use({ windowMode: 'normal' })

const scenarios = [
  { name: 'group-scrollbar-recovery', gap: 20, groupCollapse: true, cycle: true, scrollbar: true },
  { name: 'group-rapid-toggle', gap: 20, groupCollapse: true, cycle: true, rapid: true },
  { name: 'group-cycle-5px', gap: 5, groupCollapse: true, cycle: true },
  { name: 'group-cycle-20px', gap: 20, groupCollapse: true, cycle: true },
  { name: 'group-cycle-100px', gap: 100, groupCollapse: true, cycle: true },
  { name: 'group-cycle-at-bottom', gap: 0, groupCollapse: true, cycle: true },
  { name: 'detail-cycle-20px', gap: 20, cycle: true },
  { name: 'group-clamps-at-bottom', gap: 0, groupCollapse: true },
  { name: 'group-clamps-near-bottom', gap: 100, groupCollapse: true },
  { name: 'detail-clamps-near-bottom', gap: 100 },
  { name: 'group-reduced-motion', gap: 20, groupCollapse: true, cycle: true, reducedMotion: true }
] as const

for (const scenario of scenarios) {
  test(`preserves reading position when toggling a running tool: ${scenario.name}`, async ({
    app
  }, testInfo) => {
    test.setTimeout(180_000)
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await page.setViewportSize({ width: 1100, height: 1100 })
    await page.emulateMedia({
      reducedMotion: 'reducedMotion' in scenario ? 'reduce' : 'no-preference'
    })
    await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    try {
      const storage = await page.evaluate(() => window.api.storage.getInfo())
      // The harness owns a temporary profile; never exercise the operator's real conversations.
      expect(storage.dataRoot).toContain('open-science-electron-e2e-')
      await writeFile(testInfo.outputPath('storage.json'), JSON.stringify(storage, null, 2))
      await createProjectViaUi(page, `Collapse probe ${scenario.name}`)
      await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
      const gateRoot = await app.createTestDirectory('collapse-gates')
      const gates = { grow: join(gateRoot, 'grow'), finish: join(gateRoot, 'finish') }
      await page
        .getByRole('textbox', { name: 'Ask anything' })
        .fill(`Run the tool collapse scroll probe. Probe gates: ${JSON.stringify(gates)}`)
      await page.getByRole('button', { name: 'Send message' }).click()
      const group = page.locator('[data-message-id="activity-group-e2e-collapse-probe"]')
      await expect(group).toBeVisible()
      // Finish presenting the introductory message before positioning the reader.
      await expect(
        page.getByText(
          'Collapse probe paragraph 59. Keep this reading context above the running tool.',
          { exact: true }
        )
      ).toBeAttached()

      await group.getByRole('button', { name: /^Using tool:/ }).click()
      const button = group.locator('[data-testid="tool-chip"][aria-expanded]')
      const collapseButton =
        'groupCollapse' in scenario ? group.getByTestId('tool-group-header') : button
      await expect(button).toBeVisible()
      await expect(button).toHaveAttribute('aria-expanded', 'false')
      await button.click()
      await expect(button).toHaveAttribute('aria-expanded', 'true')
      await expect(group.getByTestId('tool-details')).toBeVisible()
      await page.waitForTimeout(700)
      if ('cycle' in scenario) {
        await collapseButton.click()
        await expect(collapseButton).toHaveAttribute('aria-expanded', 'false')
        await page.waitForTimeout(700)
      }
      const viewport = page.locator('[data-slot="message-scroller-viewport"]')
      if ('scrollbar' in scenario) {
        // The product hides the native thumb; expose it to exercise its real input path.
        await viewport.evaluate((e) => {
          e.style.scrollbarWidth = 'auto'
          e.style.scrollbarColor = 'auto'
        })
      }
      const toEnd = page.getByRole('button', { name: 'Scroll to end', exact: true })
      if ((await toEnd.getAttribute('data-active')) === 'true') await toEnd.click()
      await expect
        .poll(() => viewport.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop))
        .toBeLessThanOrEqual(1)
      await page.waitForTimeout(500)
      if (scenario.gap) {
        const box = await viewport.boundingBox()
        // Keep wheel input outside the nested tool-code scroller.
        await page.mouse.move(box!.x + 10, box!.y + box!.height / 2)
        await page.mouse.wheel(0, -scenario.gap)
        await expect
          .poll(() => viewport.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop))
          .toBeGreaterThan(scenario.gap - 5)
        await expect(toEnd).toHaveAttribute('data-active', 'true')
      }
      // Let wheel momentum, streaming presentation and the expand tween settle before sampling.
      await page.waitForTimeout(700)
      await expect(collapseButton).toBeInViewport()
      await page.evaluate(
        ({ groupCollapse }) => {
          const viewport = document.querySelector<HTMLElement>(
            '[data-slot="message-scroller-viewport"]'
          )!
          const group = document.querySelector<HTMLElement>(
            '[data-message-id="activity-group-e2e-collapse-probe"]'
          )!
          const button = group.querySelector<HTMLElement>(
            groupCollapse
              ? '[data-testid="tool-group-header"]'
              : '[data-testid="tool-chip"][aria-expanded]'
          )!
          const records: Record<string, unknown>[] = []
          const start = performance.now()
          const geometry = (): Record<string, number> => ({
            t: performance.now() - start,
            scrollTop: viewport.scrollTop,
            gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
            buttonTop: button.getBoundingClientRect().top,
            groupHeight: group.getBoundingClientRect().height
          })
          let frame = 0
          const sample = (): void => {
            records.push({ kind: 'frame', ...geometry() })
            frame = requestAnimationFrame(sample)
          }
          sample()
          Object.assign(window, {
            collapseProbe: {
              mark: (kind: string) => records.push({ kind, ...geometry() }),
              stop: () => {
                cancelAnimationFrame(frame)
                return records
              }
            }
          })
        },
        { groupCollapse: 'groupCollapse' in scenario }
      )
      const mark = (label: string): Promise<void> =>
        page.evaluate((label) => (window as ProbeWindow).collapseProbe.mark(label), label)
      const toggle = async (): Promise<void> => {
        const box = await collapseButton.boundingBox()
        // Use a real pointer without Playwright scrolling the target into view first.
        await page.mouse.click(box!.x + 80, box!.y + box!.height / 2)
      }
      await mark('initial')
      if ('cycle' in scenario) {
        await toggle()
        await expect(collapseButton).toHaveAttribute('aria-expanded', 'true')
        await page.waitForTimeout(700)
      }
      if ('rapid' in scenario) {
        for (let i = 0; i < 4; i++) {
          await toggle()
          await page.waitForTimeout(70)
        }
        await expect(collapseButton).toHaveAttribute('aria-expanded', 'true')
        await page.waitForTimeout(700)
      }
      await mark('before-collapse')
      await toggle()
      await expect(collapseButton).toHaveAttribute('aria-expanded', 'false')
      await page.waitForTimeout(700)
      await mark('collapsed')
      await writeFile(gates.grow, '')
      await expect(
        page.getByText('After collapse growth 7. The tool is still running.', { exact: true })
      ).toBeAttached()
      await page.waitForTimeout(700)
      await mark('grown')
      const records = await page.evaluate(() => (window as ProbeWindow).collapseProbe.stop())
      await writeFile(
        testInfo.outputPath('geometry.json'),
        JSON.stringify({ scenario, records }, null, 2)
      )
      await testInfo.attach('scroll-geometry', {
        path: testInfo.outputPath('geometry.json'),
        contentType: 'application/json'
      })
      const initial = records.find((r) => r.kind === 'initial')!
      const click = records.find((r) => r.kind === 'before-collapse')!
      const collapsed = records.find((r) => r.kind === 'collapsed')!
      const grown = records.find((r) => r.kind === 'grown')!
      expect(Math.abs(Number(initial.gap) - scenario.gap)).toBeLessThanOrEqual(2)
      expect(Number(click.groupHeight) - Number(collapsed.groupHeight)).toBeGreaterThan(300)
      const frames = records.filter((r) => r.kind === 'frame' && Number(r.t) < Number(collapsed.t))
      expect(frames.length).toBeGreaterThan(2)
      if ('cycle' in scenario) {
        // The old position remains legal after this expand/collapse cycle, including every painted frame.
        expect(
          Math.max(...frames.map((r) => Math.abs(Number(r.scrollTop) - Number(initial.scrollTop))))
        ).toBeLessThanOrEqual(1)
        expect(Math.abs(Number(collapsed.gap) - Number(initial.gap))).toBeLessThanOrEqual(1)
      } else {
        // Shrink beyond the current position may clamp toward the new bottom, but must never first navigate down.
        const collapseFrames = frames.filter((r) => Number(r.t) >= Number(click.t))
        let previous = Number(click.scrollTop)
        for (const frame of collapseFrames) {
          expect(Number(frame.scrollTop)).toBeLessThanOrEqual(previous + 1)
          previous = Number(frame.scrollTop)
        }
        expect(Math.abs(Number(collapsed.gap))).toBeLessThanOrEqual(2)
      }
      expect(Number(grown.scrollTop)).toBe(Number(collapsed.scrollTop))
      await expect(toEnd).toHaveAttribute('data-active', 'true')
      if ('scrollbar' in scenario) {
        const bounds = await viewport.boundingBox()
        const metrics = await viewport.evaluate((e) => ({
          top: e.scrollTop,
          height: e.scrollHeight,
          client: e.clientHeight,
          width: e.clientWidth,
          outerWidth: (e as HTMLElement).offsetWidth
        }))
        expect(metrics.outerWidth - metrics.width).toBeGreaterThan(0)
        const scrollbarX =
          bounds!.x +
          ((metrics.width + (metrics.outerWidth - metrics.width) / 2) * bounds!.width) /
            metrics.outerWidth
        const thumbMiddle = ((metrics.top + metrics.client / 2) / metrics.height) * bounds!.height
        await page.mouse.move(scrollbarX, bounds!.y + thumbMiddle)
        await page.mouse.down()
        for (let step = 1; step <= 12; step++) {
          await page.mouse.move(
            scrollbarX,
            bounds!.y + thumbMiddle + ((bounds!.height - 1 - thumbMiddle) * step) / 12
          )
          // Native scrollbar drags need compositor frames between pointer updates.
          await page.waitForTimeout(30)
        }
        await page.mouse.up()
      } else {
        await toEnd.click()
      }
      await expect
        .poll(() => viewport.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop))
        .toBeLessThanOrEqual(1)
      await writeFile(gates.finish, '')
      await expect(page.getByText('Collapse probe complete.', { exact: true })).toBeAttached()
      await expect
        .poll(() => viewport.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop))
        .toBeLessThanOrEqual(1)
    } finally {
      await page.context().tracing.stop({ path: testInfo.outputPath('trace.zip') })
    }
  })
}
