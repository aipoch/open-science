// @vitest-environment jsdom
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { SpecialistSkillConflictChoices } from './SpecialistSkillConflictChoices'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SpecialistSkillConflictChoices', () => {
  it('shows current impact and requires an explicit version choice', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onChange = vi.fn()
    act(() => {
      root.render(
        <SpecialistSkillConflictChoices
          conflicts={[
            {
              id: 'biomedical-search',
              version: '2.0.0',
              disposition: 'conflict',
              files: ['SKILL.md'],
              conflict: {
                localId: 'personal-biomedical-search',
                installedVersion: '1.0.0',
                installedContentHash: 'a'.repeat(64),
                mainEnabled: true,
                specialists: [{ id: 'reviewer', name: 'Literature Reviewer' }]
              }
            }
          ]}
          resolutions={{}}
          onChange={onChange}
        />
      )
    })

    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    expect(radios).toHaveLength(2)
    expect(radios.every((radio) => !radio.checked)).toBe(true)
    expect(container.textContent).toContain('Affected now: Main Agent, Literature Reviewer')
    fireEvent.click(radios[1])
    expect(onChange).toHaveBeenCalledWith('biomedical-search', 'use-incoming')

    act(() => root.unmount())
    container.remove()
  })
})
