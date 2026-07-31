type InvokeHandler = (...args: unknown[]) => Promise<unknown>

export const assignApiPath = (
  root: Record<string, unknown>,
  path: string,
  value: unknown
): void => {
  const parts = path.split('.')
  const key = parts.pop()!
  let target = root
  for (const part of parts) {
    target[part] ??= {}
    target = target[part] as Record<string, unknown>
  }
  target[key] = value
}

export const installWebInvokeChannels = (
  api: Record<string, unknown>,
  channels: Record<string, string>,
  availableRpcChannels: ReadonlySet<string>,
  restrictedRpcChannels: ReadonlySet<string>,
  createInvoker: (path: string, channel: string) => InvokeHandler
): void => {
  for (const [path, channel] of Object.entries(channels)) {
    if (availableRpcChannels.has(channel)) {
      assignApiPath(api, path, createInvoker(path, channel))
    } else if (restrictedRpcChannels.has(channel)) {
      assignApiPath(api, path, () =>
        Promise.reject(
          new Error(`This action is only available in the local desktop app (${channel}).`)
        )
      )
    }
  }
}
