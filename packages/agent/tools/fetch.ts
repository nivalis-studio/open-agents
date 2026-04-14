import dns from "node:dns/promises";
import net from "node:net";
import { tool } from "ai";
import { z } from "zod";

const MAX_BODY_LENGTH = 20_000;
const BLOCKED_HOSTNAMES = new Set(["localhost"]);

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part))) {
    return true;
  }

  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

function isBlockedIpAddress(address: string): boolean {
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) {
    return isPrivateIpv4(address);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(address);
  }
  return true;
}

async function validateFetchUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Target hostname is not allowed");
  }

  if (net.isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      throw new Error("Target IP address is not allowed");
    }
    return url;
  }

  const resolvedAddresses = await dns.lookup(hostname, {
    all: true,
    verbatim: true,
  });
  if (resolvedAddresses.length === 0) {
    throw new Error("Could not resolve target hostname");
  }

  if (resolvedAddresses.some((entry) => isBlockedIpAddress(entry.address))) {
    throw new Error("Target hostname resolves to a blocked IP address");
  }

  return url;
}

const fetchInputSchema = z.object({
  url: z.string().url().describe("The URL to fetch"),
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
    .optional()
    .describe("HTTP method. Default: GET"),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Optional HTTP headers as key-value pairs"),
  body: z
    .string()
    .optional()
    .describe("Optional request body (for POST/PUT/PATCH)"),
});

export const webFetchTool = tool({
  description: `Fetch a URL from the web.

USAGE:
- Make HTTP requests to external URLs
- Supports GET, POST, PUT, PATCH, DELETE, and HEAD methods
- Returns the response status, headers, and body text
- Body is truncated to 20000 characters to avoid overwhelming context

EXAMPLES:
- Simple GET: url: "https://api.example.com/data"
- POST with JSON: url: "https://api.example.com/items", method: "POST", headers: {"Content-Type": "application/json"}, body: "{\\"name\\":\\"item\\"}"`,
  inputSchema: fetchInputSchema,
  execute: async ({ url, method = "GET", headers, body }) => {
    try {
      const validatedUrl = await validateFetchUrl(url);
      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(30000),
      };
      if (method !== "GET" && method !== "HEAD" && body) {
        init.body = body;
      }
      const response = await fetch(validatedUrl, init);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let responseBody: string;
      try {
        responseBody = await response.text();
      } catch {
        responseBody = "[Could not read response body]";
      }

      const truncated = responseBody.length > MAX_BODY_LENGTH;
      if (truncated) {
        responseBody = responseBody.slice(0, MAX_BODY_LENGTH);
      }

      return {
        success: true,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
        truncated,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Fetch failed: ${message}`,
      };
    }
  },
});
