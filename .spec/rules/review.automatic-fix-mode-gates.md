---
type: rule
name: Automatic Fix Mode Gates
id: automatic-fix-mode-gates
context: review
links:
  - edge: constrains
    target: review.flow:queue-automatic-fix-batch
tags:
  - automatic
  - fix-loop
  - queue
---

The [[review.flow:queue-automatic-fix-batch]] flow runs only when project configuration enables the fix loop and automatic mode. It can queue pending or accepted Mend-owned finding threads, but rejected, deferred, fixed, not-fixed, and resolved findings remain human decisions and are not fixed automatically. Automatic queuing stops when the configured loop limit has been reached.
