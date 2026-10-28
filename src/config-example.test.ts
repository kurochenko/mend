import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseProjectsFileConfig, type ProjectsFileConfig } from '@/config'

const exampleText = readFileSync(resolve(import.meta.dir, '..', 'mend.example.yml'), 'utf-8')

const withDummyEnvValues = (text: string): string =>
  text.replace(/\$\{([^}]+)}/g, (_match, name: string) =>
    name.endsWith('SIGNING_TOKEN') ? 'whsec_dGVzdA==' : `dummy-${name.toLowerCase()}`,
  )

const uncommentExamples = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*##/.test(line))
    .map((line) => line.replace(/^(\s*)# /, '$1'))
    .join('\n')

const parseExample = (text: string): ProjectsFileConfig =>
  parseProjectsFileConfig(parseYaml(withDummyEnvValues(text)))

const allProjects = (config: ProjectsFileConfig) => Object.entries(config.projects)

describe('mend.example.yml', () => {
  test('active configuration parses with the real schema', () => {
    const config = parseExample(exampleText)

    expect(Object.keys(config.projects)).toEqual(['backend'])
  })

  test('every commented example parses with the real schema once uncommented', () => {
    const config = parseExample(uncommentExamples(exampleText))

    expect(Object.keys(config.projects)).toEqual(['backend', 'internal-app', 'github-app'])
    expect(config.improvements.enabled).toBe(false)
  })

  test('examples avoid the unimplemented label trigger mode', () => {
    const config = parseExample(uncommentExamples(exampleText))

    for (const [, project] of allProjects(config)) {
      expect(project.trigger.mode).not.toBe('label')
    }
  })

  test('pi harness examples use provider/model ids', () => {
    const config = parseExample(uncommentExamples(exampleText))

    for (const [, project] of allProjects(config)) {
      const { agent, llm } = project.review
      if (agent.harness === 'pi') {
        expect(agent.model ?? llm.model).toContain('/')
      }
    }
  })

  test('flag examples list every review flag', () => {
    const config = parseExample(uncommentExamples(exampleText))
    const exampleFlags = Object.keys(
      parseYaml(uncommentExamples(exampleText)).projects.backend.review.flags,
    )

    expect(exampleFlags.sort()).toEqual(
      Object.keys(config.projects.backend?.review.flags ?? {}).sort(),
    )
  })
})
