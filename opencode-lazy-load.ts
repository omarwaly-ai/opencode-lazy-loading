/**
 * opencode-lazy-load
 *
 * Replaces full tool descriptions with tiny pointers so ~4-5k tokens of
 * tool definitions are NOT sent every message. The LLM calls load_tool()
 * on-demand to receive the original full instructions before using a tool.
 *
 * Original .txt definitions are preserved 100% — never compressed, never destroyed.
 *
 * INSTALL:
 *   Place this file at .opencode/plugin/lazy-load.ts
 *   Opencode auto-discovers plugins from .opencode/plugin/
 *
 * REMOVE:
 *   Delete the file. Everything returns to normal immediately.
 *   No permanent changes, no config edits required.
 *
 * OPTIONAL CONFIG (opencode.json):
 *   {
 *     "plugin": [["file///.opencode/plugin/lazy-load.ts", { "enforce": true }]]
 *   }
 *   enforce (default: true) — Block tool execution until load_tool is called.
 *   Set to false to allow tools to run without loading.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

// ─── State ───────────────────────────────────────────────────────────────────

// Full original tool descriptions, keyed by tool ID.
// Updated every time tool.definition fires so descriptions never go stale.
const originals = new Map<string, string>()

// Per-session set of tool names the agent has already loaded.
const sessionLoaded = new Map<string, Set<string>>()

// ─── Helpers ─────────────────────────────────────────────────────────────────

function briefOf(description: string): string {
  if (!description) return ""
  const byPeriod = description.split(".")[0] ?? ""
  const byNewline = description.split("\n")[0]?.trim() ?? ""
  let candidate = byPeriod.length <= byNewline.length ? byPeriod : byNewline
  candidate = candidate.replace(/\$\{[^}]*\}/g, "").trim()
  if (candidate.length < 5) return ""
  return candidate.length > 80 ? candidate.slice(0, 77) + "..." : candidate
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

const LazyLoadPlugin: Plugin = async (_input, options) => {
  const opts = options as Record<string, unknown> | undefined
  const enforce = opts?.enforce !== false // default: true

  return {

    tool: {
      load_tool: tool({
        description: [
          "Load full usage instructions for a tool.",
          "Call this BEFORE using any tool for the first time in a session.",
          "Returns the complete original instructions that teach the model how",
          "to use the tool properly. Must be called once per tool per session.",
        ].join(" "),
        args: {
          name: tool.schema
            .string()
            .describe(
              "Tool name to load instructions for (e.g. 'shell', 'edit', 'read', 'write')",
            ),
        },
        async execute(args, context) {
          const full = originals.get(args.name)

          if (!full) {
            const available = Array.from(originals.keys()).sort().join(", ")
            return {
              title: `Unknown tool: ${args.name}`,
              output: `No instructions found for "${args.name}". Available tools: ${available}`,
            }
          }

          if (!sessionLoaded.has(context.sessionID)) {
            sessionLoaded.set(context.sessionID, new Set())
          }
          sessionLoaded.get(context.sessionID)!.add(args.name)

          return {
            title: `Loaded: ${args.name}`,
            output: full,
          }
        },
      }),
    },

    async "tool.definition"(input, output) {
      if (input.toolID === "load_tool") return

      // Always update so descriptions never go stale.
      originals.set(input.toolID, output.description)

      const brief = briefOf(output.description)
      output.description = brief
        ? `Call load_tool("${input.toolID}") first. ${brief}.`
        : `Call load_tool("${input.toolID}") before first use.`
    },

    async "tool.execute.before"(input, _output) {
      if (!enforce) return
      if (input.tool === "load_tool") return

      const loaded = sessionLoaded.get(input.sessionID)
      if (!loaded || !loaded.has(input.tool)) {
        throw new Error(
          `Tool "${input.tool}" not loaded yet. Call load_tool("${input.tool}") first.`,
        )
      }
    },

    async "event"({ event }) {
      // Clean up session state when a session is deleted.
      if (event.type === "session.deleted") {
        const sessionID = (event.properties as { sessionID?: string }).sessionID
        if (sessionID) sessionLoaded.delete(sessionID)
      }
    },

  }
}

export default {
  id: "opencode-lazy-load",
  server: LazyLoadPlugin,
}
