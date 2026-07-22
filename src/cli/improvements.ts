import { loadConfig, type AppConfig } from '@/config'
import { closeDb, initDb } from '@/db/client'
import {
  findImprovementProposalsByIdPrefix,
  listImprovementProposals,
  setImprovementProposalStatus,
  type ImprovementProposalRecord,
} from '@/db/improvement-proposals'
import { improvementProposalStatusValues, type ImprovementProposalStatus } from '@/db/schema'
import { runImprovementDigest } from '@/mastra/improvements/miner'

export type ResolvePrefixResult =
  | { kind: 'match'; record: ImprovementProposalRecord }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: ImprovementProposalRecord[] }

export const resolveProposalByPrefix = (
  matches: ImprovementProposalRecord[],
): ResolvePrefixResult => {
  const [first, ...rest] = matches
  if (!first) {
    return { kind: 'none' }
  }
  if (rest.length > 0) {
    return { kind: 'ambiguous', matches }
  }
  return { kind: 'match', record: first }
}

export const parseStatusFlag = (args: string[]): ImprovementProposalStatus | undefined => {
  const index = args.indexOf('--status')
  if (index === -1) {
    return undefined
  }
  const value = args[index + 1]
  if (!value) {
    throw new Error('--status requires a value')
  }
  if (!(improvementProposalStatusValues as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid status: ${value}. Expected one of ${improvementProposalStatusValues.join(', ')}`,
    )
  }
  return value as ImprovementProposalStatus
}

const truncate = (value: string, width: number): string => {
  if (value.length <= width) {
    return value.padEnd(width, ' ')
  }
  return `${value.slice(0, Math.max(0, width - 1))}…`
}

const printUsage = (): void => {
  console.log('Usage: bun run improvements digest')
  console.log('   or: bun run improvements list [--status proposed]')
  console.log('   or: bun run improvements accept <id>')
  console.log('   or: bun run improvements dismiss <id>')
}

const printProposals = (rows: ImprovementProposalRecord[]): void => {
  if (rows.length === 0) {
    console.log('No proposals found.')
    return
  }

  const header = [
    truncate('ID', 10),
    truncate('PROJECT', 18),
    truncate('TYPE', 12),
    truncate('OCC', 5),
    truncate('STATUS', 10),
    truncate('TITLE', 50),
  ].join('  ')
  console.log(header)

  for (const row of rows) {
    const line = [
      truncate(row.id.slice(0, 8), 10),
      truncate(row.projectKey, 18),
      truncate(row.proposalType, 12),
      truncate(String(row.occurrenceCount), 5),
      truncate(row.status, 10),
      truncate(row.title, 50),
    ].join('  ')
    console.log(line)
  }
}

const runDigest = async (config: AppConfig): Promise<void> => {
  const summaries = await runImprovementDigest(config)
  if (summaries.length === 0) {
    console.log('No projects had findings to digest.')
    return
  }
  for (const summary of summaries) {
    console.log(
      `${summary.projectKey}: examined ${summary.findingsExamined} findings, created ${summary.clustersCreated}, extended ${summary.clustersExtended}`,
    )
  }
}

const runList = async (args: string[]): Promise<void> => {
  const status = parseStatusFlag(args)
  const rows = await listImprovementProposals({ status })
  printProposals(rows)
}

const runSetStatus = async (
  prefix: string | undefined,
  status: ImprovementProposalStatus,
): Promise<void> => {
  if (!prefix) {
    console.error('An id (or unambiguous prefix) is required.')
    process.exitCode = 1
    return
  }

  const matches = await findImprovementProposalsByIdPrefix(prefix)
  const resolved = resolveProposalByPrefix(matches)
  if (resolved.kind === 'none') {
    console.error(`No proposal matches id prefix "${prefix}".`)
    process.exitCode = 1
    return
  }
  if (resolved.kind === 'ambiguous') {
    console.error(`Ambiguous id prefix "${prefix}" matches ${resolved.matches.length} proposals:`)
    for (const match of resolved.matches) {
      console.error(`  ${match.id} — ${match.title}`)
    }
    process.exitCode = 1
    return
  }

  const updated = await setImprovementProposalStatus({ id: resolved.record.id, status })
  if (!updated) {
    console.error(`Failed to update proposal ${resolved.record.id}.`)
    process.exitCode = 1
    return
  }
  console.log(`${updated.id} → ${updated.status}`)
}

const main = async (): Promise<void> => {
  const args = Bun.argv.slice(2)
  const command = args[0]

  if (!command || command === 'help' || command === '--help') {
    printUsage()
    return
  }

  const config = loadConfig()
  await initDb(config.env.DATABASE_URL)

  switch (command) {
    case 'digest':
      await runDigest(config)
      return
    case 'list':
      await runList(args.slice(1))
      return
    case 'accept':
      await runSetStatus(args[1], 'accepted')
      return
    case 'dismiss':
      await runSetStatus(args[1], 'dismissed')
      return
    default:
      printUsage()
      process.exitCode = 1
      return
  }
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await closeDb()
    })
}
