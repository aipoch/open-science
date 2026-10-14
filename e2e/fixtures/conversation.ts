import { expect } from '@playwright/test'
import type { Page } from 'playwright'

// Submission only; reply, streaming and failure expectations belong to the caller.
export const submitPromptViaUi = async (page: Page, prompt: string): Promise<void> => {
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}

// These permission scenarios test state transitions. DOM activation preserves the existing Windows
// conflict-toast workaround; pointer hit testing must continue using real Playwright clicks.
export const activatePermissionDecisionViaDom = async (
  page: Page,
  decision: 'allow' | 'deny'
): Promise<void> => {
  const button = page
    .getByTestId('permission-actions')
    .getByTestId(decision === 'allow' ? 'allow-primary' : 'deny-button')
  await expect(button).toBeEnabled()
  await button.evaluate((element: HTMLButtonElement) => {
    element.click()
  })
}
