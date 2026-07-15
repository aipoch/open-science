type OclModule = typeof import('openchemlib')

// Lays out an MDL reaction as a horizontal row of component depictions separated by "+" and an arrow.
// OpenChemLib's Reaction has no single toSVG, so each reactant/product molecule is rendered on its own.
// The markup is built from OpenChemLib-generated SVGs and our own separators — no untrusted HTML.
export const buildReactionMarkup = (
  ocl: OclModule,
  content: string,
  baseId: string,
  size: { width: number; height: number }
): string => {
  const reaction = ocl.Reaction.fromRxn(content)
  const separator = (symbol: string): string =>
    `<span style="flex:none;font-size:22px;line-height:1;color:#888;padding:0 4px">${symbol}</span>`
  const svgFor = (molecule: InstanceType<OclModule['Molecule']>, id: string): string =>
    molecule.toSVG(size.width, size.height, id, { autoCrop: true, autoCropMargin: 8 })

  const parts: string[] = []
  const reactantCount = reaction.getReactants()
  for (let index = 0; index < reactantCount; index += 1) {
    if (index > 0) parts.push(separator('+'))
    parts.push(svgFor(reaction.getReactant(index), `${baseId}-r${index}`))
  }
  parts.push(separator('→'))
  const productCount = reaction.getProducts()
  for (let index = 0; index < productCount; index += 1) {
    if (index > 0) parts.push(separator('+'))
    parts.push(svgFor(reaction.getProduct(index), `${baseId}-p${index}`))
  }

  return `<div style="display:flex;align-items:center;gap:6px;max-width:100%;max-height:100%;overflow:auto">${parts.join('')}</div>`
}
