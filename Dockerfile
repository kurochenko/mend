FROM oven/bun:1.3.9

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN bun install -g @openai/codex opencode-ai @mariozechner/pi-coding-agent

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .

ENV PORT=3147
EXPOSE 3147

CMD ["sh", "-c", "bun run db:migrate && bun run start"]
