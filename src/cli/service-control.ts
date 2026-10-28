import { closeDb, initDb } from '@/db/client'
import { countPendingReviewQueueEntries, countRunningReviewQueueEntries } from '@/db/review-queue'
import { getServiceRuntimeMode, setServiceRuntimeMode } from '@/db/service-runtime'
import { loadConfig } from '@/config'
import { waitForDrainedWork } from '@/server/service-drain'

const printUsage = (): void => {
  console.log('Usage: bun run service-control status')
  console.log('   or: bun run service-control drain [--wait]')
  console.log('   or: bun run service-control resume')
  console.log('   or: bun run service-control restart-safe -- <command> [args...]')
}

const printStatus = async (): Promise<void> => {
  const [mode, running, deferred] = await Promise.all([
    getServiceRuntimeMode(),
    countRunningReviewQueueEntries(),
    countPendingReviewQueueEntries(),
  ])

  console.log(`Mode: ${mode}`)
  console.log(`Running queue entries: ${running}`)
  console.log(`Queued queue entries: ${deferred}`)
}

const waitUntilIdle = async (): Promise<void> => {
  await waitForDrainedWork({
    dependencies: {
      logStatus: (counts) => {
        console.log(
          `Waiting for ${counts.reviewQueueEntries} running review queue entr${counts.reviewQueueEntries === 1 ? 'y' : 'ies'} to finish...`,
        )
      },
    },
  })
  console.log('No running review queue entries remain.')
}

const runRestartCommand = async (command: string[]): Promise<void> => {
  const proc = Bun.spawn(command, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`Restart command failed with exit code ${exitCode}`)
  }
}

const SERVICE_CONTROL_COMMANDS = new Set(['status', 'drain', 'resume', 'restart-safe'])

type ServiceControlArgs =
  | { kind: 'help' }
  | { kind: 'invalid'; message: string | null }
  | { kind: 'run'; command: string; args: string[]; restartCommand: string[] }

const parseServiceControlArgs = (args: string[]): ServiceControlArgs => {
  const separatorIndex = args.indexOf('--')
  const ownArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex)
  const restartCommand = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1)
  const command = ownArgs[0]
  if (ownArgs.includes('--help') || ownArgs.includes('-h')) {
    return { kind: 'help' }
  }
  if (!command || !SERVICE_CONTROL_COMMANDS.has(command)) {
    return { kind: 'invalid', message: null }
  }
  if (command === 'restart-safe' && restartCommand.length === 0) {
    return { kind: 'invalid', message: 'restart-safe requires a command after --' }
  }
  return { kind: 'run', command, args: ownArgs, restartCommand }
}

const main = async (): Promise<void> => {
  const parsedArgs = parseServiceControlArgs(Bun.argv.slice(2))
  if (parsedArgs.kind !== 'run') {
    if (parsedArgs.kind === 'invalid') {
      if (parsedArgs.message) {
        console.error(parsedArgs.message)
      }
      process.exitCode = 1
    }
    printUsage()
    return
  }
  const { command, args, restartCommand } = parsedArgs

  const config = loadConfig()
  await initDb(config.env.DATABASE_URL)

  if (command === 'status') {
    await printStatus()
    return
  }

  if (command === 'drain') {
    await setServiceRuntimeMode('draining', 'operator')
    console.log('Service mode set to draining.')
    if (args.includes('--wait')) {
      await waitUntilIdle()
    }
    await printStatus()
    return
  }

  if (command === 'resume') {
    await setServiceRuntimeMode('running')
    console.log('Service mode set to running.')
    await printStatus()
    return
  }

  if (command === 'restart-safe') {
    await setServiceRuntimeMode('draining', 'operator')
    console.log('Service mode set to draining.')
    try {
      await waitUntilIdle()
      await runRestartCommand(restartCommand)
    } finally {
      await setServiceRuntimeMode('running')
      console.log('Service mode set to running.')
    }
    return
  }

  printUsage()
  process.exitCode = 1
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDb()
  })
