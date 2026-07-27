---
type: invariant
name: Provider Draft Ownership
id: provider-draft-ownership
context: review
links:
  - edge: constrains
    target: review.flow:publish-provider-review
tags:
  - provider
  - publishing
  - safety
---

The [[review.flow:publish-provider-review]] flow may delete or recover a pre-existing provider draft only when a Mend marker proves that the draft belongs to the current review run. Unmarked, empty, foreign, and other-run drafts must remain untouched and block publication.
