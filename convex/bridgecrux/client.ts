import { getEnv } from "../app/env";

type BridgeCruxSuccess<T> = {
  ok: true;
  requestId: string;
  data: T;
};

type BridgeCruxFailure = {
  ok: false;
  error: {
    status: number;
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
};

type BridgeCruxEnvelope<T> = BridgeCruxSuccess<T> | BridgeCruxFailure;

async function parseEnvelope<T>(response: Response): Promise<BridgeCruxSuccess<T>> {
  const bodyText = await response.text();
  let envelope: BridgeCruxEnvelope<T>;

  try {
    envelope = JSON.parse(bodyText) as BridgeCruxEnvelope<T>;
  } catch {
    throw new Error(`BridgeCrux returned non-JSON with ${response.status}: ${bodyText}`);
  }

  if (!response.ok || envelope.ok !== true) {
    const error = envelope.ok === false
      ? envelope.error
      : {
          status: response.status,
          code: "BRIDGECRUX_HTTP_ERROR",
          message: bodyText || response.statusText,
          requestId: response.headers.get("x-request-id") ?? "unknown",
          details: undefined,
        };

    throw new Error(
      `BridgeCrux ${error.code} (${error.status}) [${error.requestId}]: ${error.message}${
        error.details ? ` | ${JSON.stringify(error.details)}` : ""
      }`
    );
  }

  return envelope;
}

async function callBridgeCrux<T>(input: {
  baseUrl: string;
  path: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  requiresAuth?: boolean;
}) {
  const env = getEnv();
  const requestId = crypto.randomUUID();
  const headers: Record<string, string> = {
    "x-request-id": requestId,
  };

  if (input.body) {
    headers["content-type"] = "application/json";
  }

  if (input.requiresAuth !== false) {
    headers["x-bridgecrux-key"] = env.BRIDGECRUX_API_KEY;
  }

  const response = await fetch(`${input.baseUrl}${input.path}`, {
    method: input.method ?? (input.body ? "POST" : "GET"),
    headers,
    body: input.body ? JSON.stringify(input.body) : undefined,
  });

  return parseEnvelope<T>(response);
}

export async function healthWeb() {
  const env = getEnv();
  return callBridgeCrux<{
    service: string;
    version: string;
    status: string;
    time: string;
    capabilities: Record<string, unknown>;
  }>({
    baseUrl: env.BRIDGECRUX_WEB_BASE_URL,
    path: "/health",
    requiresAuth: false,
  });
}

export async function searchWeb(
  query: string,
  options?: {
    limit?: number;
    freshness?: "day" | "week" | "month" | "year" | "all";
  }
) {
  const env = getEnv();
  return callBridgeCrux<{
    provider: string;
    query: string;
    results: Array<{ title: string; url: string; snippet: string }>;
    searchedAt: string;
  }>({
    baseUrl: env.BRIDGECRUX_WEB_BASE_URL,
    path: "/v1/search",
    body: {
      query,
      limit: options?.limit ?? 5,
      freshness: options?.freshness ?? "all",
    },
  });
}

export async function fetchPage(
  url: string,
  options?: {
    format?: "text" | "html";
    timeoutMs?: number;
    maxBytes?: number;
  }
) {
  const env = getEnv();
  return callBridgeCrux<{
    url: string;
    finalUrl: string;
    status: number;
    contentType: string;
    title: string;
    content: string;
    excerpt: string;
    fetchedAt: string;
    mode: string;
  }>({
    baseUrl: env.BRIDGECRUX_WEB_BASE_URL,
    path: "/v1/fetch",
    body: {
      url,
      format: options?.format ?? "text",
      timeoutMs: options?.timeoutMs ?? 10000,
      maxBytes: options?.maxBytes ?? 200000,
    },
  });
}

export async function snapshotUrl(
  url: string,
  options?: {
    timeoutMs?: number;
    waitUntil?: "load" | "domcontentloaded" | "networkidle";
    includeHtml?: boolean;
    maxBytes?: number;
  }
) {
  const env = getEnv();
  return callBridgeCrux<{
    url: string;
    finalUrl: string;
    title: string;
    text: string;
    capturedAt: string;
    driver: string;
    html?: string;
  }>({
    baseUrl: env.BRIDGECRUX_BROWSER_BASE_URL,
    path: "/v1/browser/snapshot-url",
    body: {
      url,
      timeoutMs: options?.timeoutMs ?? 15000,
      waitUntil: options?.waitUntil ?? "load",
      includeHtml: options?.includeHtml ?? false,
      maxBytes: options?.maxBytes ?? 250000,
    },
  });
}
