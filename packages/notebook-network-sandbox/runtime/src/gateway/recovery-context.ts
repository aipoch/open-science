// Keep recovery instructions in tool-visible failures as well as the system prompt.
// Clients such as curl may hide the HTTP response body; ViolationLog uses the same copy.
export const NETWORK_APPROVAL_REQUIRED =
  'OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED: Destination approval is required. ' +
  'Call the open-science-notebook request_network_access tool with the exact hostname (without scheme or port), reason, and runtime; for bash include the exact failed command. ' +
  'This opens a user approval card. Do not ask the user to manually edit the allowed domains list as the first recovery step. ' +
  'Retry explicitly on a new connection only after allowedOnce, alwaysAllowed, or alreadyAllowed. ' +
  'If denied, stop; if unavailable, report that approval could not be presented. Do not bypass the sandbox.'

export const NETWORK_POLICY_BLOCKED =
  'OPEN_SCIENCE_NETWORK_POLICY_BLOCKED: The destination or request was rejected by network policy. ' +
  'Inspect the accompanying reason: correct malformed host/port or request syntax; for DNS failure verify the hostname and connectivity. ' +
  'Private, local, metadata, and explicitly forbidden destinations cannot be unlocked by request_network_access. ' +
  'Do not treat this as a missing domain grant or disable the sandbox.'

export const NETWORK_UPSTREAM_FAILED =
  'OPEN_SCIENCE_NETWORK_UPSTREAM_FAILED: The upstream connection or TLS verification failed. ' +
  'Check the destination and connectivity; retry once at most if transient. ' +
  'This is not a domain-approval failure. Do not disable certificate verification or request approval to bypass TLS validation.'
