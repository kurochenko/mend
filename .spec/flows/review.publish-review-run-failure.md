---
type: flow
name: Publish Review Run Failure
id: publish-review-run-failure
context: review
links:
  - edge: depends-on
    target: 'review.term:review-run-failure'
  - edge: depends-on
    target: 'review.con:review-provider'
tags:
  - diagnostics
  - publishing
---

When a review workflow fails, Mend extracts the diagnostic from the failed step, persists it with the failed run, and updates the provider status note with only the failure phase and safe category. A failed post step is reported as a publication failure and retains the run id for operator lookup. Successful step results are ignored while selecting the failed-step diagnostic, so an ordinary review result cannot mask a later publication error.

The provider status update crosses the [[review.con:review-provider]] boundary and uses the [[review.term:review-run-failure]] summary rather than exposing the internal error message.
