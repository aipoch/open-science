import {
  ApplicationCommandError,
  toApplicationCommandErrorEnvelope,
  unwrapApplicationCommandOutcome
} from '../../../../../shared/application-command-contract'
import { expect, it } from 'vitest'
import { createInstance } from 'i18next'
import { scheduleErrorText, scheduleReasonText } from './schedule-reason'

it('renders stable translated reasons without exposing unknown exception text', async () => {
  const i18n = createInstance()
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: {} })
  expect(scheduleReasonText('expired', i18n.t)).toContain('missed')
  const message = scheduleReasonText('Error: secret internal path /private/example', i18n.t)
  expect(message).toBe('This run failed. Open its results for details.')
  expect(scheduleErrorText(new Error('SQLITE_BUSY /private/example'), i18n.t)).toBe(
    'Could not complete the schedule request. Try again.'
  )
  expect(
    scheduleErrorText(
      new ApplicationCommandError(
        'schedule-conflict',
        'The schedule changed. Reopen it before editing.'
      ),
      i18n.t
    )
  ).toBe('This task changed while you were editing.')
  expect(scheduleErrorText(new Error('Conversation not found'), i18n.t)).toBe(
    'Conversation not found'
  )
})

it('preserves actionable schedule error codes through the transport envelope', async () => {
  const i18n = createInstance()
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: {} })
  for (const [code, text] of [
    ['schedule-limit-reached', 'Increase it'],
    ['schedule-no-future-run', 'Choose a future']
  ] as const) {
    const envelope = toApplicationCommandErrorEnvelope(
      new ApplicationCommandError(code, '/private/internal')
    )
    expect(scheduleErrorText(envelope, i18n.t)).toContain(text)
    try {
      unwrapApplicationCommandOutcome({ ok: false, error: envelope })
    } catch (error) {
      expect(scheduleErrorText(error, i18n.t)).toBe(scheduleErrorText(envelope, i18n.t))
    }
  }
})
