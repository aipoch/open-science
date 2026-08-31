export type PdfContextLinkWorkflowOptions<TContext> = Readonly<{
  read: () => Promise<TContext>
  link: () => Promise<Readonly<{ context: TContext; changed: boolean }>>
  enable: () => Promise<void>
  rollback: (linked: TContext, previous: TContext) => Promise<void>
  onRollbackError: (error: unknown) => void
}>

export const linkPdfContextWithCapability = async <TContext>(
  options: PdfContextLinkWorkflowOptions<TContext>
): Promise<TContext> => {
  const previous = await options.read()
  const { context: linked, changed } = await options.link()
  try {
    await options.enable()
    return linked
  } catch (error) {
    if (changed) {
      try {
        await options.rollback(linked, previous)
      } catch (rollbackError) {
        options.onRollbackError(rollbackError)
      }
    }
    throw error
  }
}
