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

The [[review.flow:normalize-provider-webhook]] flow authenticates a GitLab webhook before parsing its payload. When the project has a signing token, Mend requires a valid Standard Webhooks HMAC-SHA256 signature over `{webhook-id}.{webhook-timestamp}.{raw body}` and accepts the request only if one of the space-separated `v1,` signatures in `webhook-signature` matches. The `X-Gitlab-Token` header is never accepted in place of a signature, so stripping the `webhook-*` headers cannot bypass verification. When the project has no signing token, Mend compares the `X-Gitlab-Token` header with the project's secret token.

**Parameters:**

- `webhook_signing_token`: optional, `whsec_`-prefixed GitLab signing token; base64 key after the prefix.
- `webhook_secret`: secret token used when no signing token is configured; optional for GitLab projects with a signing token. A GitLab project must configure at least one of the two.
- Timestamp tolerance: 300 seconds in either direction. GitLab regenerates `webhook-timestamp` on every delivery, including manual resends, so resending an old event still verifies.

**On violation:**

The webhook is rejected with `401 unauthorized` and no event is enqueued. A missing `webhook-id`, `webhook-timestamp`, or `webhook-signature` header when a signing token is configured, a stale or non-integer timestamp, a tampered body, or a wrong secret token are all violations. Comparisons are constant-time.
