---
type: rule
name: Webhook Request Logging
id: webhook-request-logging
context: review
links:
  - edge: constrains
    target: 'review.flow:normalize-provider-webhook'
tags:
  - provider
  - webhook
  - observability
---

**Policy:**

Every GitLab webhook request handled by the [[review.flow:normalize-provider-webhook]] flow produces exactly one `[webhook]` log line describing its outcome: unknown project (404), unauthorized (401), invalid payload (400), ignored (200, with the classification reason), review requested, or note received.

**Parameters:**

- Rejected and ignored lines have the form `[webhook] <project key> "<X-Gitlab-Event>" <status> <outcome>`; ignored lines append the MR IID when the payload carries one, followed by the reason.
- Review-requested and note-received lines keep their existing form and are the only line for that request.
- A line contains only the project key, the `X-Gitlab-Event` header, the status, the outcome, the MR IID, and the classification reason.

**On violation:**

A request that leaves no log line, or one that logs more than one outcome line, is a defect. Logging the request body, any header other than `X-Gitlab-Event`, tokens, or signatures is a security defect.
