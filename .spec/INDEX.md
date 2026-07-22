# Spec Index

Auto-maintained graph topology. One line per primitive, showing all outgoing links.
Rebuilt automatically by the lore CLI on every write command.

<!-- Format: - prefix:id (context) → edge: prefix:target, prefix:target; edge: prefix:target -->

## Terms

- review.term:fix-batch-request (review) → depends-on: review.term:review-finding
- review.term:fixer-agent-result (review) → depends-on: review.term:review-finding
- review.term:fixer-workspace (review) → depends-on: review.term:fix-batch-request
- review.term:review-agent-harness (review) → no links
- review.term:review-finding (review) → no links
- review.term:review-triage-command (review) → depends-on: review.term:review-finding

## Invariants

- review.inv:review-finding-thread-identity (review) → constrains: review.flow:persist-review-finding-state
- review.inv:single-active-mr-workflow (review) → constrains: review.flow:queue-accepted-finding-fix-batch
- review.inv:structured-review-output (review) → constrains: review.flow:run-review-agent

## Rules

- review.rule:accepted-fix-batch-gates (review) → constrains: review.flow:queue-accepted-finding-fix-batch
- review.rule:automatic-fix-mode-gates (review) → constrains: review.flow:queue-automatic-fix-batch
- review.rule:fixer-workspace-sandbox-config (review) → depends-on: review.term:fixer-workspace; constrains: review.flow:prepare-fixer-workspace
- review.rule:triage-command-reasons (review) → constrains: review.flow:apply-finding-triage-command

## Events

<!-- No events defined yet. -->

## Flows

- review.flow:apply-finding-triage-command (review) → depends-on: review.term:review-triage-command, review.term:review-finding
- review.flow:commit-push-fix-batch (review) → depends-on: review.term:fix-batch-request, review.term:fixer-agent-result
- review.flow:persist-review-finding-state (review) → depends-on: review.term:review-finding
- review.flow:prepare-fixer-workspace (review) → depends-on: review.term:fixer-workspace, review.con:workspace-provider
- review.flow:queue-accepted-finding-fix-batch (review) → depends-on: review.term:review-triage-command, review.term:fix-batch-request, review.term:review-finding
- review.flow:queue-automatic-fix-batch (review) → depends-on: review.term:review-finding, review.term:fix-batch-request
- review.flow:run-fixer-agent (review) → depends-on: review.term:fix-batch-request, review.term:fixer-workspace, review.term:fixer-agent-result, review.term:review-finding
- review.flow:run-review-agent (review) → depends-on: review.con:review-agent-harness

## Contracts

- review.con:review-agent-harness (review) → maps-to: review.term:review-agent-harness
- review.con:workspace-provider (review) → maps-to: review.term:fixer-workspace

## Decisions

<!-- No decisions defined yet. -->

## Features

- review.feat:apply-finding-triage-command (review) → includes: review.term:review-triage-command, review.term:review-finding, review.rule:triage-command-reasons, review.flow:apply-finding-triage-command
- review.feat:commit-push-and-review-fix-batch (review) → includes: review.term:fix-batch-request, review.term:fixer-agent-result, review.flow:commit-push-fix-batch
- review.feat:configure-fixer-workspace-provider (review) → includes: review.term:fixer-workspace, review.con:workspace-provider, review.rule:fixer-workspace-sandbox-config, review.flow:prepare-fixer-workspace
- review.feat:persist-review-finding-state (review) → includes: review.term:review-finding, review.flow:persist-review-finding-state, review.inv:review-finding-thread-identity
- review.feat:queue-accepted-finding-fix-batch (review) → includes: review.term:fix-batch-request, review.term:review-finding, review.rule:accepted-fix-batch-gates, review.inv:single-active-mr-workflow, review.flow:queue-accepted-finding-fix-batch
- review.feat:queue-automatic-fix-batch (review) → includes: review.term:review-finding, review.term:fix-batch-request, review.rule:automatic-fix-mode-gates, review.flow:queue-automatic-fix-batch
- review.feat:replaceable-review-agent-harness (review) → includes: review.term:review-agent-harness, review.con:review-agent-harness, review.flow:run-review-agent, review.inv:structured-review-output
- review.feat:run-fixer-agent-on-accepted-findings (review) → includes: review.term:fix-batch-request, review.term:fixer-workspace, review.term:fixer-agent-result, review.term:review-finding, review.flow:run-fixer-agent
