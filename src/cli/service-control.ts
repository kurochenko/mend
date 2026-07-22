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
          `Waiting for ${counts.reviewQueueEntries} running review queue entr${counts.reviewQueueEntries === 1 ? 'y' : 'ies'} and ${counts.fixBatchEntries} running fix batch entr${counts.fixBatchEntries === 1 ? 'y' : 'ies'} to finish...`,
        )
      },
    },
  })
  console.log('No running queue entries or fix batches remain.')
}

const runRestartCommand = async (command: string[]): Promise<void> => {
  if (command.length === 0) {
    throw new Error('restart-safe requires a command after --')
  }

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

const main = async (): Promise<void> => {
  const args = Bun.argv.slice(2)
  const command = args[0]
  if (!command) {
    printUsage()
    process.exitCode = 1
    return
  }

  const config = loadConfig()
  await initDb(config.env.DATABASE_URL)

  if (command === 'status') {
    await printStatus()
    return
  }

  if (command === 'drain') {
    await setServiceRuntimeMode('draining')
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
    const separatorIndex = args.indexOf('--')
    const restartCommand = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1)

    await setServiceRuntimeMode('draining')
    console.log('Service mode set to draining.')
    await waitUntilIdle()
    await runRestartCommand(restartCommand)
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
