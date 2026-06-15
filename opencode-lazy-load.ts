/**
 * opencode-lazy-load
 *
 * Strips BOTH full tool descriptions AND parameter schemas so thousands of
 * tokens of tool definitions are NOT sent every message. The LLM calls
 * load_tool() on-demand to receive the original full instructions + schema
 * before using a tool.
 *
 * What gets sent per message for each built-in tool:
 *   description  → tiny pointer  ("Call load_tool("edit") first. Edit a file.")
 *   parameters   → {}  (empty object, zero schema info sent to LLM)
 *
 * Only load_tool itself is sent with full schema every message (tiny, one tool).
 *
 * Original descriptions and schemas are preserved 100% — never compressed, never destroyed.
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
 *     "plugin": [["file:///.opencode/plugin/lazy-load.ts", { "enforce": true }]]
 *   }
 *   enforce (default: true) — Block tool execution until load_tool is called.
 *   Set to false to allow tools to run without loading.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * Full original descriptions keyed by toolID.
 * Populated when tool.definition fires for each tool.
 * Never cleared — descriptions are static across the process lifetime.
 */
const originals = new Map<string, string>()

/**
 * Original JSON schemas keyed by toolID.
 * Saved from output.jsonSchema in the tool.definition hook so load_tool
 * can return the full parameter info to the LLM on demand.
 */
const originalSchemas = new Map<string, any>()

/**
 * Per-session tracking of which tools have been loaded.
 * Keyed by sessionID so different sessions don't leak state.
 * Auto-pruned when the set grows beyond MAX_SESSIONS to prevent
 * unbounded memory growth in long-running processes.
 */
const MAX_SESSIONS = 200
const sessionLoaded = new Map<string, Set<string>>()

/** Remove oldest session entries if the map exceeds the limit. */
function pruneSessions() {
  if (sessionLoaded.size <= MAX_SESSIONS) return
  // Map iterates in insertion order, so the first entries are the oldest
  const excess = sessionLoaded.size - MAX_SESSIONS
  let count = 0
  for (const key of sessionLoaded.keys()) {
    if (count++ >= excess) break
    sessionLoaded.delete(key)
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract a brief one-line summary from a full tool description.
 * Takes the first sentence or first line (whichever is shorter),
 * cleans up template variable remnants, and truncates to ~80 chars.
 */
function briefOf(description: string): string {
  if (!description) return ""
  const byPeriod = description.split(".")[0]
  const byNewline = description.split("\n")[0].trim()
  let candidate = byPeriod.length <= byNewline.length ? byPeriod : byNewline
  // Clean up any unexpanded template variable remnants like ${intro}
  candidate = candidate.replace(/\$\{[^}]*\}/g, "").trim()
  if (candidate.length < 5) return ""
  return candidate.length > 80 ? candidate.slice(0, 77) + "..." : candidate
}

/**
 * Minimal JSON schema — the absolute minimum providers accept.
 * Must have type:"object" or DeepSeek/others reject it.
 * Contains zero property info — the LLM learns nothing about
 * what arguments a tool accepts until it calls load_tool().
 */
const EMPTY_SCHEMA = { type: "object" }

// ─── Plugin ──────────────────────────────────────────────────────────────────

const LazyLoadPlugin: Plugin = async (_input, options) => {
  const opts = options as Record<string, unknown> | undefined
  const enforce = opts?.enforce !== false // default: true

  return {

    // ── New tool: load_tool ──────────────────────────────────────────────────

    tool: {
      load_tool: tool({
        description: [
          "Load full usage instructions for a tool.",
          "Call this BEFORE using any tool for the first time in a session.",
          "Returns the complete original instructions and parameter schema that",
          "teach the model how to use the tool properly. Must be called once per",
          "tool per session.",
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
          const schema = originalSchemas.get(args.name)

          if (!full) {
            const available = Array.from(originals.keys()).sort().join(", ")
            return {
              title: `Unknown tool: ${args.name}`,
              output: `No instructions found for "${args.name}". Available tools: ${available}`,
            }
          }

          // Mark this tool as loaded for the current session
          if (!sessionLoaded.has(context.sessionID)) {
            sessionLoaded.set(context.sessionID, new Set())
            pruneSessions()
          }
          sessionLoaded.get(context.sessionID)!.add(args.name)

          // Build output: full description + parameter schema
          let output = full
          if (schema) {
            try {
              output += "\n\n--- Parameter schema ---\n" + JSON.stringify(schema, null, 2)
            } catch {
              // If schema can't be serialized, skip it
            }
          }

          return {
            title: `Loaded: ${args.name}`,
            output,
          }
        },
      }),
    },

    // ── Hook: tool.definition ────────────────────────────────────────────────
    //
    // Saves the original full description and JSON schema on first encounter,
    // then replaces them with tiny versions:
    //   - description → pointer + brief summary
    //   - jsonSchema  → {}  (empty, zero parameter info sent to LLM)
    //
    // output.parameters (Effect Schema) is left UNTOUCHED — it is NEVER sent
    // to the LLM. It's only used server-side by opencode to validate tool call
    // arguments. Only jsonSchema travels over the wire to the LLM API.

    async "tool.definition"(input, output) {
      // Never modify our own tool
      if (input.toolID === "load_tool") return

      // Save original description on first encounter
      if (!originals.has(input.toolID)) {
        originals.set(input.toolID, output.description)
      }

      // Save original jsonSchema so load_tool can return the full schema
      const outAny = output as any
      if (outAny.jsonSchema !== undefined && !originalSchemas.has(input.toolID)) {
        originalSchemas.set(input.toolID, outAny.jsonSchema)
      }

      // Strip description to tiny pointer
      const brief = briefOf(originals.get(input.toolID)!)
      output.description = brief
        ? `Call load_tool("${input.toolID}") first. ${brief}.`
        : `Call load_tool("${input.toolID}") before first use.`

      // Strip parameter schema to minimal — this is what the LLM sees in the API call
      // (output.parameters stays untouched so validation still works on the opencode side)
      outAny.jsonSchema = EMPTY_SCHEMA
    },

    // ── Hook: tool.execute.before ────────────────────────────────────────────
    //
    // Enforces that load_tool was called before a tool can execute.
    // When enforce=true (default), throws an error if the tool hasn't been
    // loaded in this session. The error message tells the LLM exactly what
    // to do, so it calls load_tool and retries.
    //
    // When enforce=false, this hook does nothing — tools run regardless.
    // The LLM might still use tools without loading, but token savings remain.

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
  }
}

// ─── Export (v1 plugin format) ───────────────────────────────────────────────

export default {
  id: "opencode-lazy-load",
  server: LazyLoadPlugin,
}
