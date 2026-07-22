---
name: excalidraw-mcp
description: Run the local Excalidraw canvas plus MCP server and use it to draw architecture, flow, and systems diagrams from Mermaid or direct canvas operations.
license: MIT
compatibility: opencode, claude-code, codex, cursor
metadata:
  audience: developers
  workflow: diagramming
---

# Excalidraw MCP

Use this skill when you need to create or update diagrams in a local Excalidraw canvas through MCP.

Prefer MCP tools over browser interaction.

## Runtime

- Canvas URL: `http://localhost:5500`
- Health URL: `http://localhost:5500/health`
- Default MCP env:
  - `EXPRESS_SERVER_URL=http://localhost:5500`
  - `ENABLE_CANVAS_SYNC=true`

## Start the canvas

If the canvas is not already running, start it with Docker:

```bash
docker run -d --name mcp-excalidraw-canvas -p 5500:3000 ghcr.io/yctimlin/mcp_excalidraw-canvas:latest
```

Verify it:

```bash
curl -sf http://localhost:5500/health
docker ps --filter name=mcp-excalidraw-canvas
```

If the container already exists but is stopped:

```bash
docker start mcp-excalidraw-canvas
```

## Start the MCP server

Preferred local command:

```bash
EXPRESS_SERVER_URL=http://localhost:5500 ENABLE_CANVAS_SYNC=true npx -y mcp-excalidraw-server
```

Docker alternative:

```bash
docker run --rm -i -e EXPRESS_SERVER_URL=http://host.docker.internal:5500 -e ENABLE_CANVAS_SYNC=true ghcr.io/yctimlin/mcp_excalidraw:latest
```

## MCP workflow

Use these tools in this order when available:

1. `clear_canvas`
2. `create_from_mermaid` for most architecture and flow diagrams
3. `query_elements` or `describe_scene` to verify the result
4. `export_to_image` or `get_canvas_screenshot` if you need a deliverable

Prefer `create_from_mermaid` unless you need precise element-level editing.

## Mermaid guidance

- Keep diagrams simple and explicit.
- Prefer `flowchart LR` or `flowchart TD`.
- Use short node labels.
- Avoid advanced Mermaid styling unless needed.
- If conversion fails, simplify subgraphs, classes, and heavy punctuation first.

Good starter shape:

```text
flowchart LR
  A["Webhook"] --> B["Queue"]
  B --> C["Workflow"]
  C --> D["Post results"]
```

## Direct canvas fallback

If MCP transport is unavailable but the canvas backend is running, the canvas can still ingest Mermaid through HTTP:

```bash
curl -sf -X POST http://localhost:5500/api/elements/from-mermaid \
  -H 'Content-Type: application/json' \
  --data-binary '{"mermaidDiagram":"flowchart LR\nA[Start]-->B[End]","config":{}}'
```

Clear the canvas through sync overwrite:

```bash
curl -sf -X POST http://localhost:5500/api/elements/sync \
  -H 'Content-Type: application/json' \
  --data-binary '{"elements":[],"timestamp":"2026-01-01T00:00:00Z"}'
```

Inspect the current scene:

```bash
curl -sf http://localhost:5500/api/elements
```

## Working rules

- Draw via MCP when the harness exposes the Excalidraw MCP server.
- Use the HTTP fallback only when MCP is not available in the current harness.
- Clear probe diagrams before drawing the final scene.
- After creating a diagram, verify the scene was populated before reporting success.
