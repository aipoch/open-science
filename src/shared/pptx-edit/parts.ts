import { relationshipsOf, type EditContext } from './context'
import { NS, children, relsPathFor } from './package'

export const relType = (name: string): string => `${NS.r}/${name}`

const relsDoc = (ctx: EditContext, part: string): Document => {
  const path = relsPathFor(part)
  return ctx.has(path) ? ctx.edit(path) : ctx.create(path, `<Relationships xmlns="${NS.rel}"/>`)
}

export const addRelationship = (
  ctx: EditContext,
  part: string,
  type: string,
  target: string,
  external = false
): string => {
  const used = new Set(relationshipsOf(ctx, part).map((rel) => rel.id))
  let n = used.size + 1
  while (used.has(`rId${n}`)) n += 1
  const id = `rId${n}`
  const doc = relsDoc(ctx, part)
  const rel = doc.createElementNS(NS.rel, 'Relationship')
  rel.setAttribute('Id', id)
  rel.setAttribute('Type', type)
  rel.setAttribute('Target', target)
  if (external) rel.setAttribute('TargetMode', 'External')
  doc.documentElement.appendChild(rel)
  return id
}

export const removeRelationship = (ctx: EditContext, part: string, id: string): void => {
  if (!ctx.has(relsPathFor(part))) return
  const doc = ctx.edit(relsPathFor(part))
  for (const rel of children(doc.documentElement, NS.rel, 'Relationship')) {
    if (rel.getAttribute('Id') === id) doc.documentElement.removeChild(rel)
  }
}

export const freePartName = (ctx: EditContext, dir: string, base: string, ext: string): string => {
  let n = 1
  while (ctx.has(`${dir}${base}${n}.${ext}`)) n += 1
  return `${dir}${base}${n}.${ext}`
}

export const addOverride = (ctx: EditContext, partName: string, contentType: string): void => {
  const doc = ctx.edit('[Content_Types].xml')
  const node = doc.createElementNS(NS.ct, 'Override')
  node.setAttribute('PartName', `/${partName}`)
  node.setAttribute('ContentType', contentType)
  doc.documentElement.appendChild(node)
}

export const removeOverride = (ctx: EditContext, partName: string): void => {
  const doc = ctx.edit('[Content_Types].xml')
  for (const node of children(doc.documentElement, NS.ct, 'Override')) {
    if (node.getAttribute('PartName') === `/${partName}`) doc.documentElement.removeChild(node)
  }
}

export const overrideTypeOf = (ctx: EditContext, partName: string): string | undefined => {
  const doc = ctx.doc('[Content_Types].xml')
  const match = children(doc.documentElement, NS.ct, 'Override').find(
    (node) => node.getAttribute('PartName') === `/${partName}`
  )
  return match?.getAttribute('ContentType') ?? undefined
}
