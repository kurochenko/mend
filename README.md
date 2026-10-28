# Mend

Autonomous merge-request review for GitLab. Mend listens for webhooks, checks out the MR in an isolated worktree, reviews it with the coding agent of your choice, and posts structured findings back as draft notes — with a persistent status note tracking progress.

It runs on your own machine against your own projects, and it works with **subscription auth** (Claude Pro/Max via Pi, ChatGPT via Codex CLI) — no API keys required.

## Platform support

- **GitLab** — supported and running in production (gitlab.com and self-hosted).
- **GitHub** — experimental: implemented behind the same review-provider port, but not yet exercised against a live GitHub project. Expect rough edges.

## How it works

```
GitLab webhook ──▶ queue ──▶ setup ──▶ review ──▶ post
                  (dedup)    (clone +  (agent     (draft notes +
                             worktree)  harness)   status note)
```

- **Queue** — per-MR deduplication, latest-wins; a SHA already reviewed successfully is skipped. A status note on the MR tracks `queued → running → completed`.
- **Setup** — maintains a bare clone per project and creates a fresh worktree per review.
- **Review** — a selectable coding-agent harness (`pi`, `codex`, `opencode`, or an `ensemble` of finders + verifiers + synthesizer) reads the diff and the code around it and produces structured findings. File inspection is enforced: files the agent skipped get a retry pass. An LLM intent classifier picks the review template.
- **Post** — findings become GitLab draft notes (inline where the diff allows), bulk-published at the end. Update reviews diff against the last reviewed SHA and resolve addressed threads. Replies to review threads are processed, and triage commands let you accept or dismiss findings.

There is also an evals dashboard (`/evals`) over review run history, and a replay CLI to re-run recorded webhooks as benchmarks.

## Quick start (Docker)

Requires Docker with the compose plugin.

```bash
git clone https://github.com/kurochenko/mend.git && cd mend
cp .env.example .env          # secrets referenced from mend.yml
cp mend.example.yml mend.yml  # project configuration — edit this
docker compose up -d --build mend
curl localhost:3147/health
```

This starts Postgres (persistent `pgdata` volume) and the Mend service on port 3147, with migrations applied on start. The image ships `git` plus the Codex, OpenCode, and Pi CLIs. Config files stay on your host — edit `mend.yml` or `.env`, then `docker compose restart mend`. Clones, agent sessions, and harness logins live in named volumes, so they survive rebuilds.

To clone your projects over SSH, uncomment the `~/.ssh` mount in `docker-compose.yml`; alternatively use an HTTPS `repo_url` with an embedded token.

## Run from source

Requires [Bun](https://bun.sh) ≥ 1.3.9 and Docker (for Postgres).

```bash
bun install
docker compose up -d postgres
cp .env.example .env
cp mend.example.yml mend.yml
bun run db:migrate
bun run dev
```

## Auth: subscriptions or API keys

Harnesses bring their own auth — Mend doesn't need model API keys of its own:

- **API keys** — set them in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …); the harnesses pick them up from the environment.
- **Pi** (subscription: Claude Pro/Max and others) — run `pi`, then `/login`. In Docker: `docker compose exec mend pi`.
- **Codex CLI** (subscription: ChatGPT) — run `codex login`. In Docker: `docker compose exec mend codex login`.
- **OpenCode** — run `opencode auth login`. In Docker: `docker compose exec mend opencode auth login`.

In Docker, logins persist in the `pi-auth` / `codex-auth` / `opencode-auth` volumes.

## Connecting a project

1. **Configure it in `mend.yml`** (see [mend.example.yml](mend.example.yml) for every option): GitLab URL, API token (scope `api`), webhook signing token (or secret token), project id, `repo_url`, and the trigger mode — `ready` reviews MRs when they leave draft state, `all` reviews every push. Secrets are referenced as `${VAR}` and resolved from `.env`.
2. **Expose port 3147** to the internet however you like — reverse proxy, Tailscale funnel, or a Cloudflare tunnel (`bun run tunnel:webhooks:quick` starts an ad-hoc one for testing).
3. **Add the webhook** in GitLab: *Project → Settings → Webhooks*.
   - URL: `https://<your-host>/webhooks/gitlab/<project-key>` (the key from `mend.yml`, e.g. `backend`)
   - Signing token (recommended): select **Generate signing token** and put the `whsec_…` value into `webhook_signing_token`. Mend then requires a valid HMAC-SHA256 `webhook-signature` on every request and rejects any request that is unsigned, whose body was changed, or whose timestamp is more than 5 minutes old. The secret token is not checked, so `webhook_secret` can be omitted and the secret token removed from GitLab.
   - Secret token (without a signing token): the value of your `webhook_secret`
   - Triggers: **Merge request events** and **Comments** (note events)
4. Open an MR (or mark one ready) — Mend queues a review, posts a status note, and publishes findings when done.

### Troubleshooting webhooks

Every webhook request logs one `[webhook]` outcome line (`docker compose logs -f mend`); with `RECORD_WEBHOOKS=1`, recorded payloads add a separate `recorded payload` line:

```
[webhook] "missing" "Merge Request Hook" 404 unknown project
[webhook] backend "Merge Request Hook" 401 unauthorized
[webhook] backend "Push Hook" 400 invalid payload
[webhook] backend "Merge Request Hook" 200 ignored MR !42: action "update", draft=true
[webhook] review requested: https://gitlab.com/org/backend/-/merge_requests/42 (backend)
```

- `404` — the last URL segment doesn't match a project key in `mend.yml`.
- `401` — the signing token or secret token doesn't match `.env`; restart Mend after editing it.
- `400 invalid payload` — an event kind Mend doesn't handle (e.g. push events); only enable merge request and comment events.
- `ignored` — the request was valid but doesn't trigger a review; the reason says why (draft MR, closed MR, …).
- `500 internal error` — Mend failed while handling the request; the stack trace follows on the next line.

No line at all means the request never reached Mend: check GitLab's *Settings → Webhooks → Recent events* for the delivery error, then DNS, firewall, and the reverse proxy.

## Choosing harness and model

Everything is per-project in `mend.yml`:

```yaml
review:
  agent:
    harness: codex        # pi | codex | opencode | ensemble
    model: gpt-5.5
    thinking_level: medium
  llm:                    # Pi model for thread replies and fallbacks
    model: openai-codex/gpt-6-luna
    thinking_level: medium
```

The `ensemble` harness fans out cheap finder agents across review dimensions, adversarially verifies their findings, and synthesizes the survivors — each role with its own model and thinking level.

## Customizing reviews per project

- **Review templates** — `review.template.prompt: auto` lets the intent classifier pick among `feature`, `bugfix`, `style_refactor`, `security_sensitive`, and `mixed`; set a fixed id to pin one. An MR label like `ai-review:bugfix` (prefix configurable via `review.template.label_prefix`) overrides both.
- **Project conventions** — the reviewer works inside a real worktree of the reviewed repository and is instructed to read its root `AGENTS.md` and cite violated rules. Keeping conventions there benefits your agents and your reviewer alike.
- **Review memory** — accepted/dismissed findings and thread outcomes accumulate per project and feed future review prompts, so triage decisions teach the reviewer over time.

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
