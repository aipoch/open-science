import { expect, it } from 'vitest'
import { sql, joinSql } from '../src/sql.js'
it('binds nested lists and hostile text without turning values into SQL', () => {
  const value = "'); DROP TABLE Journal; --"
  const statement = sql`SELECT * FROM Journal WHERE id IN (${joinSql(['first', value])}) AND ${sql`name = ${'second'}`}`
  expect(statement).toEqual({
    text: 'SELECT * FROM Journal WHERE id IN (?,?) AND name = ?',
    values: ['first', value, 'second']
  })
  expect(() => joinSql([])).toThrow('empty SQL list')
})
