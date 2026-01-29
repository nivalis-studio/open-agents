# AGENTS.md

This file provides guidance for AI coding agents working in this repository.

**This is a living document.** When you make a mistake or learn something new about this codebase, update this file to prevent the same mistake from happening again. Add lessons learned to the relevant section, or create a new "Lessons Learned" section at the bottom if needed.

## Commands

```bash
# Development
turbo dev              # Run CLI agent (from root)
bun run cli            # Alternative: run CLI directly
bun run web            # Run web app

# Quality checks (run after making changes)
turbo typecheck                            # Type check all packages
turbo lint                                 # Lint all packages with oxlint
turbo lint:fix                             # Lint and auto-fix all packages

# Filter by package (use --filter)
turbo typecheck --filter=web               # Type check web app only
turbo typecheck --filter=@open-harness/cli # Type check CLI only
turbo lint:fix --filter=web                # Lint web app only
turbo lint:fix --filter=@open-harness/cli  # Lint CLI only

# Formatting (Biome - run from root)
bun run format                             # Format all files
bun run format:check                       # Check formatting without writing

# Testing
bun test                        # Run all tests
bun test path/to/file.test.ts   # Run single test file
bun test --watch                # Watch mode
```

## Agent Laboratory Workflow

Agents must be able to verify their own work. Use this loop for any non-trivial change.

1. **Instrumentation**
   - Identify the critical path you are touching. Default critical paths are the CLI agent flow and the web UI tasks flow.
   - Create or reuse a measurable check. Use tests, logs, or UI evidence.

2. **Diagnosis**
   - Capture a baseline by running the smallest relevant check.
   - Write down 1 to 3 hypotheses about what will change and why.

3. **Iteration**
   - Make one change at a time.
   - Re-run the same check and compare to baseline.
   - Keep only changes that improve the outcome and do not break tests.

4. **Report**
   - Summarize before and after results with exact commands and key outputs.
   - If you cannot verify, say why and what would verify it.

### Verification Matrix

Use the smallest set that proves the change:

- CLI agent flow: `turbo typecheck --filter=@open-harness/cli` and `bun test path/to/file.test.ts`
- TUI: `turbo typecheck --filter=@open-harness/tui` and relevant unit tests
- Agent tools: `turbo typecheck --filter=@open-harness/agent` and targeted tests
- Web UI tasks: `turbo typecheck --filter=web` and browser verification

Do not run dev servers or builds unless explicitly asked by the user.

## Agent Browser

When the task requires UI verification, use the agent-browser skill.

- Prefer agent-browser over manual steps. Do not ask the user to click or inspect.
- Capture screenshots and DOM evidence for before and after comparisons.
- Record exact steps and selectors used so the workflow is repeatable.
- If a page requires credentials or secrets, stop and ask for them.

## Git Commands

**Quote paths with special characters**: File paths containing brackets (like Next.js dynamic routes `[id]`, `[slug]`) are interpreted as glob patterns by zsh. Always quote these paths in git commands:

```bash
# Wrong - zsh interprets [id] as a glob pattern
git add apps/web/app/tasks/[id]/page.tsx
# Error: no matches found: apps/web/app/tasks/[id]/page.tsx

# Correct - quote the path
git add "apps/web/app/tasks/[id]/page.tsx"
```

## Architecture

This is a Turborepo monorepo for "Open Harness" - an AI coding agent built with AI SDK.

### Core Flow

```
CLI (apps/cli) -> TUI (packages/tui) -> Agent (packages/agent) -> Sandbox (packages/sandbox)
```

1. **CLI** parses args, creates sandbox, loads AGENTS.md files, and starts the TUI
2. **TUI** renders the terminal UI with Ink/React, manages chat state via `ChatTransport`
3. **Agent** (`deepAgent`) is a `ToolLoopAgent` with tools for file ops, bash, and task delegation
4. **Sandbox** abstracts file system and shell operations (local fs or remote like Vercel)

### Key Packages

- **packages/agent/** - Core agent implementation with tools, subagents, and context management
- **packages/sandbox/** - Execution environment abstraction (local/remote)
- **packages/tui/** - Terminal UI with Ink/React components
- **packages/shared/** - Shared utilities across packages

### Subagent Pattern

The `task` tool delegates to specialized subagents:
- **explorer**: Read-only, for codebase research (grep, glob, read, safe bash)
- **executor**: Full access, for implementation tasks (all tools)

## Code Style

### Package Manager
- Use **Bun exclusively** (not Node/npm/pnpm)
- The monorepo uses `bun@1.2.14` as the package manager

### TypeScript Configuration
- Strict mode enabled
- Target: ESNext with module "Preserve"
- `noUncheckedIndexedAccess: true` - always check indexed access
- `verbatimModuleSyntax: true` - use explicit type imports

### Formatting (Biome)
- Indent: 2 spaces
- Quote style: double quotes for JavaScript/TypeScript
- Organize imports: enabled via Biome assist
- Run `bun run format` before committing

### Naming Conventions
- **Files**: kebab-case (e.g., `deep-agent.ts`, `paste-blocks.ts`)
- **Types/Interfaces**: PascalCase (e.g., `TodoItem`, `AgentContext`)
- **Functions/Variables**: camelCase (e.g., `getSandbox`, `workingDirectory`)
- **Constants**: UPPER_SNAKE_CASE for true constants (e.g., `TIMEOUT_MS`, `SAFE_COMMAND_PREFIXES`)

### Imports
- **Do NOT use `.js` extensions** in imports (e.g., `import { foo } from "./utils"` not `"./utils.js"`)
  - The `.js` extension causes module resolution issues with Next.js/Turbopack
  - This applies to all packages and apps in the monorepo
- Prefer named exports over default exports
- Group imports: external packages first, then internal packages, then relative imports
- Use type imports when importing only types: `import type { Foo } from "./types"`

### Types
- **Never use `any`** - use `unknown` and narrow with type guards
- Define schemas with Zod, then derive types: `type Foo = z.infer<typeof fooSchema>`
- Prefer interfaces for object shapes, types for unions/intersections
- Export types alongside their related functions

### Error Handling
- Return structured error objects rather than throwing when possible:
  ```typescript
  return { success: false, error: `Failed to read file: ${message}` };
  ```
- When catching errors, extract message safely:
  ```typescript
  const message = error instanceof Error ? error.message : String(error);
  ```
- Use descriptive error messages that include context (tool name, file path, etc.)

### Testing
- Use Bun's test runner: `import { test, expect } from "bun:test"`
- Test files use `.test.ts` suffix
- Colocate tests with source files

### Bun APIs
- Prefer Bun APIs over Node when available:
  - `Bun.file()` for file operations
  - `Bun.serve()` for HTTP servers
  - `Bun.$` for shell commands in scripts

### AI SDK Patterns
- Tools are defined with Zod schemas for input validation
- Use `ToolLoopAgent` for agent implementations
- Tools receive context via `experimental_context` parameter
- Implement `needsApproval` as boolean or function for tool approval logic

## Tool Implementation Patterns

When creating tools in `packages/agent/tools/`:

```typescript
import { tool } from "ai";
import { z } from "zod";
import { getSandbox, getApprovalContext } from "./utils";

const inputSchema = z.object({
  param: z.string().describe("Description for the agent"),
});

export const myTool = (options?: { needsApproval?: boolean }) =>
  tool({
    needsApproval: (args, { experimental_context }) => {
      const ctx = getApprovalContext(experimental_context, "myTool");
      // Return true if approval needed, false otherwise
      return options?.needsApproval ?? true;
    },
    description: `Tool description with USAGE, WHEN TO USE, EXAMPLES sections`,
    inputSchema,
    execute: async (args, { experimental_context }) => {
      const sandbox = getSandbox(experimental_context, "myTool");
      // Implementation using sandbox methods
      return { success: true, result: "..." };
    },
  });
```

## Workspace Structure

```
apps/
  cli/           # CLI entry point (@open-harness/cli)
  web/           # Web interface
packages/
  agent/         # Core agent logic (@open-harness/agent)
  sandbox/       # Sandbox abstraction (@open-harness/sandbox)
  tui/           # Terminal UI (@open-harness/tui)
  shared/        # Shared utilities (@open-harness/shared)
  tsconfig/      # Shared TypeScript configs
```

## Common Patterns

### Workspace Dependencies
Use `workspace:*` for internal packages:
```json
{
  "dependencies": {
    "@open-harness/sandbox": "workspace:*"
  }
}
```

### Catalog Dependencies
Use `catalog:` for shared external versions:
```json
{
  "dependencies": {
    "ai": "catalog:",
    "zod": "catalog:"
  }
}
```

## Lessons Learned

- Skill discovery de-duplicates by first-seen name, so project skill directories must be scanned before user-level directories to allow project overrides.
- The system prompt should list all model-invocable skills (including non-user-invocable ones), and reserve user-invocable filtering for the slash-command UI.
