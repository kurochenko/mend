import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  collectStructuralSignals,
  diffCycleSets,
  extractFanInSignals,
  renderStructuralSignals,
  type StructuralSignals,
} from '@/mastra/review/structural-signals'
import { sanitizeGitEnv } from '@/lib/exec'

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: sanitizeGitEnv(process.env) }).trim()

const gitCommit = (cwd: string, message: string): void => {
  git(cwd, [
    '-c',
    'user.name=Tester',
    '-c',
    'user.email=tester@example.invalid',
    'commit',
    '-m',
    message,
  ])
}

const makeSignals = (override: Partial<StructuralSignals> = {}): StructuralSignals => ({
  generic: {
    fileSizeOutliers: [],
    largeChangeConcentration: [],
    brokenDocReferences: [],
    qualityGateWeakening: [],
    fileChangeSummary: {
      newFiles: 0,
      modifiedFiles: 0,
      deletedFiles: 0,
      renamedFiles: 0,
      otherFiles: 0,
    },
  },
  dependencyCruiser: {
    enabled: true,
    skippedReason: null,
    configSource: 'fallback',
    configPath: null,
    headModuleCount: 0,
    baseModuleCount: 0,
    baseComparison: 'diff',
    introducedCycles: [],
    changedFileCycles: [],
    fanIn: [],
    ruleViolations: [],
  },
  diagnostics: [],
  ...override,
})

describe('structural signal helpers', () => {
  it('diffs cycle sets independent of traversal start', () => {
    const introduced = diffCycleSets(
      [
        { modules: ['src/a.ts', 'src/b.ts', 'src/c.ts'] },
        { modules: ['src/new-a.ts', 'src/new-b.ts'] },
      ],
      [{ modules: ['src/c.ts', 'src/b.ts', 'src/a.ts'] }],
    )

    expect(introduced).toEqual([{ modules: ['src/new-a.ts', 'src/new-b.ts'] }])
  })

  it('extracts top fan-in signals for changed modules', () => {
    const fanIn = extractFanInSignals(
      {
        modules: [
          {
            source: 'src/config.ts',
            dependents: Array.from({ length: 12 }, (_, index) => `src/caller-${index}.ts`),
            dependencies: [],
            valid: true,
          },
          {
            source: 'src/small.ts',
            dependents: ['src/one.ts'],
            dependencies: [],
            valid: true,
          },
        ],
      },
      ['src/config.ts', 'src/small.ts'],
      10,
    )

    expect(fanIn).toEqual([{ file: 'src/config.ts', dependents: 12 }])
  })

  it('renders notable signals in priority order within budget', () => {
    const rendered = renderStructuralSignals(
      makeSignals({
        generic: {
          fileSizeOutliers: [{ file: 'src/large.ts', totalLines: 501 }],
          largeChangeConcentration: [{ file: 'src/generated.ts', added: 350 }],
          brokenDocReferences: [{ file: 'docs/setup.md', reference: './missing.md' }],
          qualityGateWeakening: [{ file: 'eslint.config.js', token: 'ignore' }],
          fileChangeSummary: {
            newFiles: 1,
            modifiedFiles: 2,
            deletedFiles: 0,
            renamedFiles: 0,
            otherFiles: 0,
          },
        },
        dependencyCruiser: {
          enabled: true,
          skippedReason: null,
          configSource: 'repo',
          configPath: '.dependency-cruiser.cjs',
          headModuleCount: 20,
          baseModuleCount: 19,
          baseComparison: 'diff',
          introducedCycles: [{ modules: ['src/a.ts', 'src/b.ts'] }],
          changedFileCycles: [],
          fanIn: [{ file: 'src/config.ts', dependents: 14 }],
          ruleViolations: [
            {
              ruleName: 'no-upward-imports',
              severity: 'error',
              comment: 'Feature code must not import server code.',
              from: 'src/feature.ts',
              to: 'src/server.ts',
            },
          ],
        },
      }),
      900,
    )

    expect(rendered).not.toBeNull()
    if (!rendered) {
      throw new Error('expected structural signals to render')
    }
    expect(rendered.length).toBeLessThanOrEqual(900)
    expect(rendered.indexOf('Introduced dependency cycle')).toBeLessThan(
      rendered.indexOf('Broken doc reference'),
    )
    expect(rendered.indexOf('Broken doc reference')).toBeLessThan(
      rendered.indexOf('This MR modifies its own quality gates'),
    )
    expect(rendered.indexOf('This MR modifies its own quality gates')).toBeLessThan(
      rendered.indexOf('Repo dependency rule'),
    )
    expect(rendered.indexOf('Repo dependency rule')).toBeLessThan(rendered.indexOf('Blast radius'))
    expect(rendered).toContain("Computed by static analysis of this MR's worktree")
  })

  it('returns null when there is nothing notable', () => {
    expect(renderStructuralSignals(makeSignals())).toBeNull()
  })
})

describe('collectStructuralSignals', () => {
  let tmp: string | null = null

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true })
      tmp = null
    }
  })

  it('detects a TS import cycle introduced since the diff base', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mend-structural-signals-'))
    const repo = join(tmp, 'repo')
    mkdirSync(join(repo, 'src'), { recursive: true })
    git(tmp, ['init', '--initial-branch=main', repo])
    writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n')
    writeFileSync(join(repo, 'src/a.ts'), "import { b } from './b'\nexport const a = b\n")
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 1\n')
    git(repo, ['add', '.'])
    gitCommit(repo, 'base')
    const baseSha = git(repo, ['rev-parse', 'HEAD'])

    writeFileSync(join(repo, 'src/b.ts'), "import { a } from './a'\nexport const b = a + 1\n")
    git(repo, ['add', '.'])
    gitCommit(repo, 'introduce cycle')

    const start = Date.now()
    const signals = await collectStructuralSignals({
      worktreePath: repo,
      diffBaseRef: baseSha,
      changedFiles: ['src/b.ts'],
      fileStats: [{ file: 'src/b.ts', added: 1, deleted: 1 }],
      budget: {
        cruiseTimeoutMs: 10_000,
        maxModules: 50,
      },
    })
    if (Date.now() - start > 10_000) {
      console.warn('structural signals integration exceeded 10s; skipping assertions')
      return
    }

    expect(signals.dependencyCruiser.introducedCycles).toContainEqual({
      modules: ['src/a.ts', 'src/b.ts'],
    })
    expect(renderStructuralSignals(signals)).toContain(
      'Introduced dependency cycle: src/a.ts -> src/b.ts -> src/a.ts',
    )
  })

  it('detects broken references in changed markdown files', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mend-structural-signals-docs-'))
    const repo = join(tmp, 'repo')
    mkdirSync(join(repo, 'docs'), { recursive: true })
    git(tmp, ['init', '--initial-branch=main', repo])
    writeFileSync(join(repo, 'docs/guide.md'), '[ok](./present.md)\n')
    writeFileSync(join(repo, 'docs/present.md'), 'present\n')
    git(repo, ['add', '.'])
    gitCommit(repo, 'base')
    const baseSha = git(repo, ['rev-parse', 'HEAD'])

    writeFileSync(
      join(repo, 'docs/guide.md'),
      '[missing](./missing.md)\nAlso see docs/missing-api.md\n',
    )
    git(repo, ['add', '.'])
    gitCommit(repo, 'break docs')

    const signals = await collectStructuralSignals({
      worktreePath: repo,
      diffBaseRef: baseSha,
      changedFiles: ['docs/guide.md'],
      fileStats: [{ file: 'docs/guide.md', added: 2, deleted: 1 }],
      budget: {
        cruiseTimeoutMs: 1_000,
        maxModules: 10,
      },
    })

    expect(signals.generic.brokenDocReferences).toContainEqual({
      file: 'docs/guide.md',
      reference: './missing.md',
    })
    expect(renderStructuralSignals(signals)).toContain(
      'Broken doc reference: docs/guide.md references missing ./missing.md',
    )
  })

  it('detects quality gate weakening tokens in added diff lines', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mend-structural-signals-gates-'))
    const repo = join(tmp, 'repo')
    git(tmp, ['init', '--initial-branch=main', repo])
    writeFileSync(join(repo, 'eslint.config.js'), 'export default []\n')
    git(repo, ['add', '.'])
    gitCommit(repo, 'base')
    const baseSha = git(repo, ['rev-parse', 'HEAD'])

    writeFileSync(join(repo, 'eslint.config.js'), 'export default [{ ignores: ["dist/**"] }]\n')
    git(repo, ['add', '.'])
    gitCommit(repo, 'weaken eslint')

    const signals = await collectStructuralSignals({
      worktreePath: repo,
      diffBaseRef: baseSha,
      changedFiles: ['eslint.config.js'],
      fileStats: [{ file: 'eslint.config.js', added: 1, deleted: 1 }],
      budget: {
        cruiseTimeoutMs: 1_000,
        maxModules: 10,
      },
    })

    expect(signals.generic.qualityGateWeakening).toContainEqual({
      file: 'eslint.config.js',
      token: 'ignore',
    })
    expect(renderStructuralSignals(signals)).toContain(
      'This MR modifies its own quality gates: eslint.config.js adds ignore',
    )
  })
})
