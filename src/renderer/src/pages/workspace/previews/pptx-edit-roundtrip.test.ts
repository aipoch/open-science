import { describe, expect, it } from 'vitest'

import { applyOperations, readOutline } from '../../../../../shared/pptx-edit'
import { EVERY_OPERATION } from '../../../../../shared/pptx-edit/every-operation.test-support'
import { createDeckFixture } from '../../../../../shared/pptx-edit/pptx-fixture.test-support'
import { validateOfficePackage } from './office-package'

describe('edited presentations pass package validation', () => {
  it('accepts a deck produced by every operation kind', async () => {
    const { bytes, slideCount } = applyOperations(createDeckFixture(), EVERY_OPERATION)
    await expect(validateOfficePackage(bytes, 'pptx')).resolves.toBeUndefined()
    expect(readOutline(bytes).slides).toHaveLength(slideCount)
  })
})
