import type { Dirent } from "fs";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
  SnapshotResult,
} from "../interface";
import {
  getVercelAuthContextFromOidcToken,
  isSandboxUnavailableError,
  VercelApiError,
  VercelRestClient,
} from "./rest-client";
import type { VercelState } from "./state";

const MAX_OUTPUT_LENGTH = 50_000;
const DEFAULT_WORKING_DIRECTORY = "/vercel/sandbox";
const DETACHED_QUICK_FAILURE_WINDOW_MS = 2_000;

function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function escapeDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
}

function formatApiError(error: VercelApiError): string {
  if (error.text && error.text.length > 0) {
    return error.text;
  }

  if (error.json !== undefined) {
    return JSON.stringify(error.json);
  }

  return error.message;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof VercelApiError) {
    return formatApiError(error);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export interface StatelessVercelSandboxConfig {
  sandboxId: string;
  env?: Record<string, string>;
  hooks?: SandboxHooks;
  expiresAt?: number;
  timeout?: number;
}

/**
 * Stateless Vercel sandbox adapter that talks to the REST API directly using
 * sandboxId, without calling Sandbox.get() up front.
 */
export class StatelessVercelSandbox implements Sandbox {
  readonly type = "cloud";
  readonly id: string;
  readonly workingDirectory = DEFAULT_WORKING_DIRECTORY;
  readonly env?: Record<string, string>;
  readonly hooks?: SandboxHooks;
  readonly currentBranch?: string;

  readonly environmentDetails =
    `- Ephemeral sandbox - all work is lost unless committed and pushed to git
- Default workflow: create a new branch, commit changes, push, and open a PR (since the sandbox is ephemeral, this ensures work is preserved)
- All bash commands already run in the working directory by default - never prepend \`cd <working-directory> &&\`; just run the command directly
- Do NOT prefix any bash command with a \`cd\` to the working directory - commands like \`cd <working-directory> && npm test\` are WRONG; just use \`npm test\`
- Use workspace-relative paths for read/write/search/edit operations
- Git is already configured (user, email, remote auth) - no setup or verification needed
- GitHub CLI (gh) is NOT available - use curl with the GitHub API to create PRs
  Use the $GITHUB_TOKEN environment variable directly (do not paste the actual token):
  curl -X POST -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json" https://api.github.com/repos/OWNER/REPO/pulls -d '{"title":"...","head":"branch","base":"main","body":"..."}'
- Node.js runtime with npm/pnpm available
- Bun and jq are preinstalled
- Dependencies may not be installed. Before running project scripts (build, typecheck, lint, test), check if \`node_modules\` exists and run the package manager install command if needed (e.g. \`bun install\`, \`npm install\`)
- This snapshot includes agent-browser; when validating UI or end-to-end behavior, start the dev server and use agent-browser against the local dev server URL
- This sandbox already runs on Vercel; do not suggest deploying to Vercel just to obtain a shareable preview link`;

  private client: VercelRestClient;
  private isStopped = false;
  private _expiresAt?: number;
  private _timeout?: number;

  constructor(config: StatelessVercelSandboxConfig) {
    this.id = config.sandboxId;
    this.env = config.env;
    this.hooks = config.hooks;
    this._expiresAt = config.expiresAt;
    this._timeout = config.timeout;

    const auth = getVercelAuthContextFromOidcToken();
    this.client = new VercelRestClient({
      token: auth.token,
      teamId: auth.teamId,
    });
  }

  static canUseStatelessMode(): boolean {
    return !!process.env.VERCEL_OIDC_TOKEN;
  }

  get expiresAt(): number | undefined {
    return this._expiresAt;
  }

  get timeout(): number | undefined {
    return this._timeout;
  }

  async readFile(path: string, _encoding: "utf-8"): Promise<string> {
    const buffer = await this.client.readFileToBuffer({
      sandboxId: this.id,
      path,
    });

    if (buffer === null) {
      throw new Error(`Failed to read file: ${path}`);
    }

    return buffer.toString("utf-8");
  }

  async writeFile(
    path: string,
    content: string,
    _encoding: "utf-8",
  ): Promise<void> {
    const parentDirIndex = path.lastIndexOf("/");
    if (parentDirIndex > 0) {
      const parentDir = path.slice(0, parentDirIndex);
      await this.mkdir(parentDir, { recursive: true });
    }

    await this.client.writeFiles({
      sandboxId: this.id,
      cwd: this.workingDirectory,
      files: [
        {
          path,
          content: Buffer.from(content, "utf-8"),
        },
      ],
      extractDir: "/",
    });
  }

  async stat(path: string): Promise<SandboxStats> {
    const result = await this.exec(
      `stat -c "%F\t%s\t%Y" ${shellEscape(path)}`,
      this.workingDirectory,
      10_000,
    );

    if (!result.success) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    const output = result.stdout.trim();
    const [fileType, sizeStr, mtimeStr] = output.split("\t");

    const isDir = fileType === "directory";
    const size = Number.parseInt(sizeStr ?? "0", 10);
    const mtimeMs = Number.parseInt(mtimeStr ?? "0", 10) * 1000;

    return {
      isDirectory: () => isDir,
      isFile: () => !isDir,
      size,
      mtimeMs,
    };
  }

  async access(path: string): Promise<void> {
    const result = await this.exec(
      `test -e ${shellEscape(path)}`,
      this.workingDirectory,
      10_000,
    );

    if (!result.success) {
      throw new Error(`ENOENT: no such file or directory, access '${path}'`);
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.client.createDirectory({
      sandboxId: this.id,
      path,
      cwd: this.workingDirectory,
      recursive: options?.recursive,
    });
  }

  async readdir(
    path: string,
    _options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    const result = await this.exec(
      `find ${shellEscape(path)} -maxdepth 1 -mindepth 1 -printf "%y %f\\n"`,
      this.workingDirectory,
      10_000,
    );

    if (!result.success) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    const output = result.stdout.trim();
    if (!output) {
      return [];
    }

    return output.split("\n").map((line) => {
      const [type, ...nameParts] = line.split(" ");
      const name = nameParts.join(" ");
      const isDir = type === "d";
      const isFile = type === "f";
      const isSymlink = type === "l";

      const entry: Dirent = {
        name,
        parentPath: path,
        path,
        isDirectory: () => isDir,
        isFile: () => isFile,
        isSymbolicLink: () => isSymlink,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      };

      return entry;
    });
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<ExecResult> {
    let commandId: string | undefined;

    try {
      const escapedCwd = escapeDoubleQuoted(cwd);
      const started = await this.client.startCommand({
        sandboxId: this.id,
        command: "bash",
        args: ["-c", `cd "${escapedCwd}" && ${command}`],
        env: this.env,
      });
      commandId = started.id;

      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        abortController.abort();
      }, timeoutMs);

      try {
        const [finished, logs] = await Promise.all([
          this.client.waitForCommand({
            sandboxId: this.id,
            commandId: started.id,
            signal: abortController.signal,
          }),
          this.client.collectCommandLogs({
            sandboxId: this.id,
            commandId: started.id,
            signal: abortController.signal,
          }),
        ]);

        let stdout = logs.both;
        let truncated = false;
        if (stdout.length > MAX_OUTPUT_LENGTH) {
          stdout = stdout.slice(0, MAX_OUTPUT_LENGTH);
          truncated = true;
        }

        return {
          success: finished.exitCode === 0,
          exitCode: finished.exitCode,
          stdout,
          stderr: "",
          truncated,
        };
      } finally {
        clearTimeout(timeoutHandle);
      }
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        return {
          success: false,
          exitCode: null,
          stdout: "",
          stderr: formatUnknownError(error),
          truncated: false,
        };
      }

      if (error instanceof Error && error.name === "AbortError") {
        if (commandId) {
          void this.client
            .killCommand({ sandboxId: this.id, commandId })
            .catch(() => undefined);
        }

        return {
          success: false,
          exitCode: null,
          stdout: "",
          stderr: `Command timed out after ${timeoutMs}ms`,
          truncated: false,
        };
      }

      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: formatUnknownError(error),
        truncated: false,
      };
    }
  }

  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    const escapedCwd = escapeDoubleQuoted(cwd);
    const started = await this.client.startCommand({
      sandboxId: this.id,
      command: "bash",
      args: ["-c", `cd "${escapedCwd}" && ${command}`],
      env: this.env,
    });

    const quickAbort = new AbortController();
    const timeoutId = setTimeout(() => {
      quickAbort.abort();
    }, DETACHED_QUICK_FAILURE_WINDOW_MS);

    try {
      const finished = await this.client.waitForCommand({
        sandboxId: this.id,
        commandId: started.id,
        signal: quickAbort.signal,
      });

      if (finished.exitCode !== 0) {
        const logs = await this.client.collectCommandLogs({
          sandboxId: this.id,
          commandId: started.id,
        });
        const combined = logs.stderr.length > 0 ? logs.stderr : logs.both;
        const snippet = combined.trim().slice(0, MAX_OUTPUT_LENGTH);
        throw new Error(
          `Background command exited with code ${finished.exitCode}. stderr:\n${snippet || "<no stderr>"}`,
        );
      }

      return { commandId: started.id };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { commandId: started.id };
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async stop(): Promise<void> {
    if (this.isStopped) {
      return;
    }

    this.isStopped = true;

    if (this.hooks?.beforeStop) {
      try {
        await this.hooks.beforeStop(this);
      } catch (error) {
        console.error(
          "[StatelessVercelSandbox] beforeStop hook failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    await this.client.stopSandbox({ sandboxId: this.id });
  }

  async extendTimeout(additionalMs: number): Promise<{ expiresAt: number }> {
    const result = await this.client.extendTimeout({
      sandboxId: this.id,
      duration: additionalMs,
    });

    const expiresAt = result.expiresAt ?? Date.now() + additionalMs;
    this._expiresAt = expiresAt;

    if (this.hooks?.onTimeoutExtended) {
      try {
        await this.hooks.onTimeoutExtended(this, additionalMs);
      } catch (error) {
        console.error(
          "[StatelessVercelSandbox] onTimeoutExtended hook failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    return { expiresAt };
  }

  async snapshot(): Promise<SnapshotResult> {
    const result = await this.client.createSnapshot({ sandboxId: this.id });
    this.isStopped = true;

    return {
      snapshotId: result.snapshotId,
    };
  }

  getState(): { type: "vercel" } & VercelState {
    return {
      type: "vercel",
      sandboxId: this.id,
      expiresAt: this._expiresAt,
    };
  }
}
