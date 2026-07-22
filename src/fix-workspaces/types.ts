import type { ProjectConfig } from '@/config'

export type WorkspaceProviderKind = 'docker'
export type WorkspaceCommandPhase = 'setup' | 'agent' | 'check' | 'command'
export type WorkspaceGitMode = 'host'

export interface WorkspaceCommandInput {
  command: string
  phase?: WorkspaceCommandPhase
  timeoutMs?: number
}

export interface WorkspaceCommandResult {
  command: string
  phase: WorkspaceCommandPhase
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export interface PreparedFixWorkspace {
  id: string
  provider: WorkspaceProviderKind
  hostWorktreePath: string
  workspaceCwd: string
  git: {
    mode: WorkspaceGitMode
    cwd: string
  }
  setupResults: WorkspaceCommandResult[]
  runCommand(input: WorkspaceCommandInput): Promise<WorkspaceCommandResult>
  runAgentCommand(
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<WorkspaceCommandResult>
  runChecks(): Promise<WorkspaceCommandResult[]>
  teardown(): Promise<void>
}

export interface PrepareFixWorkspaceInput {
  project: ProjectConfig
  mrIid: number
  worktreePath: string
  attemptId: string
}

export interface FixWorkspaceProvider {
  kind: WorkspaceProviderKind
  prepare(input: PrepareFixWorkspaceInput): Promise<PreparedFixWorkspace>
}
