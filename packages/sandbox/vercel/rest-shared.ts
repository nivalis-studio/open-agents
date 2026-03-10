import path from "path";

export interface VercelCommandData {
  id: string;
  name: string;
  args: string[];
  cwd: string;
  sandboxId: string;
  exitCode: number | null;
  startedAt: number;
}

export type VercelCommandLogLine =
  | { stream: "stdout"; data: string }
  | { stream: "stderr"; data: string }
  | { stream: "error"; data: { code: string; message: string } };

export interface VercelAuthContext {
  token: string;
  teamId?: string;
  projectId?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseCommandData(value: unknown): VercelCommandData {
  if (!isRecord(value)) {
    throw new Error("Invalid command payload: expected object");
  }

  const id = value.id;
  const name = value.name;
  const cwd = value.cwd;
  const sandboxId = value.sandboxId;
  const startedAt = value.startedAt;
  const args = value.args;

  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Invalid command payload: missing id");
  }
  if (typeof name !== "string") {
    throw new Error("Invalid command payload: missing name");
  }
  if (typeof cwd !== "string") {
    throw new Error("Invalid command payload: missing cwd");
  }
  if (typeof sandboxId !== "string") {
    throw new Error("Invalid command payload: missing sandboxId");
  }

  const parsedStartedAt = parseInteger(startedAt);
  if (parsedStartedAt === null) {
    throw new Error("Invalid command payload: missing startedAt");
  }

  const parsedExitCode =
    value.exitCode === null ? null : parseInteger(value.exitCode);

  const parsedArgs = Array.isArray(args)
    ? args.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    id,
    name,
    cwd,
    sandboxId,
    startedAt: parsedStartedAt,
    exitCode: parsedExitCode,
    args: parsedArgs,
  };
}

export function parseCommandEnvelope(value: unknown): VercelCommandData {
  if (!isRecord(value) || !isRecord(value.command)) {
    throw new Error("Invalid command response payload");
  }

  return parseCommandData(value.command);
}

export function parseLogLine(value: unknown): VercelCommandLogLine {
  if (!isRecord(value)) {
    throw new Error("Invalid command log line payload");
  }

  const stream = value.stream;
  const data = value.data;

  if (stream === "stdout" || stream === "stderr") {
    if (typeof data !== "string") {
      throw new Error("Invalid command log line: data must be a string");
    }

    return { stream, data };
  }

  if (stream === "error") {
    if (
      !isRecord(data) ||
      typeof data.code !== "string" ||
      typeof data.message !== "string"
    ) {
      throw new Error("Invalid command error log line payload");
    }

    return {
      stream,
      data: {
        code: data.code,
        message: data.message,
      },
    };
  }

  throw new Error("Invalid command log stream type");
}

function extractSandboxIdFromUrl(url: string): string | undefined {
  const match = url.match(/\/v1\/sandboxes\/([^/?]+)/);
  return match?.[1];
}

export function normalizePath(params: {
  filePath: string;
  cwd: string;
  extractDir: string;
}): string {
  if (!path.posix.isAbsolute(params.cwd)) {
    throw new Error("cwd dir must be absolute");
  }

  if (!path.posix.isAbsolute(params.extractDir)) {
    throw new Error("extractDir must be absolute");
  }

  const basePath = path.posix.isAbsolute(params.filePath)
    ? path.posix.normalize(params.filePath)
    : path.posix.join(params.cwd, params.filePath);

  return path.posix.relative(params.extractDir, basePath);
}

function decodeBase64Url(value: string): string {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");

  return Buffer.from(normalized, "base64").toString("utf-8");
}

function parseTokenClaims(token: string): {
  ownerId?: string;
  projectId?: string;
} {
  const tokenParts = token.split(".");
  const payloadPart = tokenParts[1];
  if (!payloadPart) {
    return {};
  }

  try {
    const payload = JSON.parse(decodeBase64Url(payloadPart));
    if (!isRecord(payload)) {
      return {};
    }

    return {
      ownerId:
        typeof payload.owner_id === "string" ? payload.owner_id : undefined,
      projectId:
        typeof payload.project_id === "string" ? payload.project_id : undefined,
    };
  } catch {
    return {};
  }
}

export function getVercelAuthContextFromOidcToken(): VercelAuthContext {
  const token = process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    throw new Error(
      "Missing VERCEL_OIDC_TOKEN. This stateless Vercel sandbox path requires an OIDC bearer token.",
    );
  }

  const claims = parseTokenClaims(token);

  return {
    token,
    teamId: claims.ownerId,
    projectId: claims.projectId,
  };
}

export class VercelApiError extends Error {
  readonly status: number;
  readonly text?: string;
  readonly json?: unknown;
  readonly sandboxId?: string;

  constructor(params: {
    message: string;
    status: number;
    text?: string;
    json?: unknown;
    sandboxId?: string;
  }) {
    super(params.message);
    this.name = "VercelApiError";
    this.status = params.status;
    this.text = params.text;
    this.json = params.json;
    this.sandboxId = params.sandboxId;
  }

  static async fromResponse(response: Response): Promise<VercelApiError> {
    const text = await response.text().catch(() => "");
    const sandboxId = extractSandboxIdFromUrl(response.url);

    let json: unknown;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    return new VercelApiError({
      message: `Vercel API request failed with status ${response.status}`,
      status: response.status,
      text,
      json,
      sandboxId,
    });
  }
}

export function isSandboxUnavailableError(error: unknown): boolean {
  return (
    error instanceof VercelApiError && [404, 410, 422].includes(error.status)
  );
}
