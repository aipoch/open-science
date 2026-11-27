const multiplierFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
  useGrouping: false
})

export const formatLabModelMultiplier = (multiplier: number): string =>
  `${multiplierFormat.format(multiplier)}x`
