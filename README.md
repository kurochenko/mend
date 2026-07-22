# Mend

Autonomous merge-request review for GitLab. Mend listens for webhooks, checks out the MR in an isolated worktree, reviews it with the coding agent of your choice, and posts structured findings back as draft notes — with a persistent status note tracking progress.

It runs on your own machine against your own GitLab projects, and it works with **subscription auth** (Claude Pro/Max via Pi, ChatGPT via Codex CLI) — no API keys required.

## How it works

```
GitLab webhook ──▶ queue ──▶ setup ──▶ review ──▶ post
                  (dedup)    (clone +  (agent     (draft notes +
                             worktree)  harness)   status note)
```

- **Queue** — per-MR deduplication, latest-wins; a SHA already reviewed successfully is skipped. A status note on the MR tracks `queued → running → completed`.
- **Setup** — maintains a bare clone per project and creates a fresh worktree per review.
- **Review** — a selectable coding-agent harness (`pi`, `codex`, `opencode`, or an `ensemble` of finders + verifiers + synthesizer) reads the diff and the code around it and produces structured findings. File inspection is enforced: files the agent skipped get a retry pass. An LLM intent classifier picks the review template (feature, refactor, fix, …).
- **Post** — findings become GitLab draft notes (inline where the diff allows), bulk-published at the end. Update reviews diff against the last reviewed SHA and resolve addressed threads. Replies to review threads are processed, and triage commands let you accept or dismiss findings.

There is also an evals dashboard (`/evals`) over review run history, and a replay CLI to re-run recorded webhooks as benchmarks.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3.9
- Docker (Postgres 16 + pgvector via `docker-compose.yml`)
- At least one review harness: [Pi](https://github.com/badlogic/pi-mono), [Codex CLI](https://github.com/openai/codex), or [OpenCode](https://github.com/sst/opencode)

## Setup

```bash
bun install
docker compose up -d postgres
cp .env.example .env          # server + per-project secrets
cp mend.example.yml mend.yml  # project configuration
bun run db:migrate
bun run dev
```

Then wire up a project:

1. **Configure the project** in `mend.yml`: GitLab URL, API token, webhook secret, project id, repo URL. Secrets are referenced as `${VAR}` and resolved from `.env`.
2. **Expose the webhook endpoint.** For a quick start, `bun run tunnel:webhooks:quick` opens an ad-hoc Cloudflare tunnel to your local instance.
3. **Add a GitLab webhook** pointing at `https://<your-host>/webhooks/gitlab/<project-key>` with merge request events and note (comment) events enabled, using the secret from your config.

Open an MR (or mark one ready) and Mend reviews it.

## Auth: subscriptions or API keys

Harnesses bring their own auth — Mend doesn't need model API keys of its own:

- **Pi** — run `pi`, then `/login` for subscription auth (Claude Pro/Max), or set provider API keys in the environment (`ANTHROPIC_API_KEY`, …).
- **Codex CLI** — `codex login` with your ChatGPT account, or an OpenAI API key.
- **OpenCode** — `opencode auth login` for its supported providers.

## Choosing harness and model

Everything is per-project in `mend.yml`. See [mend.example.yml](mend.example.yml) for the full reference.

```yaml
review:
  agent:
    harness: codex        # pi | codex | opencode | ensemble
    model: gpt-5.5
    thinking_level: medium
  llm:                    # intent classification etc.
    model: anthropic/claude-sonnet-4-20250514
    thinking_level: medium
```

The `ensemble` harness fans out cheap finder agents across review dimensions, adversarially verifies their findings, and synthesizes the survivors — each role with its own model and thinking level.

## Development

```bash
bun run check      # format + lint + typecheck + tests
bun test ./src     # tests only (needs the postgres-test container)
bun run replay     # re-run recorded webhooks / benchmarks
bun run runs       # inspect review run history
```

Architecture notes live in [AGENTS.md](AGENTS.md), decision records in [docs/adr](docs/adr), design proposals in [docs/proposals](docs/proposals).

## License

[MIT](LICENSE)
