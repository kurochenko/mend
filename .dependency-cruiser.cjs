module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment:
        'Circular dependencies make workflow, provider, and harness ownership hard to reason about.',
      severity: 'error',
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: 'no-agent-harness-imports-posting',
      comment:
        'Agent harnesses run coding agents. They must not know Git provider posting, workflow steps, or persistence.',
      severity: 'error',
      from: {
        path: '^src/agents/',
      },
      to: {
        path: '^src/(integrations/(gitlab|repo)|mastra/steps|server|db)/',
      },
    },
    {
      name: 'no-integration-imports-workflow-server-or-db',
      comment:
        'Integration adapters should stay below review orchestration. Keep provider-specific transport out of Mastra/server/db layers.',
      severity: 'error',
      from: {
        path: '^src/integrations/',
      },
      to: {
        path: '^src/(mastra|server|db)/',
      },
    },
    {
      name: 'no-db-imports-server-or-workflow',
      comment:
        'Database modules own persistence only. Server/workflow orchestration belongs above them.',
      severity: 'error',
      from: {
        path: '^src/db/',
      },
      to: {
        path: '^src/(mastra|server)/',
      },
    },
    {
      name: 'no-lib-imports-application-layers',
      comment:
        'Shared lib modules must stay neutral and not depend on server, Mastra, db, integrations, or agent harness layers.',
      severity: 'error',
      from: {
        path: '^src/lib/',
      },
      to: {
        path: '^src/(server|mastra|db|integrations|agents)/',
      },
    },
  ],
  options: {
    doNotFollow: {
      path: '(node_modules|\\.beads|\\.codex|\\.opencode|\\.skillbook|dist|fixtures|sessions|workspaces)',
    },
    enhancedResolveOptions: {
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.mjs', '.cjs'],
      exportsFields: ['exports'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    includeOnly: '^(src|tools|scripts)/',
    reporterOptions: {
      text: { highlightFocused: true },
    },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
}
