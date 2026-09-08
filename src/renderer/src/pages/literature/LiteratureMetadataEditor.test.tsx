// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '../../../../shared/literature'
import { LiteratureMetadataEditor } from './LiteratureMetadataEditor'

afterEach(cleanup)

describe('LiteratureMetadataEditor', () => {
  it('locks every editable control while saving and retains the draft after failure', () => {
    const item = literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Original',
      typeFields: { volume: '1' },
      creators: [{ nameMode: 'person', givenName: 'A', familyName: 'B', creatorType: 'author' }],
      identifiers: [{ scheme: 'doi', value: '10.1234/example', isPrimary: true }]
    })
    const onSave = vi.fn()
    const props = { item, onSave, onCancel: vi.fn() }
    const { container, rerender } = render(<LiteratureMetadataEditor {...props} saving={false} />)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Draft title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: 'Draft title' }))
    rerender(<LiteratureMetadataEditor {...props} saving />)
    const controls = [...container.querySelectorAll('input, textarea, button')]
    expect(controls.length).toBeGreaterThan(15)
    expect(controls.filter((control) => !control.matches(':disabled'))).toEqual([])
    rerender(<LiteratureMetadataEditor {...props} saving={false} error="Save failed" />)
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Draft title')
    expect(screen.getByRole('alert').textContent).toBe('Save failed')
    expect(screen.getByRole('button', { name: 'Add author' }).matches(':disabled')).toBe(false)
    expect(screen.getByRole('combobox', { name: 'Reference type' }).matches(':disabled')).toBe(
      false
    )
  })
})
