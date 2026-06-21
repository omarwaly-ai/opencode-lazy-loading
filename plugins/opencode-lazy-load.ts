
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
 * ENFORCEMENT: mechanical, not prompt-based. The fetch wrapper intercepts the
 * LLM's SSE response stream. Any tool_call for a tool that hasn't been loaded
 * yet is rewritten in-flight to a load_tool({name: <tool>}) call — same
 * tool_call_id, same opencode bookkeeping. The LLM literally cannot call a
 * tool directly. No errors, no prompts, no blocking.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * Full original descriptions keyed by toolID (BUILT-IN tools only).
 * Populated when tool.definition fires for each tool.
 * Never cleared — descriptions are static across the process lifetime.
 */
const originals = new Map<string, string>()

/**
 * Original JSON schemas keyed by toolID (built-in tools).
 * Saved from output.jsonSchema in the tool.definition hook so load_tool
 * can return the full parameter info to the LLM on demand.
 */
const originalSchemas = new Map<string, any>()

/**
 * Full original descriptions for MCP tools, keyed by tool name.
 * MCP tools bypass the tool.definition hook (verified at session/tools.ts L117-201).
 * The fetch wrapper identifies MCP tools as: any tool in body.tools that's NOT
 * in `originals` (built-in) and NOT `load_tool`. Saves their description + schema
 * before stripping them from the HTTP body.
 */
const mcpOriginals = new Map<string, string>()
const mcpSchemas = new Map<string, any>()

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

// ─── Fetch wrapper for MCP tools ─────────────────────────────────────────────
// MCP tools bypass the tool.definition hook (verified at session/tools.ts
// L117-201). The fetch wrapper is the ONLY interception point.
//
// Detection: any tool in body.tools that's NOT in `originals` (populated by
// tool.definition for built-in tools) and NOT `load_tool` is an MCP tool.
// No config hook needed — no MCP server name matching — pure exclusion.
//
// opencode's provider closure (provider.ts L1693) uses `const fetchFn = customFetch ?? fetch`
// where `fetch` resolves to globalThis.fetch at CALL TIME, not definition time.
// So wrapping globalThis.fetch BEFORE the first LLM call works.
let _originalFetch: typeof fetch | null = null
let _fetchWrapped = false
function wrapFetch(): void {
  if (_fetchWrapped) return
  _fetchWrapped = true
  _originalFetch = globalThis.fetch
  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    const isLLM = url.includes("/v1/chat/completions") || url.includes("/v1/messages") ||
      url.includes("api.deepseek.com") || url.includes("api.openai.com") ||
      url.includes("anthropic.com") || url.includes("openrouter.ai")
    if (!isLLM || !init?.body) return _originalFetch!.call(globalThis, input, init)

    let bodyText = ""
    if (typeof init.body === "string") bodyText = init.body
    else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) bodyText = new TextDecoder().decode(init.body)
    else if (init.body instanceof Blob) bodyText = await init.body.text()
    else return _originalFetch!.call(globalThis, input, init)

    if (!bodyText) return _originalFetch!.call(globalThis, input, init)

    let modified = false
    let sessionID = ""
    // Extract sessionID from headers. NO shared fallback — that causes
    // cross-session state leaks. Per-request unique ID if header is missing.
    try {
      const h = init.headers
      const headers = h instanceof Headers ? h : Array.isArray(h) ? new Headers(h as any) : h ? new Headers(h as any) : new Headers()
      sessionID = headers.get("x-opencode-session") || headers.get("x-session-id") || headers.get("X-Session-Id") || ""
    } catch {}
    if (!sessionID) {
      sessionID = `__req_${Date.now()}_${Math.random().toString(36).slice(2)}__`
    }

    try {
      const body = JSON.parse(bodyText)
      if (Array.isArray(body.tools)) {
        // Get THIS session's loaded set
        const loaded = sessionLoaded.get(sessionID)
        for (const t of body.tools) {
          const name = t?.function?.name || t?.name || ""
          if (!name || name === "load_tool") continue
          // MCP tool = NOT in built-in originals map
          if (originals.has(name)) continue

          // If already loaded in THIS session, don't strip — send full tool
          if (loaded && loaded.has(name)) continue

          // Save original on first encounter
          const desc = t?.function?.description || t?.description || ""
          const params = t?.function?.parameters || t?.parameters || {}
          if (desc && !mcpOriginals.has(name)) {
            mcpOriginals.set(name, desc)
            mcpSchemas.set(name, params)
          }

          // Strip to tiny pointer
          const brief = briefOf(desc)
          const pointer = brief
            ? `Call load_tool("${name}") first. ${brief}.`
            : `Call load_tool("${name}") before first use.`
          if (t.function) {
            t.function.description = pointer
            t.function.parameters = EMPTY_SCHEMA
          } else {
            t.description = pointer
            t.parameters = EMPTY_SCHEMA
          }
          modified = true
        }
        if (modified) {
          init = { ...init, body: JSON.stringify(body) }
        }
      }
    } catch {
      // Body wasn't valid JSON — send as-is
    }
    const response = await _originalFetch!.call(globalThis, input, init)

    // ── Response-side: rewrite direct tool_calls to load_tool ──
    // Only intercept SSE streaming responses. If not SSE, return as-is.
    const contentType = response.headers.get("content-type") || ""
    if (!contentType.includes("text/event-stream") || !response.body) return response

    const transformed = response.body.pipeThrough(createSSETransform(sessionID))
    return new Response(transformed, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

// ─── SSE TransformStream ─────────────────────────────────────────────────────
//
// Parses OpenAI-compatible SSE chunks and rewrites tool_calls for unloaded
// tools into load_tool calls.
//
// Verified against @ai-sdk/openai-compatible (the SSE parser opencode uses):
//   - Line 758: iterates delta.tool_calls[]
//   - Line 776: reads toolName from delta.tool_calls[].function.name
//   - Line 783-785: stores toolCalls[index] = { function: { name, arguments } }
//   - Line 826: subsequent chunks APPEND to toolCalls[index].function.arguments
//   - Line 833: when accumulated args become parseable JSON, emits tool-call
//
// Rewrite strategy:
//   - First chunk for an index (has function.name): if name != "load_tool" AND
//     tool not loaded in this session, rewrite name → "load_tool" and set
//     arguments → JSON.stringify({name: originalName}). This immediately
//     becomes parseable JSON, so the AI SDK emits the tool-call event right
//     away with toolName="load_tool".
//   - Subsequent chunks for a rewritten index: set arguments to "" so the
//     AI SDK appends nothing (the tool-call already fired).
//   - Non-rewritten tool_calls: pass through unchanged.

function createSSETransform(sessionID: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  // Map from tool_call index → original tool name (only for rewritten calls)
  const rewrittenIndices = new Map<number, string>()

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })

      // SSE events are separated by \n\n (or \r\n\r\n for CRLF providers)
      const events = buffer.split(/\n\n|\r\n\r\n/)
      buffer = events.pop() || ""

      for (const event of events) {
        const lines = event.split(/\n|\r\n/)
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const data = line.startsWith("data: ") ? line.slice(6) : line.slice(5)
          if (data === "[DONE]") {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            continue
          }

          try {
            const parsed = JSON.parse(data)
            // OpenAI-compatible: choices[0].delta.tool_calls[]
            const toolCalls = parsed?.choices?.[0]?.delta?.tool_calls
            if (Array.isArray(toolCalls)) {
              for (const tc of toolCalls) {
                if (!tc || !tc.function) continue

                if (tc.function.name) {
                  // First chunk for this tool_call index — has the tool name
                  const name = tc.function.name
                  if (name !== "load_tool") {
                    const loaded = sessionLoaded.get(sessionID)
                    if (!loaded || !loaded.has(name)) {
                      // Tool not loaded — rewrite to load_tool({name})
                      rewrittenIndices.set(tc.index, name)
                      tc.function.name = "load_tool"
                      tc.function.arguments = JSON.stringify({ name })
                    }
                  }
                } else if (rewrittenIndices.has(tc.index) && tc.function.arguments !== undefined) {
                  // Continuation of a rewritten tool_call — drop the args piece.
                  // We already sent the full rewritten args in the first chunk.
                  tc.function.arguments = ""
                }
              }
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`))
          } catch {
            // Not valid JSON — pass through unchanged
            controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          }
        }
      }
    },
    flush(controller) {
      // Flush any remaining buffered bytes
      if (buffer) {
        controller.enqueue(encoder.encode(buffer))
      }
    },
  })
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

const LazyLoadPlugin: Plugin = async (_input, _options) => {
  // Wrap fetch to intercept MCP tools in the HTTP body (request side) and
  // rewrite direct tool_calls to load_tool (response side).
  wrapFetch()

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
          // Check built-in originals (from tool.definition) AND MCP originals (from fetch wrapper)
          let full = originals.get(args.name) || mcpOriginals.get(args.name)
          let schema = originalSchemas.get(args.name) || mcpSchemas.get(args.name)

          if (!full) {
            const allKnown = Array.from(new Set([...originals.keys(), ...mcpOriginals.keys()])).sort()
            return {
              title: `Unknown tool: ${args.name}`,
              output: `No instructions found for "${args.name}". Available tools: ${allKnown.join(", ")}`,
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
  }
}

// ─── Export (v1 plugin format) ───────────────────────────────────────────────

export default {
  id: "opencode-lazy-load",
  server: LazyLoadPlugin,
}
