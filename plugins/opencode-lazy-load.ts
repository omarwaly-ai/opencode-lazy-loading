{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-diff-preview"],
  "permission": {
    "edit": "ask",
    "write": "ask",
    "bash": "ask",
    "skill": "ask"
  },
  "mcp": {
    "chrome-devtools": {
      "type": "local",
      "command": [
        "npx", "chrome-devtools-mcp@latest",
        "--log-file", "./logs/chrome-devtools.log",
        "--experimental-vision",
        "--memory-debugging",
        "--experimental-structured-content",
        "--no-usage-statistics",
        "--isolated"
      ],
      "enabled": true,
      "timeout": 30000
    }
  },
  "command": {
    "tokens": {
      "description": "Show token usage breakdown",
      "template": "Show token usage breakdown for this session."
    }
  },
  "agent": {
    "assistant": {
      "description": "General-purpose assistant powered by Gemini",
      "mode": "primary",
      "permission": {
        "edit": "ask",
        "write": "ask",
        "read": "allow",
        "glob": "ask",
        "grep": "ask",
        "bash": "ask",
        "task": "allow",
        "skill": "ask",
        "question": "allow",
        "todowrite": "allow"
      }
    },
    "search": {
      "description": "Searches the web and fetches content",
      "mode": "subagent",
      "model": "nvidia/nemotron-3-nano-30b-a3b",
      "permission": {
        "webfetch": "allow",
        "websearch": "allow",
        "read": "allow"
      }
    },
    "plan": {
      "mode": "primary",
      "model": "opencode/deepseek-v4-flash-free",
      "prompt": "{file:./prompts/plan.txt}",
      "permission": {
        "edit": "deny",
        "bash": "deny"
      }
    },
    "orchestrator": {
      "description": "Coordinates work across all specialized subagents",
      "mode": "primary"
    },
    "coder": {
      "description": "Implements production-quality code following project conventions",
      "mode": "subagent"
    },
    "database": {
      "description": "Manages DB schemas, migrations, RLS policies, and query optimization",
      "mode": "subagent"
    },
    "code-reviewer": {
      "description": "Reviews code quality, best practices, and identifies bugs",
      "mode": "subagent"
    },
    "security-auditor": {
      "description": "Audits code for vulnerabilities, secrets, and OWASP risks",
      "mode": "subagent"
    },
    "test-engineer": {
      "description": "Analyzes test strategy, coverage gaps, and test quality",
      "mode": "subagent"
    },
    "ship": {
      "description": "Reviews changes, commits, pushes, and manages deployment",
      "mode": "primary"
    }
  }
}
