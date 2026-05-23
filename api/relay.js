const DEFAULT_RELAY_TARGET = "https://relay.deepseektuidesktop.cn";
const DEFAULT_RELAY_ORIGIN = "https://deepseektuidesktop.cn";
const MAX_BODY_BYTES = 1024 * 1024;

export default async function handler(request, response) {
  setCorsHeaders(request, response);
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (!["GET", "POST"].includes(request.method || "")) {
    response.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const relayPath = String(request.query?.path || "");
  if (!relayPath.startsWith("/api/v1/")) {
    response.status(404).json({ ok: false, error: "Not found" });
    return;
  }

  const target = new URL(relayPath, process.env.RELAY_TARGET_ORIGIN || DEFAULT_RELAY_TARGET);
  const body = request.method === "POST" ? await readBody(request) : undefined;
  if (body && body.length > MAX_BODY_BYTES) {
    response.status(413).json({ ok: false, error: "Request body too large" });
    return;
  }

  try {
    const relayResponse = await fetch(target, {
      method: request.method,
      headers: relayHeaders(request, body),
      body
    });
    const text = await relayResponse.text();
    response.status(relayResponse.status);
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", relayResponse.headers.get("content-type") || "application/json; charset=utf-8");
    response.send(text);
  } catch {
    response.status(502).json({ ok: false, error: "Relay proxy failed" });
  }
}

function relayHeaders(request, body) {
  const headers = {
    accept: "application/json",
    origin: process.env.RELAY_ALLOWED_ORIGIN || DEFAULT_RELAY_ORIGIN
  };
  if (request.headers.authorization) headers.authorization = request.headers.authorization;
  if (body) headers["content-type"] = request.headers["content-type"] || "application/json";
  return headers;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function setCorsHeaders(request, response) {
  const origin = request.headers.origin;
  if (origin) response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-max-age", "600");
}
