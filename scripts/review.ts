import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const baseIndex = args.indexOf('--base')
const base = baseIndex >= 0 ? args[baseIndex + 1] : 'HEAD'

if (!base) {
  throw new Error('Missing value for --base')
}

type Finding = {
  severity: 'error' | 'warn'
  message: string
}

const reviewPathspecs = [
  '.',
  ':!.beads/**',
  ':!.codex/**',
  ':!.cursor/**',
  ':!.opencode/**',
  ':!.pi/**',
  ':!.skillbook/**',
  ':!drizzle/**',
  ':!fixtures/**',
  ':!sessions/**',
  ':!workspaces/**',
]

const run = (command: [string, ...string[]]): string => {
  const [executable, ...commandArgs] = command
  const result = spawnSync(executable, commandArgs, {
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    const commandText = command.join(' ')
    const stderrOutput = result.stderr.trim()
    const stderr =
      stderrOutput.length > 0 ? stderrOutput : (result.error?.message ?? 'No stderr output')
    throw new Error(`Command failed: ${commandText}\n${stderr}`)
  }

  return result.stdout
}

const changedFiles = run(['git', 'diff', '--name-only', base, '--', ...reviewPathspecs])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

const addedLines = run(['git', 'diff', '--unified=0', base, '--', ...reviewPathspecs])
  .split('\n')
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))

const findings: Finding[] = []

const addFinding = (severity: Finding['severity'], message: string): void => {
  findings.push({ severity, message })
}

const forbiddenFiles = [
  /^\.env(?:\.|$)/,
  /^sessions\//,
  /^workspaces\//,
  /^logs\//,
  /\.log$/,
  /^\.DS_Store$/,
]

for (const file of changedFiles) {
  if (forbiddenFiles.some((pattern) => pattern.test(file))) {
    addFinding('error', `Forbidden local/runtime artifact in diff: ${file}`)
  }
}

const addedCode = addedLines
  .filter((line) => !line.startsWith('+const forbiddenAddedPatterns'))
  .filter((line) => !line.includes("message: 'Potential secret/env token access added"))
  .filter((line) => !line.includes('process\\.env'))
  .join('\n')

const forbiddenAddedPatterns: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\.(only|skip)\s*\(/, message: 'Skipped or focused test marker added' },
  {
    pattern: /\bTODO\b|\bFIXME\b/,
    message: 'Task marker added; use a Beads ticket or implement now',
  },
  {
    pattern: /process\.env\.[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/,
    message: 'Potential secret/env token access added; verify it stays server-side and safe',
  },
]

for (const { pattern, message } of forbiddenAddedPatterns) {
  if (pattern.test(addedCode)) {
    addFinding('error', message)
  }
}

const behaviorFiles = changedFiles.filter(
  (file) =>
    /^src\/(mastra|server|agents|git-service|integrations|db|lib)\//.test(file) &&
    file.endsWith('.ts') &&
    !file.endsWith('.test.ts'),
)

for (const file of behaviorFiles) {
  const testCandidate = file.replace(/\.ts$/, '.test.ts')
  const hasSiblingTest = changedFiles.includes(testCandidate)
  if (!hasSiblingTest) {
    addFinding('warn', `Behavior file changed without sibling test change: ${file}`)
  }
}

if (findings.length === 0) {
  console.log('Review scan clean.')
  process.exit(0)
}

for (const finding of findings) {
  console.log(`${finding.severity.toUpperCase()}: ${finding.message}`)
}

const hasErrors = findings.some((finding) => finding.severity === 'error')
process.exit(hasErrors ? 2 : 0)
