// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { fireEvent, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { OutputComparisonDetails, OutputComparisonSettings } from './OutputComparison'
import { DEFAULT_OUTPUT_COMPARISON_POLICY } from '../../../../shared/output-comparison'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {})

it('explains the 16-bit error scale and does not round tiny differences to zero', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <OutputComparisonDetails
          report={{
            schemaVersion: 1,
            comparator: 'open-science-content-v1',
            policy: DEFAULT_OUTPUT_COMPARISON_POLICY,
            policyChecksum: 'a'.repeat(64),
            expectedChecksum: 'b'.repeat(64),
            actualChecksum: 'c'.repeat(64),
            kind: 'image',
            outcome: 'different',
            image: {
              width: 100,
              height: 100,
              bitDepth: 16,
              changedPixels: 1,
              changedPixelRatio: 0.0001,
              rmse: 0.000001,
              maxDifference: 1 / 257
            }
          }}
        />
      )
    )
    expect(container.textContent).toContain('16-bit samples retain their precision.')
    const label = [...container.querySelectorAll('dt')].find(
      (item) => item.textContent === 'Pixel RMSE'
    )!
    expect(label.nextElementSibling?.textContent).toBe('0.000001')
  } finally {
    await act(async () => root.unmount())
  }
})

it('requires applying valid rules and prevents silently using unapplied edits', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onChange = vi.fn(),
    onPendingChange = vi.fn()
  try {
    await act(async () =>
      root.render(
        <OutputComparisonSettings
          value={DEFAULT_OUTPUT_COMPARISON_POLICY}
          onChange={onChange}
          onPendingChange={onPendingChange}
        />
      )
    )
    const keys = container.querySelector<HTMLInputElement>('input[name="keys"]')!
    container.querySelector('details')!.open = true
    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(button.disabled).toBe(true)
    await act(async () => fireEvent.input(keys, { target: { value: 'id, id' } }))
    expect(onPendingChange).toHaveBeenLastCalledWith(true)
    await act(async () => fireEvent.submit(container.querySelector('form')!))
    expect(onChange).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(keys.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(keys)
    expect(document.getElementById(keys.getAttribute('aria-describedby')!)?.textContent).toContain(
      'unique column names'
    )
    await act(async () => fireEvent.input(keys, { target: { value: 'sample' } }))
    expect(keys.getAttribute('aria-invalid')).toBe('false')
    await act(async () => fireEvent.submit(container.querySelector('form')!))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        table: { ...DEFAULT_OUTPUT_COMPARISON_POLICY.table, keys: ['sample'] }
      })
    )
    expect(onPendingChange).toHaveBeenLastCalledWith(false)
    expect(button.disabled).toBe(true)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it('explains every field on focus without editing or submitting and preserves input labels', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onChange = vi.fn(),
    onPendingChange = vi.fn()
  try {
    await act(async () =>
      root.render(
        <OutputComparisonSettings
          value={DEFAULT_OUTPUT_COMPARISON_POLICY}
          onChange={onChange}
          onPendingChange={onPendingChange}
        />
      )
    )
    container.querySelector('details')!.open = true
    expect(within(container).getByLabelText('Row keys (comma-separated)').tagName).toBe('INPUT')
    expect(within(container).getByLabelText('Scientific comparison').getAttribute('role')).toBe(
      'combobox'
    )
    const helps = container.querySelectorAll<HTMLButtonElement>('[data-slot="field-help"]')
    expect(helps).toHaveLength(7)
    for (const help of helps) {
      await act(async () => help.focus())
      expect(document.querySelector('[role="tooltip"]')?.textContent?.length).toBeGreaterThan(30)
      await act(async () => {
        fireEvent.keyDown(help, { key: 'Escape' })
        help.blur()
      })
    }
    expect(onChange).not.toHaveBeenCalled()
    expect(onPendingChange).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it('uses the shared Select and saves the chosen scientific criteria through FormData', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onChange = vi.fn(),
    onPendingChange = vi.fn()
  try {
    await act(async () =>
      root.render(
        <OutputComparisonSettings
          value={DEFAULT_OUTPUT_COMPARISON_POLICY}
          onChange={onChange}
          onPendingChange={onPendingChange}
        />
      )
    )
    container.querySelector('details')!.open = true
    const choose = async (name: string): Promise<void> => {
      await act(async () =>
        fireEvent.keyDown(container.querySelector('[data-slot="select-trigger"]')!, {
          key: 'ArrowDown'
        })
      )
      const option = within(document.body).getByRole('option', { name })
      await act(async () => fireEvent.click(option))
    }
    await choose('Differential expression')
    await act(async () =>
      fireEvent.input(container.querySelector('input[name="geneColumn"]')!, {
        target: { value: 'gene_id' }
      })
    )
    expect(container.querySelectorAll('[data-slot="field-help"]')).toHaveLength(15)
    expect(onPendingChange).toHaveBeenLastCalledWith(true)
    await choose('Single-cell clusters')
    expect(container.querySelectorAll('[data-slot="field-help"]')).toHaveLength(10)
    expect(container.querySelector('input[name="geneColumn"]')).toBeNull()
    for (const [name, value] of [
      ['cellColumn', 'barcode'],
      ['clusterColumn', 'cluster'],
      ['minimumAdjustedRand', '0.9']
    ]) {
      await act(async () =>
        fireEvent.input(container.querySelector(`input[name="${name}"]`)!, { target: { value } })
      )
    }
    await choose('Differential expression')
    expect(container.querySelector<HTMLInputElement>('input[name="geneColumn"]')!.value).toBe(
      'gene_id'
    )
    await choose('Single-cell clusters')
    expect(container.querySelector<HTMLInputElement>('input[name="cellColumn"]')!.value).toBe(
      'barcode'
    )
    expect(new FormData(container.querySelector('form')!).get('scientificKind')).toBe(
      'cell-clusters'
    )
    await act(async () => fireEvent.submit(container.querySelector('form')!))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scientific: {
          kind: 'cell-clusters',
          cellColumn: 'barcode',
          clusterColumn: 'cluster',
          minimumAdjustedRand: 0.9
        }
      })
    )
    await choose('None')
    await act(async () => fireEvent.submit(container.querySelector('form')!))
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_OUTPUT_COMPARISON_POLICY)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it('identifies empty numbers and strict scientific bounds without applying invalid rules', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onChange = vi.fn()
  try {
    await act(async () =>
      root.render(
        <OutputComparisonSettings
          value={{
            ...DEFAULT_OUTPUT_COMPARISON_POLICY,
            scientific: {
              kind: 'differential-expression',
              geneColumn: 'gene',
              effectColumn: 'lfc',
              adjustedPColumn: 'padj',
              contrast: 'treated / control',
              adjustedPThreshold: 0.05,
              minimumAbsoluteEffect: 1,
              minimumGeneJaccard: 0.9,
              minimumDirectionAgreement: 0.95
            }
          }}
          onChange={onChange}
          onPendingChange={() => {}}
        />
      )
    )
    container.querySelector('details')!.open = true
    const absolute = container.querySelector<HTMLInputElement>('input[name="absolute"]')!
    const threshold = container.querySelector<HTMLInputElement>('input[name="adjustedPThreshold"]')!
    await act(async () => {
      fireEvent.input(absolute, { target: { value: '' } })
      fireEvent.input(threshold, { target: { value: '1' } })
      fireEvent.submit(container.querySelector('form')!)
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(absolute)
    expect(absolute.getAttribute('aria-invalid')).toBe('true')
    expect(threshold.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(threshold.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Enter a number greater than 0 and less than 1.'
    )
    await act(async () => {
      fireEvent.input(absolute, { target: { value: '0' } })
      fireEvent.input(threshold, { target: { value: '0.05' } })
      fireEvent.submit(container.querySelector('form')!)
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
