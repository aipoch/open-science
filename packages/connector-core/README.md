# @aipoch/connector-core

Node.js 22+ Connector execution and JSON Schema validation, with no Electron,
Settings, Credentials, Notebook, or built-in provider dependency.

```ts
import { createConnectorRegistry, ParserEngine } from '@aipoch/connector-core'
import type { ToolDescriptor } from '@aipoch/connector-core'

const tools: ToolDescriptor[] = [
  {
    connector: 'example',
    id: 'read',
    description: 'Read a record',
    input: { type: 'object', additionalProperties: false },
    url: () => 'https://example.org/record',
    parse: (value) => value
  }
]
const registry = createConnectorRegistry(tools)
const tool = registry.getDescriptor('example', 'read')!
registry.validateToolArguments(tool, {})
const result = await new ParserEngine().call(tool, {}, {})
```

The registry preserves descriptor identity and order; schema validation does not
coerce, insert defaults, or remove fields. Validate before calling the engine.
`ConnectorArgumentsError` distinguishes schema rejection from an unregistered
descriptor. Application-specific recovery instructions belong to the caller.

The engine owns HTTP retries, body limits, request and whole-call deadlines, and
abort cleanup. Supply `fetchImpl` for deterministic tests or host transport policy.
Credentials are a readonly string map resolved by the caller for each call. The
core neither loads nor persists credentials. `requiredCredential` is descriptive
metadata; authorization and credential prompting are the caller's responsibility.

The root public path `@aipoch/connector-core` exposes the engine, registry,
error classes, descriptor/context/credential types and the shared retry/abort
helpers. `src` and `dist` subpaths are private. Both ESM and CommonJS load the same
CommonJS implementation, preserving `instanceof ConnectorHttpError`.

Run `npm install`, then `npm run typecheck`, `npm test`, and `npm run build`.
`npm pack` builds and includes only compiled JavaScript, declarations and docs.
The package has its own test/build configuration and declared dependencies.

The `./url-admission` entry provides Node HTTPS/loopback validation without loading
the engine or a provider registry. Generic diagnostic policy belongs to the host. Application-specific Skill documentation remains a host adapter.

`credentialKeys` optionally projects a provider's credential view; an empty list
exposes none. Omitting it preserves the original caller-supplied map for existing
custom descriptors. `optionalCredential` describes a host-handled retry prompt;
the core never opens UI. Built-in providers declare their own credential keys.
`rawFetch` in the call context uses the injected transport for providers that own
their streaming/retry protocol; those providers must pass the call signal.

Inject `redactDiagnosticText` into `ParserEngine` to retain useful sanitized provider error text.
Without it, untrusted diagnostic text is replaced with `[redacted]`.

`ToolDescriptor.exampleArgs` provides structured example arguments for callers to render.
Set `userAgent` to identify your application. It applies to managed and raw requests; an
explicit raw-request User-Agent takes precedence. Without it the engine identifies itself
as `connector-core/0.1.0`.

## Safety and integration

- **Scope:** Descriptor validation and request execution using caller-supplied transport and credentials.
- **Controls:** Argument schema validation, managed-request limits/deadlines, and diagnostic redaction.
  Credential projection limits the supplied view when configured; `requiredCredential` is not authorization.
- **Remaining risks:** Descriptors contain executable callbacks. Valid arguments and read-only service
  operations can still disclose query content, and credentials permit whatever the service grants.
  The package does not sandbox callbacks or automatically apply application Notebook network policy.
- **Safe integration:** Trust/review descriptors, validate before execution, inject destination and
  transport policy, and supply only needed credentials. The host owns consent, storage protection,
  and authorization. Review the application's
  [data recipients](https://github.com/aipoch/open-science/blob/main/docs/security.md#data-recipients).
