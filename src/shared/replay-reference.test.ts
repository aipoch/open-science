import { describe, expect, it } from 'vitest'
import { selectedSessionQuote } from './replay-reference'

describe('selectedSessionQuote', () => {
  it('quotes only captured step content and retains input-only context', () => {
    const quote = selectedSessionQuote({
      sourceTitle: 'Original\nresearch',
      stepTitle: 'Analysis input',
      phase: 'input',
      excerpt: 'An older excerpt must not replace the captured records.',
      records: [
        { scope: 'background', text: 'Unselected result', status: 'recorded', truncated: false },
        { scope: 'step', text: 'Selected input', status: 'recorded', truncated: false },
        { scope: 'step', text: '', status: 'unavailable', truncated: false }
      ]
    })

    expect(quote).toBe(
      'Session: Original research\nAnalysis input\nOnly the input was visible; no output is included.\nSelected input\n\nContent unavailable.'
    )
  })

  it('marks bounded or already truncated selections as incomplete', () => {
    const quote = selectedSessionQuote({ sourceTitle: 'Research', excerpt: 'x'.repeat(300) }, 120)
    expect(quote).toHaveLength(120)
    expect(quote).toContain('[Selected content is incomplete or truncated.]')

    expect(
      selectedSessionQuote({
        sourceTitle: 'Research',
        excerpt: '',
        records: [{ scope: 'step', text: 'Partial', status: 'recorded', truncated: true }]
      })
    ).toBe('Session: Research\nPartial\n[Selected content is incomplete or truncated.]')
  })
})
