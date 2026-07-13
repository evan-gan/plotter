// Small HTTP helpers for the framework-free node:http server.

import { IncomingMessage, ServerResponse } from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const MAX_BODY_BYTES = 8 * 1024 * 1024; // SVG uploads can be chunky

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(payload);
}

export function sendError(response: ServerResponse, statusCode: number, message: string): void {
  sendJson(response, statusCode, { error: message });
}

/** Read and JSON-parse a request body, with a hard size cap. */
export function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES / 1024 / 1024} MB.`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

/** Constant-time password check (padded so length never leaks). */
export function checkAdminPassword(request: IncomingMessage, expected: string): boolean {
  if (!expected) return false; // no password configured → admin API disabled
  const provided = String(request.headers["x-admin-password"] ?? "");
  const providedBuffer = Buffer.alloc(64);
  const expectedBuffer = Buffer.alloc(64);
  providedBuffer.write(provided.slice(0, 64));
  expectedBuffer.write(expected.slice(0, 64));
  return provided.length === expected.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".gcode": "text/plain; charset=utf-8",
};

/**
 * Serve a file from `rootDir`, refusing path escapes. SPA fallback: unknown
 * extension-less paths get index.html so client-side routes deep-link.
 */
export function serveStatic(response: ServerResponse, rootDir: string, urlPath: string): void {
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(rootDir, safePath === "/" || safePath === "\\" ? "index.html" : safePath);
  if (!filePath.startsWith(rootDir)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (path.extname(filePath) === "") filePath = path.join(rootDir, "index.html");
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream" });
    response.end(data);
  });
}
