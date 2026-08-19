import { createLucideIcon } from 'lucide-react'

// Hand-drawn glyphs in the Lucide stroke convention (24x24 grid, stroke-width 2, round
// caps/joins, currentColor) for concepts the installed Lucide set does not cover.
// createLucideIcon makes them full LucideIcon citizens, so the shared registry can hold
// Lucide exports and these glyphs interchangeably.

// Petri dish with colonies.
export const PetriDishIcon = createLucideIcon('PetriDish', [
  ['ellipse', { cx: '12', cy: '6.5', rx: '8.5', ry: '3' }],
  ['path', { d: 'M3.5 6.5v7c0 1.66 3.8 3 8.5 3s8.5-1.34 8.5-3v-7' }],
  ['circle', { cx: '8', cy: '11', r: '1' }],
  ['circle', { cx: '15', cy: '12', r: '1' }],
  ['circle', { cx: '11', cy: '14.5', r: '1' }]
])

// Aromatic (benzene) ring: hexagon with an inner circle.
export const MoleculeIcon = createLucideIcon('Molecule', [
  ['polygon', { points: '12 3 19.8 7.5 19.8 16.5 12 21 4.2 16.5 4.2 7.5' }],
  ['circle', { cx: '12', cy: '12', r: '4' }]
])
