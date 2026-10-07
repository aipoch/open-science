# API Route

[API Route](https://www.api-route.com/) is a hosted OpenAI-compatible API. Its built-in preset uses the existing Chat Completions adapter and the local Responses-to-Chat bridge; it does not install a provider SDK.

## Configure

1. Create an account, add balance, and create a key in [API Keys](https://www.api-route.com/api-keys).
2. Open Settings → Model and add an API provider. Select **API Route**.
3. Paste the key and choose a model available to its group and permissions. The preset offers `gpt-6.1-sol`, `claude-fable-5-1`, and `gpt-5.5`, with `gpt-6.1-sol` as the initial selection.
4. Test the connection, save, and select the provider for a compatible agent framework.

The Chat Completions base URL is `https://global.api-route.com/v1`. IDs are sent unchanged, without adding an upstream-vendor prefix. The preset uses Bearer authentication and the existing encrypted key storage. See the [API access contract](https://github.com/DennyHo0917/api-route/blob/main/API.md) and [current pricing](https://www.api-route.com/pricing).

## Catalog and limits

The authenticated `/v1/models` catalog includes media models and does not expose context-window or capability metadata. The preset therefore uses a small curated chat catalog, disables live catalog refresh, and does not advertise image input, native Responses, or selectable reasoning effort.

Each bundled model uses an **8,192-token client context budget**. This is a conservative application limit, not an advertised maximum for the upstream model or every API Route group. Check the route's actual limits before increasing it through a custom provider. Availability, capabilities, and limits can vary by key and route.

Chat content is sent to the hosted gateway only after the user configures and selects this provider. Existing providers, default selections, and stored configurations are not migrated.
