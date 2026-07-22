---
type: contract
name: Review Agent Harness Contract
id: review-agent-harness
links:
  - edge: maps-to
    target: 'review.term:review-agent-harness'
tags: []
context: review
---

Mend sends repository working directory, review instructions, review prompt, model selection, timeout, optional tool mode, and optional abort signal to the harness. The harness returns success state, assistant output, harness id, model id, duration, optional session file, and optional error. Harness failures must be represented as failed results or thrown errors that the workflow turns into failed review runs. The contract does not post notes, mutate provider state, or solve PRs.

This contract maps to [[review.term:review-agent-harness]].
