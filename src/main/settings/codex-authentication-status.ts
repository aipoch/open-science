// A configured route is not evidence of an authenticated account. In particular,
// our HTTPS ChatGPT route still requires OpenAI authentication.
export const patchCodexAcpAuthenticationStatusSource = (source: string): string => {
  const before = `    const modelProvider = await this.getCurrentModelProvider();
    if (modelProvider) {
      return {
        type: "gateway",
        name: modelProvider
      };
    }
    const account = (await this.getAccount()).account;`
  const after = `    const modelProvider = await this.getCurrentModelProvider();
    const accountResponse = await this.getAccount();
    if (modelProvider && !accountResponse.requiresOpenaiAuth) {
      return {
        type: "gateway",
        name: modelProvider
      };
    }
    const account = accountResponse.account;`
  if (source.includes(after)) return source
  if (source.split(before).length === 2) return source.replace(before, after)
  if (source.includes('async getAuthenticationStatus(')) {
    throw new Error(
      'Pinned Codex ACP authentication-status patch no longer matches the adapter bundle'
    )
  }
  return source
}
