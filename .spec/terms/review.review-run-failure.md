---
type: term
name: Review Run Failure
id: review-run-failure
links:
  - edge: depends-on
    target: 'review.term:review-agent-harness'
tags:
  - diagnostics
context: review
---

A review run failure is a completed Mend run whose workflow did not produce a publishable review. It records the failed phase, a safe failure category, and an internal diagnostic message so operators can locate the failed run without exposing provider or execution details in a status note. A publication failure identifies the post phase separately from setup, review, and workflow failures.

The [[review.term:review-agent-harness]] remains the source of execution details; this term defines the durable failure summary exposed by the run and queue boundaries.
