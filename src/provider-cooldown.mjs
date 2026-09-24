import { canonicalProviderId } from "./provider-selection.mjs";

// The cooldown identity, shared by everything that records or reads a provider
// window: `model-failover.mjs` owns the windows themselves in
// `provider-cooldowns.json`, `api-forwarder.mjs` files harvested quota headers
// in `rate-limits.json`, and `router.mjs` reads both. One function is what
// keeps those stores from drifting back apart under two names for the same
// subscription.
//
// Most protocol variants of one subscription share the same upstream
// allowance. OpenCode Go is narrower: variants of the same model share a
// cooldown, while independent model allowances stay available. OpenCode Zen
// is separately billed and therefore keeps its own provider-level scope.
export function cooldownScope(providerId, modelSlug) {
  if (providerId === "opencode-zen") return providerId;
  const canonical = canonicalProviderId(providerId);
  // OpenCode Go exposes independent model allowances behind one credential.
  // Protocol variants share the allowance for the same model, but exhausting
  // Kimi must not withdraw Grok, DeepSeek, or Luna.
  if (canonical === "opencode-go" && modelSlug) {
    const value = String(modelSlug).trim();
    const model = value.includes("/") ? value.slice(value.indexOf("/") + 1) : value;
    return `${canonical}::${model}`;
  }
  return canonical;
}
