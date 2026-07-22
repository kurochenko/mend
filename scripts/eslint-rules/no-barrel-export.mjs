const reExportNodeTypes = new Set(['ExportAllDeclaration', 'ExportNamedDeclaration'])

export const noBarrelExport = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow re-export-only barrel modules.',
    },
    messages: {
      noBarrelExport:
        'Do not create re-export-only barrel modules. Import the concrete module instead.',
    },
    schema: [],
  },
  create(context) {
    return {
      Program(node) {
        const statements = node.body
        if (statements.length === 0) return

        const onlyReExports = statements.every((statement) => {
          if (!reExportNodeTypes.has(statement.type)) return false
          return 'source' in statement && statement.source !== null
        })

        if (!onlyReExports) return
        context.report({ node, messageId: 'noBarrelExport' })
      },
    }
  },
}
