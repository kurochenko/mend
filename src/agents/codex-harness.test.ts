import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCommand,
  buildProcessEnv,
  extractInspectedChangedFilesFromEvents,
  resolveCodexInstallRoot,
  resolveGitCommonDir,
} from '@/agents/codex-harness'

const commandEvent = (command: string): string =>
  JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command,
    },
  })

describe('extractInspectedChangedFilesFromEvents', () => {
  it('extracts changed files from exact file-content command paths', () => {
    const events = [
      commandEvent('/bin/zsh -lc "sed -n \'1,120p\' src/agents/codex-harness.ts"'),
      commandEvent('/bin/zsh -lc "nl -ba src/mastra/review/review-pipeline.ts | sed -n \'1,80p\'"'),
    ].join('\n')

    expect(
      extractInspectedChangedFilesFromEvents(events, [
        'src/agents/codex-harness.ts',
        'src/mastra/review/review-pipeline.ts',
      ]),
    ).toEqual(['src/agents/codex-harness.ts', 'src/mastra/review/review-pipeline.ts'])
  })

  it('does not count substring path matches or diff/search-only commands', () => {
    const events = [
      commandEvent('/bin/zsh -lc "sed -n \'1,120p\' src/foo.tsx"'),
      commandEvent('/bin/zsh -lc "git diff main...HEAD -- src/foo.ts"'),
      commandEvent('/bin/zsh -lc "rg src/foo.ts src"'),
    ].join('\n')

    expect(extractInspectedChangedFilesFromEvents(events, ['src/foo.ts'])).toEqual([])
  })
})

describe('buildCommand', () => {
  it('passes configured thinking level to Codex reasoning effort', () => {
    expect(
      buildCommand(
        {
          cwd: '/repo',
          model: 'gpt-5.5',
          thinkingLevel: 'medium',
          instructions: 'Review carefully.',
          prompt: 'Review this MR.',
          sessionDir: '/sessions',
        },
        '/sessions/out.txt',
      ),
    ).toContain('model_reasoning_effort="medium"')
  })

  it('maps off thinking level to Codex minimal reasoning effort', () => {
    expect(
      buildCommand(
        {
          cwd: '/repo',
          model: 'gpt-5.5',
          thinkingLevel: 'off',
          instructions: 'Review carefully.',
          prompt: 'Review this MR.',
          sessionDir: '/sessions',
        },
        '/sessions/out.txt',
      ),
    ).toContain('model_reasoning_effort="minimal"')
  })

  it('confines Codex tool calls to reading the worktree with no network', () => {
    const command = buildCommand(
      {
        cwd: '/repo',
        model: 'gpt-5.5',
        instructions: 'Review carefully.',
        prompt: 'Review this MR.',
        sessionDir: '/sessions',
      },
      '/sessions/out.txt',
      ['/opt/codex/@openai', '/workspaces/repo'],
    )

    expect(command).toContain('default_permissions="mend-review"')
    expect(command).toContain(
      'permissions.mend-review.filesystem={ ":root" = "deny", ":minimal" = "read", ":workspace_roots" = "read", "/opt/codex/@openai" = "read", "/workspaces/repo" = "read" }',
    )
    expect(command).not.toContain('--sandbox')
  })

  it('disables web search for every review run', () => {
    expect(
      buildCommand(
        {
          cwd: '/repo',
          model: 'gpt-5.5',
          thinkingLevel: 'medium',
          instructions: 'Review carefully.',
          prompt: 'Review this MR.',
          sessionDir: '/sessions',
        },
        '/sessions/out.txt',
        [],
      ),
    ).toContain('web_search="disabled"')
  })
})

describe('Context7 MCP server', () => {
  const launch = { command: '/bin/bun', args: ['--cwd=/mend', 'server.ts'], cwd: '/mend' }
  const baseConfig = {
    cwd: '/repo',
    model: 'gpt-5.5',
    instructions: 'Review carefully.',
    prompt: 'Review this MR.',
    sessionDir: '/sessions',
  }

  it('registers the auto-approved lookup tool and keeps the key out of the shell', () => {
    const command = buildCommand(
      { ...baseConfig, context7ApiKey: 'ctx7sk-key' },
      '/sessions/out.txt',
      [],
      launch,
    )

    expect(command).toContain('mcp_servers.context7.command="/bin/bun"')
    expect(command).toContain('mcp_servers.context7.args=["--cwd=/mend","server.ts"]')
    expect(command).toContain('mcp_servers.context7.cwd="/mend"')
    expect(command).toContain('mcp_servers.context7.env_vars=["CONTEXT7_API_KEY"]')
    expect(command).toContain('mcp_servers.context7.enabled_tools=["context7_lookup"]')
    expect(command).toContain('mcp_servers.context7.default_tools_approval_mode="approve"')
    expect(command).toContain('shell_environment_policy.exclude=["CONTEXT7_API_KEY"]')
    expect(command.join(' ')).not.toContain('ctx7sk-key')
    expect(command.at(-1)).toBe('-')
  })

  it('omits the server without a key or when tools are disabled', () => {
    const withoutKey = buildCommand(baseConfig, '/sessions/out.txt', [], launch)
    const toolsDisabled = buildCommand(
      { ...baseConfig, context7ApiKey: 'ctx7sk-key', toolMode: 'none' },
      '/sessions/out.txt',
      [],
      launch,
    )

    expect(withoutKey.join(' ')).not.toContain('mcp_servers')
    expect(toolsDisabled.join(' ')).not.toContain('mcp_servers')
  })

  it('passes the key to Codex only through the process environment', () => {
    expect(
      buildProcessEnv({ ...baseConfig, context7ApiKey: 'ctx7sk-key' }, { PATH: '/bin' }),
    ).toEqual({ PATH: '/bin', CONTEXT7_API_KEY: 'ctx7sk-key' })
    expect(
      buildProcessEnv(
        { ...baseConfig, context7ApiKey: 'ctx7sk-key', toolMode: 'none' },
        {
          PATH: '/bin',
        },
      ),
    ).toEqual({ PATH: '/bin' })
  })
})

describe('resolveCodexInstallRoot', () => {
  it('grants the npm package scope when codex is the JavaScript launcher', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mend-codex-root-'))
    try {
      const launcherDir = join(tmp, 'node_modules', '@openai', 'codex', 'bin')
      mkdirSync(launcherDir, { recursive: true })
      writeFileSync(join(launcherDir, 'codex.js'), '')
      symlinkSync(join(launcherDir, 'codex.js'), join(tmp, 'codex'))

      expect(resolveCodexInstallRoot(() => join(tmp, 'codex'))).toBe(
        join(realpathSync(tmp), 'node_modules', '@openai'),
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('grants the binary directory for a native codex executable', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mend-codex-native-'))
    try {
      writeFileSync(join(tmp, 'codex'), '')

      expect(resolveCodexInstallRoot(() => join(tmp, 'codex'))).toBe(realpathSync(tmp))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('returns null when codex is not on PATH', () => {
    expect(resolveCodexInstallRoot(() => null)).toBeNull()
  })
})

describe('resolveGitCommonDir', () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stderr: 'pipe' })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString())
    }
  }

  it('grants the bare clone that a review worktree points at', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mend-codex-git-')))
    try {
      const source = join(tmp, 'source')
      mkdirSync(source)
      git(source, 'init', '-q', '-b', 'main')
      writeFileSync(join(source, 'a.ts'), 'export {}\n')
      git(source, 'add', 'a.ts')
      git(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
      const bare = join(tmp, 'project')
      git(tmp, 'clone', '-q', '--bare', source, bare)
      const worktree = join(bare, 'worktrees-mr', 'mr-1')
      git(bare, 'worktree', 'add', '-q', '--detach', worktree, 'main')

      expect(resolveGitCommonDir(worktree)).toBe(bare)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('returns null outside a git repository', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mend-codex-nogit-'))
    try {
      expect(resolveGitCommonDir(tmp)).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
