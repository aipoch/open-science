import { expect } from 'vitest'

const expectDialogFormFieldClassName = (className: unknown): void => {
  const classes = String(className ?? '')
  const classList = classes.split(/\s+/)

  expect(classes).toContain('border-border-100')
  expect(classes).toContain('bg-bg-000')
  expect(classes).toContain('text-foreground')
  expect(classList).toContain('placeholder:text-foreground')
  expect(classes).toContain('focus-visible:border-ring')
  expect(classes).toContain('focus-visible:ring-2')
  expect(classes).toContain('focus-visible:ring-ring/25')
  expect(classes).not.toContain('focus:border-accent')
}

export { expectDialogFormFieldClassName }
