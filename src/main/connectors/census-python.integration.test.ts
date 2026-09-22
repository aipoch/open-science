import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Explicit opt-in: uses scientific Python packages, but never accesses Census network data.
const python = process.env.OPEN_SCIENCE_CENSUS_TEST_PYTHON
it.skipIf(!python)(
  'executes the shipped Python bridge against fixed Arrow fixtures',
  async () => {
    const { stderr } = await promisify(execFile)(
      python!,
      [join(__dirname, 'fixtures/census-contract.py')],
      { timeout: 60_000 }
    )
    expect(stderr).toContain('Ran 18 tests')
    expect(stderr).toContain('OK')
  },
  65_000
)
