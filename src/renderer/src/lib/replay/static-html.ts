/** Saved HTML is a static Artifact preview, never a project runtime or a navigation surface. */
export function staticHtml(content: string): string {
  // Template content remains inert while stripping active elements and navigation attributes.
  const template = document.createElement('template')
  template.innerHTML = content
  template.content
    .querySelectorAll('script,iframe,frame,object,embed,base,link,meta')
    .forEach((node) => node.remove())
  template.content.querySelectorAll('*').forEach((node) => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase()
      if (
        name.startsWith('on') ||
        [
          'href',
          'xlink:href',
          'action',
          'formaction',
          'target',
          'srcdoc',
          'srcset',
          'ping',
          'autofocus'
        ].includes(name) ||
        (name === 'src' && !attribute.value.startsWith('data:'))
      )
        node.removeAttribute(attribute.name)
    }
  })
  return (
    "<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'\">" +
    template.innerHTML
  )
}
