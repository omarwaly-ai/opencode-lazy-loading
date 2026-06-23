/**
 * opencode-lazy-load
 *
 * Strips ALL tool definitions from every LLM request. The LLM only sees
 * load_tool as a callable tool. To use any other tool (built-in, user-installed,
 * or MCP), the LLM must call load_tool — there is no other path.
 *
 * What gets sent per message:
 *   body.tools   → [load_tool] only (every other tool is REMOVED from the array)
 *   load_tool.description → includes pointer list of available tools
 *
 * Two modes:
 *   load_tool({name: "read"})                    → returns full instructions + schema
 *   load_tool({name: "read", args: {path: "/x"}}) → executes read({path: "/x"})
 *
 * The execute mode is rewritten in the SSE response stream before opencode
 * sees it, so opencode dispatches the real tool normally.
 *
 * INSTALL:
 *   Place this file at .opencode/plugin/lazy-load.ts
 *   Opencode auto-discovers plugins from .opencode/plugin/
 *
 * REMOVE:
 *   Delete the file. Everything returns to normal immediately.
 *
 * ENFORCEMENT: mechanical, not prompt-based. The LLM literally cannot call
 * any tool directly — the tool is not in the array. No throw, no error,
 * no prompt.
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
 * Full original descriptions for MCP tools, keyed by tool name.
 * MCP tools bypass the tool.definition hook (verified at session/tools.ts
 * L117-201). The fetch wrapper identifies MCP tools as: any tool in
 * body.tools that's NOT in `originals` (built-in) and NOT `load_tool`.
 * Saves their description + schema before removing them from the HTTP body.
 */
const mcpOriginals = new Map<string, string>()
const mcpSchemas = new Map<string, any>()

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Hardcoded pointers for built-in tools only.
 * Each entry has a Description (what) and Usage (when to use).
 * User-installed and MCP tools use briefOf (first line only).
 */
const BUILTIN_POINTERS: Record<string, { desc: string; usage: string }> = {
  bash: {
    desc: "Executes a given bash command in a persistent shell session.",
    usage: "This tool is for terminal operations like git, npm, docker, etc.",
  },
  read: {
    desc: "Read a file or directory from the local filesystem.",
    usage: "Use this tool when you want to read a files or directories also the tool can read image files and PDFs",
  },
  glob: {
    desc: "Fast file pattern matching tool.",
    usage: "Use this tool when you need to find files by name patterns",
  },
  grep: {
    desc: "Searches or filter file contents using regular expressions",
    usage: "Use when you need to find files containing specific patterns.",
  },
  edit: {
    desc: "Performs exact string replacements in files.",
    usage: "use your Read tool at least once before editing, Use it for rewrite, optimize, Replacement, clean up existing files",
  },
  write: {
    desc: "Writes a file to the local filesystem.",
    usage: "use your Read tool at least once in the conversation before writing, Use this tool when you need to write files to the local filesystem or codebase.",
  },
  task: {
    desc: "Launch a new agent to handle complex, multistep tasks autonomously.",
    usage: "Launch subagents to do specific tasks or multiple tasks.",
  },
  websearch: {
    desc: "Performs real-time web searches and can scrape content from specific URLs",
    usage: "Use this tool when you need to search the web, Web documentation, Github repos.",
  },
  webfetch: {
    desc: "Fetches a single or multiple URLs content",
    usage: "Do not use this tool for web search, Use this tool only if you have specific URL or set of URLs to fetch.",
  },
  todowrite: {
    desc: "Create and maintain a structured task list for the current coding session, Tracks progress, organizes multi-step work, and surfaces status to the user.",
    usage: "Use this tool when The task requires 3+ distinct steps or actions, Create Todo list, user provides multiple tasks or New instructions arrive. Use proactively when:",
  },
  skill: {
    desc: "Load a specialized skill when the task at hand matches one of the skills listed in the system prompt.",
    usage: "Use this tool to inject the skill's instructions and resources into current conversation.",
  },
  question: {
    desc: "Gather user preferences or requirements, Clarify ambiguous instructions.",
    usage: "Use this tool when you need to ask the user questions during execution.",
  },
}

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
  candidate = candidate.replace(/\$\{[^}]*\}/g, "").trim()
  candidate = candidate.replace(/^[-•]\s+/, "").trim()
  if (candidate.length < 5) return ""
  return candidate.length > 80 ? candidate.slice(0, 77) + "..." : candidate
}

/**
 * Build the pointer list for load_tool's description.
 * Built-in tools: use hardcoded Description + Usage (2 lines).
 * User-installed tools: use briefOf (1 line).
 * MCP tools: use briefOf (1 line).
 */
function buildPointerList(): string {
  const pointers: string[] = []
  for (const [name, _desc] of originals) {
    if (name === "load_tool") continue
    if (BUILTIN_POINTERS[name]) {
      const p = BUILTIN_POINTERS[name]
      pointers.push(`- ${name}\n  Description: ${p.desc}\n  Usage: ${p.usage}`)
    } else {
      const brief = briefOf(_desc)
      pointers.push(brief ? `- ${name} - ${brief}` : `- ${name}`)
    }
  }
  for (const [name, desc] of mcpOriginals) {
    const brief = briefOf(desc)
    pointers.push(brief ? `- ${name} - ${brief}` : `- ${name}`)
  }
  return pointers.sort().join("\n")
}

/**
 * Check if a string is parseable as complete JSON.
 * (Same logic as @ai-sdk/openai-compatible's isParsableJson.)
 */
function isParsableJson(str: string): boolean {
  if (!str) return false
  try { JSON.parse(str); return true } catch { return false }
}

// ─── Fetch wrapper (request + response interception) ─────────────────────────
//
// REQUEST side: Remove ALL tools except load_tool from body.tools. The LLM
// only sees load_tool. Pointers go into load_tool's description so the LLM
// knows what tools exist but cannot call them directly.
//
// RESPONSE side: When the LLM calls load_tool in execute mode (has "args"
// field), rewrite the tool_call to the real tool name + args before opencode
// parses it. opencode then dispatches the real tool from prepared.tools.
//
// Verified from opencode source:
//   - session/llm.ts line 128: opencode looks up prepared.tools[toolName]
//   - prepared.tools is opencode's internal map, SEPARATE from body.tools
//   - Removing tools from body.tools does NOT affect prepared.tools
//   - The AI SDK serializes tools into body.tools at fetch time
//
// opencode's provider closure uses `const fetchFn = customFetch ?? fetch`
// where `fetch` resolves to globalThis.fetch at CALL TIME, not definition time.
// So wrapping globalThis.fetch BEFORE the first LLM call works.

let _originalFetch: typeof fetch | null = null
let _fetchWrapped = false

/**
 * Per-turn loaded-tools tracking. Keyed by sessionID. Persists across
 * multiple fetch calls within the SAME turn (one user message = one turn,
 * which may span multiple LLM API calls as the LLM does multi-step tool use).
 * Cleared when the SSE stream ends (finish_reason or [DONE]).
 *
 * This is NOT unbounded memory growth: at most one entry per active session,
 * and each entry is cleared when its stream ends. In `opencode run` there
 * is one session per process, so this map holds at most 1 entry.
 */
const turnLoaded = new Map<string, Set<string>>()

function wrapFetch(): void {
  if (_fetchWrapped) return
  _fetchWrapped = true
  _originalFetch = globalThis.fetch

  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    // Detect LLM API calls. The AI SDK appends "/chat/completions" (OpenAI-compatible)
    // or "/v1/messages" (Anthropic) to the provider baseURL. We check for both the
    // path AND common provider domains to catch all cases including custom proxies.
    const isLLM = url.includes("/chat/completions") || url.includes("/v1/messages") ||
      url.includes("/messages") && url.includes("anthropic") ||
      url.includes("api.deepseek.com") || url.includes("api.openai.com") ||
      url.includes("anthropic.com") || url.includes("openrouter.ai")
    if (!isLLM || !init) return _originalFetch!.call(globalThis, input, init)

    // Extract sessionID from request headers. NO shared "__unknown__" fallback
    // — that causes cross-session state leaks. Per-request unique ID if missing.
    let sessionID = ""
    try {
      const h = init.headers
      const headers = h instanceof Headers
        ? h
        : Array.isArray(h) ? new Headers(h as any) : h ? new Headers(h as any) : new Headers()
      sessionID = headers.get("x-opencode-session") || headers.get("x-session-id") || headers.get("X-Session-Id") || ""
    } catch {}
    if (!sessionID) {
      sessionID = `__req_${Date.now()}_${Math.random().toString(36).slice(2)}__`
    }

    // ── Request-side: remove ALL tools except load_tool ──
    // The LLM only sees load_tool. Pointers go into load_tool's description.
    // This is the REAL blinding — tools not in the array cannot be called.
    if (init.body) {
      let bodyText = ""
      if (typeof init.body === "string") bodyText = init.body
      else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) bodyText = new TextDecoder().decode(init.body)
      else if (init.body instanceof Blob) bodyText = await init.body.text()

      if (bodyText) {
        try {
          const body = JSON.parse(bodyText)

          // Clear turnLoaded if this is a NEW turn (last message is user role).
          // This is the correct turn-end signal — NOT finish_reason=stop,
          // which fires mid-turn. Verified from opencode prompt.ts L1138-1183:
          // the loop continues until the assistant finishes with no tool calls.
          // The next user message = new turn = clear loaded state.
          if (Array.isArray(body.messages) && body.messages.length > 0) {
            const lastMsg = body.messages[body.messages.length - 1]
            if (lastMsg.role === "user") {
              if (turnLoaded.has(sessionID)) {
                turnLoaded.delete(sessionID)
              }
            }
          }
          if (Array.isArray(body.tools)) {
            // Save MCP tools (not in originals) before removing them
            for (const t of body.tools) {
              const fn = t?.function
              const name = fn?.name || t?.name || ""
              if (!name || name === "load_tool") continue
              if (originals.has(name)) {
                // Built-in tool: capture its JSON schema here (jsonSchema is
                // undefined in the tool.definition hook — it's only generated
                // by the AI SDK at serialization time, which is this point).
                // MCP tools are NOT touched here — they fall through below.
                const params = fn?.parameters || t?.parameters
                if (params && !originalSchemas.has(name)) {
                  originalSchemas.set(name, params)
                }
                continue
              }
              const desc = fn?.description || t?.description || ""
              const params = fn?.parameters || t?.parameters || {}
              if (desc && !mcpOriginals.has(name)) {
                mcpOriginals.set(name, desc)
                mcpSchemas.set(name, params)
              }
            }

            // Keep ONLY load_tool in the tools array
            body.tools = body.tools.filter((t: any) => {
              const name = t?.function?.name || t?.name || ""
              return name === "load_tool"
            })

            // STRIP prior load_tool calls AND their results from the messages
            // array — but ONLY those before the LAST user message. This
            // prevents context accumulation across turns while preserving
            // the current turn's load_tool result so the LLM can use it.
            //
            // The API requires every assistant tool_call to be followed by a
            // matching tool-result. So we must remove BOTH sides:
            //   1. The tool-result message (role:"tool", tool_call_id matches)
            //   2. The tool_call entry from the preceding assistant message
            //      (if the assistant message has no other tool_calls and no
            //       text content, remove it entirely)
            if (Array.isArray(body.messages)) {
              // Find index of the last user message — anything before it
              // is prior turns (eligible for stripping); anything from it
              // onward is the current turn (kept intact).
              let lastUserIdx = -1
              for (let i = body.messages.length - 1; i >= 0; i--) {
                if (body.messages[i].role === "user") { lastUserIdx = i; break }
              }
              if (lastUserIdx > 0) {
                const priorMessages = body.messages.slice(0, lastUserIdx)
                // Find tool_call_ids that belong to load_tool in prior turns
                const loadToolCallIds = new Set<string>()
                for (const m of priorMessages) {
                  if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
                    for (const tc of m.tool_calls) {
                      if (tc?.function?.name === "load_tool" && tc?.id) {
                        loadToolCallIds.add(tc.id)
                      }
                    }
                  }
                }
                // Filter prior messages
                const filteredPrior: any[] = []
                for (const m of priorMessages) {
                  if (m.role === "tool" && loadToolCallIds.has(m.tool_call_id)) {
                    continue
                  }
                  if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
                    m.tool_calls = m.tool_calls.filter((tc: any) => tc?.function?.name !== "load_tool")
                    if (m.tool_calls.length === 0) {
                      const hasText = typeof m.content === "string" && m.content.length > 0
                      if (!hasText) continue
                      // Delete the empty tool_calls array — the API rejects
                      // "tool_calls": [] with "Expected minimum length 1"
                      delete m.tool_calls
                    }
                  }
                  filteredPrior.push(m)
                }
                body.messages = [...filteredPrior, ...body.messages.slice(lastUserIdx)]
              }

              // SECOND PASS: scan ALL messages (including current turn) for
              // empty tool_calls arrays. The API rejects "tool_calls": []
              // with "Expected minimum length 1". This can happen when:
              //   - The LLM was interrupted mid-tool-call
              //   - opencode stored a partial assistant message
              //   - The SSE transform rewrote tool_calls leaving empty arrays
              // Fix: delete the tool_calls field entirely if it's empty.
              for (const m of body.messages) {
                if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length === 0) {
                  delete m.tool_calls
                }
              }
            }

            // Append pointer list to load_tool's description
            const pointerList = buildPointerList()
            if (pointerList) {
              for (const t of body.tools) {
                const fn = t?.function
                if (fn && fn.name === "load_tool") {
                  fn.description = [
                    "Gateway tool — the only tool you can call directly.",
                    "All other tools are accessed through this tool.",
                    "",
                    "Available tools:",
                    pointerList,
                    "",
                    "Usage:",
                    '  Load instructions: call with {"name": "toolname"}',
                    "  After loading, call the real tool directly on your next turn.",
                  ].join("\n")
                }
              }
            }

            init = { ...init, body: JSON.stringify(body) }
          }
        } catch {
          // Body wasn't valid JSON — send as-is
        }
      }
    }

    const response = await _originalFetch!.call(globalThis, input, init)

    // Only intercept SSE streaming responses
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

/**
 * TransformStream that parses OpenAI-compatible SSE chunks.
 *
 * Since the LLM can only call load_tool (everything else was removed from
 * body.tools), we buffer load_tool calls until arguments are complete JSON,
 * then decide:
 *   - Load mode {name: "X"} → pass through as load_tool (returns instructions)
 *   - Execute mode {name: "X", args: {...}} → rewrite to X({...}) so opencode
 *     dispatches the real tool from prepared.tools
 *
 * The challenge: tool_call arguments arrive in chunks across multiple SSE
 * events. We must buffer load_tool calls until arguments are complete JSON.
 *
 * Verified against @ai-sdk/openai-compatible:
 *   - Line 758: iterates delta.tool_calls[]
 *   - Line 776: reads toolName from delta.tool_calls[].function.name
 *   - Line 826: subsequent chunks APPEND to toolCalls[index].function.arguments
 *   - Line 833: when accumulated args become parseable JSON, emits tool-call
 */
function createSSETransform(sessionID: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  // Per-index buffer for ALL tool calls: {id, name, arguments}
  const toolBuffers = new Map<number, { id?: string; name?: string; arguments: string }>()
  // Get or create this session's turn-loaded set. Persists across multiple
  // fetch calls within ONE turn (one user message). Cleared when finish_reason
  // "stop" is seen in the SSE stream — that's the LLM's end-of-turn signal.
  // The AI SDK's loop continues (next fetch) only when finish_reason is
  // "tool-calls"; "stop" means the turn is done.
  function getTurnLoaded(): Set<string> {
    if (!turnLoaded.has(sessionID)) turnLoaded.set(sessionID, new Set())
    return turnLoaded.get(sessionID)!
  }

  /** Auto-fill missing required keys in args using schema defaults.
   *  Only fills keys that are metadata-like (string type with no enum/pattern),
   *  never fills keys that hold actual data (paths, commands, content). */
  function autofill(name: string, userArgs: Record<string, unknown>): Record<string, unknown> {
    const schema = originalSchemas.get(name)
    if (!schema) return userArgs // MCP tools: untouched
    const required = Array.isArray(schema.required) ? schema.required : []
    if (required.length === 0) return userArgs
    const props = (schema.properties && typeof schema.properties === "object") ? schema.properties : {}
    const filled = { ...userArgs }
    for (const key of required) {
      if (key in filled) continue
      const prop = (props as any)[key]
      // Only fill string fields that look like metadata (description, label, etc.)
      // Never fill fields that look like they hold actual data
      if (prop?.type === "string" && (key === "description" || key === "label" || key === "title" || key === "name" || key === "summary")) {
        filled[key] = "auto-filled by lazy-load plugin"
      }
      // All other missing required keys: leave missing — let the schema error
      // surface so the LLM learns the correct field on retry
    }
    return filled
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })

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
            const toolCalls = parsed?.choices?.[0]?.delta?.tool_calls

            if (Array.isArray(toolCalls)) {
              const filtered: any[] = []

              for (const tc of toolCalls) {
                if (!tc || !tc.function) {
                  filtered.push(tc)
                  continue
                }
                const idx = tc.index

                // First chunk for this index has the tool name; subsequent
                // chunks only append arguments.
                if (!toolBuffers.has(idx)) {
                  toolBuffers.set(idx, {
                    id: tc.id,
                    name: tc.function.name,
                    arguments: tc.function.arguments || "",
                  })
                } else {
                  const buf = toolBuffers.get(idx)!
                  if (tc.id) buf.id = tc.id
                  if (tc.function.name) buf.name = tc.function.name
                  buf.arguments += tc.function.arguments || ""
                }

                const buf = toolBuffers.get(idx)!
                if (!isParsableJson(buf.arguments)) {
                  // Still buffering — don't emit yet
                  continue
                }

                // Arguments complete — process by name
                const name = buf.name || ""
                const callArgs = JSON.parse(buf.arguments)
                toolBuffers.delete(idx)

                if (name === "load_tool") {
                  // load_tool passes through. Do NOT add to turnLoaded here —
                  // load_tool.execute adds it AFTER returning the full
                  // instructions, so the "already loaded" check in execute
                  // works correctly (first call returns full, subsequent
                  // calls return short).
                  const loadName = callArgs.name
                  filtered.push({
                    index: idx,
                    id: buf.id,
                    type: "function",
                    function: {
                      name: "load_tool",
                      arguments: buf.arguments,
                    },
                  })
                } else {
                  // Direct call to a built-in tool.
                  // If loaded earlier in THIS stream (same turn), allow it.
                  // Otherwise rewrite to load_tool. turnLoaded persists across
                  // fetches within the same turn (multi-step tool use) and is
                  // cleared when finish_reason "stop" is seen.
                  // MCP tools (no entry in originals) pass through untouched.
                  if (originals.has(name)) {
                    if (getTurnLoaded().has(name)) {
                      // Already loaded in this turn — allow direct call
                      filtered.push({
                        index: idx,
                        id: buf.id,
                        type: "function",
                        function: {
                          name,
                          arguments: buf.arguments,
                        },
                      })
                    } else {
                      // Not loaded yet — rewrite to load_tool.
                      // Do NOT add to turnLoaded here — load_tool.execute will
                      // add it on first load. This ensures the first load
                      // returns full instructions, not the "already loaded"
                      // short result.
                      filtered.push({
                        index: idx,
                        id: buf.id,
                        type: "function",
                        function: {
                          name: "load_tool",
                          arguments: JSON.stringify({ name }),
                        },
                      })
                    }
                  } else {
                    // MCP tool — pass through as-is
                    filtered.push({
                      index: idx,
                      id: buf.id,
                      type: "function",
                      function: {
                        name,
                        arguments: buf.arguments,
                      },
                    })
                  }
                }
              }

              if (filtered.length > 0) {
                parsed.choices[0].delta.tool_calls = filtered
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`))
              } else {
                // All tool_calls are buffered — emit chunk without tool_calls
                // (but keep text/finish_reason if present)
                delete parsed.choices[0].delta.tool_calls
                const delta = parsed.choices[0].delta
                if (delta.content || delta.reasoning || parsed.choices[0].finish_reason) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`))
                }
              }
            } else {
              // No tool_calls in this chunk — pass through
              // NOTE: finish_reason is NOT a reliable turn-end signal.
              // opencode's loop (prompt.ts L1156-1183) continues even after
              // finish_reason=stop if the assistant message has tool calls.
              // Turn-end is detected in the fetch wrapper when a new user
              // message appears as the last message in the array.
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`))
            }
          } catch {
            // Not valid JSON — pass through unchanged
            controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          }
        }
      }
    },
    flush(controller) {
      // Emit any remaining buffered tool calls (incomplete arguments).
      // Pass through as-is using whatever name was captured.
      for (const [idx, buf] of toolBuffers) {
        const name = buf.name || "load_tool"
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{
            index: idx,
            id: buf.id,
            type: "function",
            function: { name, arguments: buf.arguments },
          }] } }],
        })}\n\n`))
      }
      if (buffer) {
        controller.enqueue(encoder.encode(buffer))
      }
    },
  })
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

const LazyLoadPlugin: Plugin = async (_input, _options) => {
  // Wrap fetch BEFORE the first LLM call. The wrapper removes all tools
  // except load_tool from the request body, and rewrites load_tool execute
  // calls to real tool calls in the SSE response — no throw, no error, no prompt.
  wrapFetch()

  return {

    // ── New tool: load_tool ──────────────────────────────────────────────────

    tool: {
      load_tool: tool({
        description: [
          "Gateway tool — the only tool you can call directly.",
          "All other tools are accessed through this tool.",
          "",
          "Usage:",
          '  Load instructions: call with {"name": "toolname"}',
          "  After loading, call the real tool directly on your next turn.",
        ].join("\n"),
        args: {
          name: tool.schema
            .string()
            .describe("Tool name to load instructions for"),
          args: tool.schema
            .record(tool.schema.string(), tool.schema.any())
            .optional()
            .describe("Ignored — load_tool always returns instructions. Call the real tool directly after loading."),
        },
        async execute(args, context) {
          const full = originals.get(args.name) || mcpOriginals.get(args.name)
          const schema = originalSchemas.get(args.name) || mcpSchemas.get(args.name)

          if (!full) {
            const allKnown = Array.from(new Set([...originals.keys(), ...mcpOriginals.keys()])).sort()
            return {
              title: `Unknown tool: ${args.name}`,
              output: `No instructions found for "${args.name}". Available tools: ${allKnown.join(", ")}`,
            }
          }

          // If already loaded this turn, return a SHORT result instead of the
          // full instructions. The instructions are already in context from
          // the first load_tool call — duplicating them wastes tokens. The
          // tool_call still gets a result so the API contract is satisfied.
          const loaded = turnLoaded.get(context.sessionID)
          if (loaded && loaded.has(args.name)) {
            return {
              title: `Already loaded: ${args.name}`,
              output: `"${args.name}" was already loaded this turn. Call it directly.`,
            }
          }

          // First load this turn — add to turnLoaded so subsequent calls
          // get the short result, and direct calls to the tool are allowed.
          if (!turnLoaded.has(context.sessionID)) {
            turnLoaded.set(context.sessionID, new Set())
          }
          turnLoaded.get(context.sessionID)!.add(args.name)

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
    // Saves the original full description and JSON schema on first encounter.
    // Stripping is no longer needed here — the fetch wrapper removes all tools
    // except load_tool from the HTTP body. But we still need to save originals
    // so load_tool.execute can return them.

    async "tool.definition"(input, output) {
      // Never modify our own tool
      if (input.toolID === "load_tool") return

      if (!originals.has(input.toolID)) {
        originals.set(input.toolID, output.description)
      }

      const outAny = output as any
      if (outAny.jsonSchema !== undefined && !originalSchemas.has(input.toolID)) {
        originalSchemas.set(input.toolID, outAny.jsonSchema)
      }
    },
  }
}

// ─── Export (v1 plugin format) ───────────────────────────────────────────────

export default {
  id: "opencode-lazy-load",
  server: LazyLoadPlugin,
}
