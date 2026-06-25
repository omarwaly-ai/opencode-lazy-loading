<p align="center">
<img width="auto" height="120" alt="OpenCode Lazy Load plugin" src="https://github.com/user-attachments/assets/94a96fd7-ee09-41c9-842e-c33dd2f1b5d1" />
</p>

<div align="center">

# OpenCode Lazy Loading

**On-demand tool and MCP lazy loading plugin for [opencode](https://opencode.ai)**

Strips tool definitions from every LLM request. Loads tools and MCPs only when needed — saving thousands of tokens per message.

[![opencode](https://img.shields.io/badge/opencode-plugin-blue)](https://opencode.ai)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

---

## Overview

Every message sent to the LLM includes full tool definitions — descriptions, parameter schemas, JSON structures. With 12+ built-in tools and MCP servers, that's thousands of tokens consumed by tool schemas alone, on every single request, even if the LLM only uses one tool.

**opencode lazy load plugin** eliminates this. It strips all tool definitions to a minimal pointer. The LLM calls `load_tool()` to retrieve the full instructions and schema before using a tool. Once loaded, the tool is restored for the remainder of the turn.

**Use cases:**
- 📉 **Reduce token usage** — cut tools and MCPs tokens by 95%+ per request
- 🔌 **Scale MCP servers** — connect many MCP servers without bloating context
- ⚡ **Faster responses** — less context to process means quicker LLM responses
- 🧪 **Verify savings** — pair with [opencode-tokens-source](https://github.com/omarwaly-ai/OpenCode-tokens-source) to see exactly how many tokens each tool consumes before and after

---

## How Much Tokesns It Saves for tools and MCPs
The following example table  for defult Opencode setup which is ~10k Tokens + Chrom devtool MCP
| Setup | Before | After | Saved |
|---|---|---|---|
| 12 built-in tools | ~6,900 tokens | ~323 tokens | **~95%** |
| Chrom Devtool MCP | ~17,900 tokens | ZERO tokens | **~100%** |
| 12 built-in + Chrom Devtool MCP | ~24,800 tokens | ~323 tokens | **~98.7%** |

**Reducing the opencode's total tokens from ~10k to ~3.7K**
Savings scale with the number of tools. The more MCP servers you connect, the more you save.

---
## How It Works

The plugin intercepts tool definitions before they reach the LLM. It replaces full descriptions and schemas with a minimal pointer. When the LLM needs a tool, it calls `load_tool()` to retrieve the complete instructions.

Once a tool is loaded, it stays loaded for the current turn — no reload needed within the same request. On the next user message, the loaded state resets and the LLM loads tools fresh.

The plugin handles all tool types automatically: built-in tools, user-installed tools, and MCP server tools. No configuration needed — detection is automatic.

---

## Installation

### Prerequisites

- [opencode](https://opencode.ai) v1.14 or later

### Mac / Linux

Clone the repo, then copy the plugin file into your project's `.opencode/plugin/` directory.

### Windows

Same — clone the repo, copy the plugin file into your project's `.opencode\plugin\` directory.

### Verify

1. Restart opencode
2. Send any message (e.g., `hi`)
3. The LLM will call `load_tool()` before using any tool

### Uninstall

Delete the file. Everything returns to normal immediately.

---

## Compatibility

- **opencode** 1.17.10+
- **All LLM providers** — DeepSeek, OpenAI, Anthropic, OpenRouter, and any OpenAI-compatible endpoint
- **All MCP servers** — detected automatically
- **Single file, zero dependencies** — no npm packages, no tokenizer, no background process
- **No LLM calls triggered** — the plugin passively intercepts, never initiates requests

---

## Repository Structure

```
opencode-lazy-load/
├── plugins/
│   └── opencode-lazy-load.ts       # The plugin (copy to .opencode/plugin/)
├── README.md
├── LICENSE
└── .gitignore
```
---

## License

[MIT](LICENSE)

