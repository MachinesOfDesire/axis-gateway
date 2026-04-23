#!/usr/bin/env node
/**
 * Node HTTP server adapter. Wraps the framework-agnostic Gateway in an
 * http.Server so `axis-gateway path/to/config.json` just works.
 *
 * Usage:
 *   axis-gateway ./examples/simple-config.json
 *   AXIS_GATEWAY_CONFIG=./cfg.json axis-gateway
 */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { Gateway } from "./gateway.js";

async function main() {
  const configPath =
    process.argv[2] || process.env.AXIS_GATEWAY_CONFIG || "./axis-gateway.config.json";
  const config = loadConfig(configPath);
  const gateway = new Gateway({ config });

  const server = createServer(async (nodeReq, nodeRes) => {
    try {
      const fetchReq = await nodeToFetchRequest(nodeReq);
      const fetchRes = await gateway.handle(fetchReq);
      await writeFetchResponseToNode(fetchRes, nodeRes);
    } catch (err) {
      console.error("gateway error:", err);
      nodeRes.writeHead(500, { "Content-Type": "application/json" });
      nodeRes.end(
        JSON.stringify({ error: { code: "gateway_error", message: err.message } }),
      );
    }
  });

  server.listen(config.listenPort, () => {
    console.log(`axis-gateway listening on :${config.listenPort}`);
    console.log(`  registry: ${config.registryUrl}`);
    console.log(`  upstream: ${config.upstreamUrl}`);
    console.log(`  routes:   ${config.routes.length}`);
  });
}

// ── Node <-> Fetch API bridging ──────────────────────────────────────────

async function nodeToFetchRequest(nodeReq) {
  const url = `http://${nodeReq.headers.host || "localhost"}${nodeReq.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (Array.isArray(v)) v.forEach((vi) => headers.append(k, vi));
    else if (v !== undefined) headers.set(k, String(v));
  }
  let body;
  const method = (nodeReq.method || "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(method)) {
    body = await readBody(nodeReq);
  }
  return new Request(url, { method, headers, body });
}

async function writeFetchResponseToNode(fetchRes, nodeRes) {
  const headers = {};
  for (const [k, v] of fetchRes.headers.entries()) headers[k] = v;
  nodeRes.writeHead(fetchRes.status, headers);
  if (fetchRes.body) {
    const reader = fetchRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      nodeRes.write(value);
    }
  }
  nodeRes.end();
}

function readBody(nodeReq) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    nodeReq.on("data", (c) => chunks.push(c));
    nodeReq.on("end", () => resolve(Buffer.concat(chunks)));
    nodeReq.on("error", reject);
  });
}

// Only run `main` when invoked as a script, not when imported.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.js")) {
  main().catch((err) => {
    console.error("fatal:", err.message);
    process.exit(1);
  });
}
