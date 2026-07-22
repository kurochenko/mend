import type { ProjectConfig } from '@/config'
import { DockerFixWorkspaceProvider } from '@/fix-workspaces/docker-provider'
import type { FixWorkspaceProvider } from '@/fix-workspaces/types'

export const createFixWorkspaceProvider = (project: ProjectConfig): FixWorkspaceProvider => {
  const provider = project.review.fix.workspace?.provider
  if (provider === 'docker') {
    return new DockerFixWorkspaceProvider()
  }

  throw new Error(`Project ${project.key} has no fixer workspace provider configured`)
}
