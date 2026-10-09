---
type: rule
name: GitLab Webhook Authentication
id: gitlab-webhook-authentication
context: review
links:
  - edge: constrains
    target: 'review.flow:normalize-provider-webhook'
tags:
  - provider
  - webhook
  - security
---

**Policy:**

The [[review.flow:normalize-provider-webhook]] flow authenticates a GitLab webhook before parsing its payload. When the project has a signing token and the request carries a `webhook-signature` header, Mend verifies the Standard Webhooks HMAC-SHA256 signature over `{webhook-id}.{webhook-timestamp}.{raw body}` and accepts the request only if one of the space-separated `v1,` signatures matches. Otherwise Mend falls back to comparing the `X-Gitlab-Token` header with the project's secret token. A signed request that fails verification never falls back to the secret token.

**Parameters:**

- `webhook_signing_token`: optional, `whsec_`-prefixed GitLab signing token; base64 key after the prefix.
- `webhook_secret`: required secret token used for the unsigned fallback.
- Timestamp tolerance: 300 seconds in either direction.

**On violation:**

The webhook is rejected with `401 unauthorized` and no event is enqueued. Missing signature headers, a stale or non-integer timestamp, a tampered body, or a wrong secret token are all violations. Comparisons are constant-time.
