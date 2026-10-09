import type { Locator } from '@playwright/test'

export async function askReplayStep(replay: Locator): Promise<void> {
  await replay.getByRole('button', { name: 'Question options', exact: true }).click()
  await replay.page().getByRole('button', { name: 'Ask about this step', exact: true }).click()
}

export async function discussReplayResearch(replay: Locator): Promise<void> {
  await replay.getByRole('button', { name: 'Question options', exact: true }).click()
  await replay
    .page()
    .getByRole('button', { name: 'Discuss the entire research', exact: true })
    .click()
}

export async function openReplayMaterial(replay: Locator, name: string): Promise<void> {
  if (await replay.isVisible()) await replay.getByTestId('replay-information-trigger').click()
  await replay
    .page()
    .locator('[role="group"][aria-label="Research materials"]:visible')
    .getByRole('button', { name, exact: true })
    .click()
}

export async function openReplayFiles(replay: Locator): Promise<void> {
  await replay.getByTestId('replay-information-trigger').click()
  await replay.page().getByRole('button', { name: 'View files', exact: true }).click()
}

export async function chooseReplayConversation(replay: Locator): Promise<void> {
  await replay.getByRole('button', { name: 'Question options', exact: true }).click()
  await replay
    .page()
    .getByRole('button', { name: 'Add to another conversation…', exact: true })
    .click()
}
