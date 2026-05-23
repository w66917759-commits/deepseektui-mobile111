import https from "node:https";

const DEFAULT_RELAY_HOST = "121.40.54.226";
const DEFAULT_RELAY_SERVER_NAME = "relay.deepseektuidesktop.cn";
const DEFAULT_RELAY_PORT = 443;
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

  const body = request.method === "POST" ? await readBody(request) : undefined;
  if (body && body.length > MAX_BODY_BYTES) {
    response.status(413).json({ ok: false, error: "Request body too large" });
    return;
  }

  try {
    const relayResponse = await forwardToRelay(request, relayPath, body);
    response.status(relayResponse.statusCode || 502);
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", relayResponse.headers["content-type"] || "application/json; charset=utf-8");
    response.send(relayResponse.body);
  } catch (error) {
    response.status(502).json({
      ok: false,
      error: "Relay proxy failed",
      detail: error instanceof Error ? error.message : "unknown"
    });
  }
}

function forwardToRelay(request, relayPath, body) {
  return new Promise((resolve, reject) => {
    const servername = process.env.RELAY_TARGET_SERVER_NAME || DEFAULT_RELAY_SERVER_NAME;
    const headers = {
      ...relayHeaders(request, body),
      host: servername
    };
    if (body) headers["content-length"] = String(body.length);

    const relayRequest = https.request({
      hostname: process.env.RELAY_TARGET_HOST || DEFAULT_RELAY_HOST,
      port: Number(process.env.RELAY_TARGET_PORT || DEFAULT_RELAY_PORT),
      servername,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      path: relayPath,
      method: request.method,
      headers,
      timeout: 20_000
    }, (relayResponse) => {
      const chunks = [];
      relayResponse.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      relayResponse.on("end", () => {
        resolve({
          body: Buffer.concat(chunks),
          headers: relayResponse.headers,
          statusCode: relayResponse.statusCode
        });
      });
    });

    relayRequest.on("timeout", () => relayRequest.destroy(new Error("Relay proxy timed out")));
    relayRequest.on("error", reject);
    if (body) relayRequest.write(body);
    relayRequest.end();
  });
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
