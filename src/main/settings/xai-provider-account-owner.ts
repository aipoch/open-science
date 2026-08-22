import type { XaiOAuthDeviceAuthorization } from '../../shared/settings'
import { isXaiSubscriptionProvider } from '../../shared/settings'
import { encryptKey, tryDecryptKey } from './crypto'
import type { SettingsRepository } from './repository'
import type { StoredProvider } from './types'
import { XaiOAuthController, type XaiOAuthControllerPort } from './xai-oauth'

type Serialize = <T>(operation: () => Promise<T>) => Promise<T>

export class XaiProviderAccountOwner {
  private readonly oauth: XaiOAuthControllerPort

  constructor(
    private readonly repository: SettingsRepository,
    serialize: Serialize,
    injected?: XaiOAuthControllerPort
  ) {
    this.oauth =
      injected ??
      new XaiOAuthController({
        store: {
          load: async () => {
            const provider = await this.provider()
            const refreshToken = tryDecryptKey(provider?.keyRef)
            return {
              ...(provider?.keyRef ? { keyRef: provider.keyRef } : {}),
              ...(refreshToken ? { refreshToken } : {}),
              ...(provider?.accountEmail ? { accountEmail: provider.accountEmail } : {})
            }
          },
          save: (expectedKeyRef, refreshToken, accountEmail) =>
            serialize(async () => {
              const provider = await this.provider()
              if (!provider || provider.keyRef !== expectedKeyRef) return false
              await this.repository.upsertProvider({
                ...provider,
                keyRef: encryptKey(refreshToken),
                accountEmail: accountEmail ?? provider.accountEmail
              })
              return true
            }),
          clear: () =>
            serialize(async () => {
              const provider = await this.provider()
              if (!provider) return
              const withoutCredential = { ...provider }
              delete withoutCredential.keyRef
              delete withoutCredential.accountEmail
              await this.repository.upsertProvider(withoutCredential)
            })
        }
      })
  }

  beginLogin(): Promise<XaiOAuthDeviceAuthorization> {
    return this.oauth.beginLogin()
  }

  waitForLogin(): Promise<{ accountEmail?: string }> {
    return this.oauth.waitForLogin()
  }

  cancelLogin(): void {
    this.oauth.cancelLogin()
  }

  logout(): Promise<void> {
    return this.oauth.logout()
  }

  getAccessToken(forceRefresh = false): Promise<string> {
    return this.oauth.getAccessToken(forceRefresh)
  }

  async isUsable(): Promise<boolean> {
    try {
      await this.oauth.getAccessToken()
      return true
    } catch {
      return false
    }
  }

  private async provider(): Promise<StoredProvider | undefined> {
    return (await this.repository.getSettings()).providers.find((provider) =>
      isXaiSubscriptionProvider(provider.type)
    )
  }
}
