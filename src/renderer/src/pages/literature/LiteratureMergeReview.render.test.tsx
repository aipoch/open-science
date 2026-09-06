// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import {
  LITERATURE_ITEM_TYPES,
  literatureItemInputSchema,
  type LiteratureItemType,
  type LiteratureItemView
} from '../../../../shared/literature'
import { LiteratureMergeReview } from './LiteratureMergeReview'

afterEach(cleanup)
const first: LiteratureItemView = {
  id: 'a',
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Cancer research',
    issuedYear: 2024,
    identifiers: [{ scheme: 'doi', value: '10.1234/example' }],
    creators: [
      { nameMode: 'person', givenName: 'Alex', familyName: 'Rivera', creatorType: 'author' }
    ]
  }),
  metadataRevision: 1,
  createdAt: Date.UTC(2024, 0, 1),
  updatedAt: 1,
  attachments: [],
  collectionIds: ['c'],
  projectIds: ['p']
}
const renderReview = (entries: LiteratureItemView[], disabled = false): void => {
  function Harness(): React.JSX.Element {
    const [survivorId, setSurvivor] = useState('a')
    const [sources, setSources] = useState<Record<string, string>>({})
    return (
      <LiteratureMergeReview
        entries={entries}
        survivorId={survivorId}
        onSurvivorChange={setSurvivor}
        sources={sources}
        onSourceChange={(field, id) => setSources({ ...sources, [field]: id })}
        fieldLabel={(field) =>
          field === 'issuedYear' ? 'Year' : field === 'language' ? 'Language' : field
        }
        creatorLabel={(item) =>
          item.creators
            .map((creator) =>
              creator.nameMode === 'person'
                ? `${creator.givenName} ${creator.familyName}`
                : creator.literalName
            )
            .join('; ')
        }
        itemTypeLabels={
          Object.fromEntries(
            LITERATURE_ITEM_TYPES.map((type) => [
              type,
              type === 'journalArticle' ? 'Journal article' : type
            ])
          ) as Record<LiteratureItemType, string>
        }
        disabled={disabled}
      />
    )
  }
  render(<Harness />)
}

it('shows differences by default, keeps reference context visible and lets each value be chosen', () => {
  const second = { ...first, id: 'b', item: { ...first.item, issuedYear: 2025 } }
  renderReview([first, second])
  expect(screen.getAllByText('10.1234/example')).toHaveLength(2)
  expect(screen.getAllByText('Alex Rivera')).toHaveLength(2)
  expect(screen.getAllByText('Date added')).toHaveLength(2)
  expect(screen.getByRole('table', { name: 'Compare references' })).not.toBeNull()
  expect(screen.queryByText('Reference type')).toBeNull()
  const choice = screen.getByRole('radio', {
    name: 'Use Year from reference 2'
  }) as HTMLInputElement
  fireEvent.click(choice)
  expect(choice.checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Show all fields' }))
  expect(screen.getByText('Reference type')).not.toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: 'Keep reference 2' }))
  expect(
    (screen.getByRole('radio', { name: 'Keep reference 2' }) as HTMLInputElement).checked
  ).toBe(true)
})

it('explicitly reports identical metadata and counts retained associations once', () => {
  renderReview([
    first,
    { ...first, id: 'b', createdAt: Date.UTC(2025, 0, 1), projectIds: ['p', 'p2'] }
  ])
  expect(screen.getByRole('status').textContent).toBe('Metadata is identical.')
  expect(screen.getByText('Attachments: 0 · Collections: 1 · Projects: 2')).not.toBeNull()
  expect(
    screen.getByText(
      'All attachments and their versions, tags, collection links and project links are kept.'
    )
  ).not.toBeNull()
})

it('locks survivor and field choices while merging', () => {
  renderReview([first, { ...first, id: 'b', item: { ...first.item, issuedYear: 2025 } }], true)
  expect(screen.getAllByRole('radio').every((input) => (input as HTMLInputElement).disabled)).toBe(
    true
  )
})
