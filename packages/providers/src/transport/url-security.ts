export const PROVIDER_TRANSPORT_ERROR =
  'Remote model URLs must use HTTPS. HTTP is only allowed for localhost or loopback addresses.'

// URL parsing canonicalizes IPv4 shorthand/decimal forms before checking the loopback range.
const isLoopbackHostname = (url: URL): boolean =>
  url.hostname === 'localhost' ||
  url.hostname === '[::1]' ||
  /^127\.\d+\.\d+\.\d+$/.test(url.hostname)

export const isSecureProviderUrl = (url: URL): boolean =>
  url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url))

// True for a parseable http(s) base URL whose host is loopback — the shape every local model
// server (Ollama, LM Studio, llama.cpp, vLLM) serves on. Local servers require no API key, so
// validation surfaces use this to relax the key requirement for them.
export const isLoopbackProviderBaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHostname(url)
  } catch {
    return false
  }
}
