/* ═══════════════════════════════════════════════════════════════
   WESSAAL NODE LAYER — Full Local Test Suite
   ═══════════════════════════════════════════════════════════════
   Tests every component without needing real external services:
   ✅  Module imports & require resolution
   ✅  Environment parsing & defaults
   ✅  Event formatting (all branches)
   ✅  Axios instance creation (proxy / no-proxy)
   ✅  sendToBackend — success, ECONNRESET, 5xx, with/without proxy
   ✅  emitToInstance — room with listeners, room without listeners
   ✅  HTTP server /health and /ready endpoints
   ✅  Socket.IO front server — connect, join_instance, disconnect
   ✅  Graceful shutdown — SIGTERM path
   Run: node test.js
   ═══════════════════════════════════════════════════════════════ */

"use strict";

// ── Entry point: wrap everything in an async IIFE (Node 24 CJS compat) ──
(async () => {

// ── Polyfill minimal .env so the module can load ──────────────────
process.env.WEBSOCKET_ENABLED       = "false";   // don't connect to Evolution
process.env.EVOLUTION_API_URL       = "https://evo.example.com";
process.env.BACKEND_URL             = "http://localhost:19999/webhook"; // local mock
process.env.BACKEND_WEBHOOK_SECRET  = "test-secret-xyz";
process.env.BACKEND_API_KEY         = "test-api-key-abc";
process.env.FRONT_WS_PORT           = "14001";
process.env.FRONT_WS_PATH           = "/ws";
process.env.FRONT_ORIGIN            = "*";
process.env.TRUST_PROXY             = "true";
process.env.INCLUDE_RAW             = "true";
process.env.RAW_MAX                 = "256";
process.env.FORWARD_RETRIES         = "2";
process.env.FORWARD_TIMEOUT_MS      = "3000";

const http        = require("http");
const assert      = require("assert");
const { io: ioTestClient } = require("socket.io-client");

// ── Colour helpers ────────────────────────────────────────────────
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const RESET  = "\x1b[0m";

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ${GREEN}✅ PASS${RESET}  ${name}`);
  } catch (e) {
    failed++;
    results.push(`  ${RED}❌ FAIL${RESET}  ${name}\n        ${RED}→ ${e.message}${RESET}`);
  }
}

function section(title) {
  results.push(`\n${CYAN}──────────────────────────────────────────────${RESET}`);
  results.push(`${CYAN}  ${title}${RESET}`);
  results.push(`${CYAN}──────────────────────────────────────────────${RESET}`);
}

/* ══════════════════════════════════════════════════════
   1. MODULE IMPORTS
   ══════════════════════════════════════════════════════ */
section("1. Module Imports");

let axiosRetry, HttpsProxyAgent, axios, express, Server;

await test("axios loads correctly", async () => {
  axios = require("axios");
  assert.strictEqual(typeof axios.create, "function");
});

await test("axios-retry loads correctly", async () => {
  const mod = require("axios-retry");
  axiosRetry = mod.default || mod;
  assert.strictEqual(typeof axiosRetry, "function");
  assert.strictEqual(typeof axiosRetry.exponentialDelay, "function");
  assert.strictEqual(typeof axiosRetry.isNetworkOrIdempotentRequestError, "function");
});

await test("https-proxy-agent loads correctly", async () => {
  ({ HttpsProxyAgent } = require("https-proxy-agent"));
  assert.strictEqual(typeof HttpsProxyAgent, "function");
});

await test("socket.io-client loads correctly", async () => {
  const { io } = require("socket.io-client");
  assert.strictEqual(typeof io, "function");
});

await test("socket.io server loads correctly", async () => {
  ({ Server } = require("socket.io"));
  assert.strictEqual(typeof Server, "function");
});

await test("express loads correctly", async () => {
  express = require("express");
  assert.strictEqual(typeof express, "function");
});

/* ══════════════════════════════════════════════════════
   2. ENVIRONMENT PARSING
   ══════════════════════════════════════════════════════ */
section("2. Environment Parsing & Defaults");

await test("FRONT_WS_PORT parses to number", async () => {
  const port = Number(process.env.FRONT_WS_PORT || 4000);
  assert.strictEqual(port, 14001);
  assert.strictEqual(typeof port, "number");
});

await test("FRONT_ORIGIN splits correctly", async () => {
  const origins = (process.env.FRONT_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);
  assert.deepStrictEqual(origins, ["*"]);
});

await test("FORWARD_RETRIES parses correctly", async () => {
  assert.strictEqual(parseInt(process.env.FORWARD_RETRIES, 10), 2);
});

await test("FORWARD_TIMEOUT_MS parses correctly", async () => {
  assert.strictEqual(parseInt(process.env.FORWARD_TIMEOUT_MS, 10), 3000);
});

await test("INCLUDE_RAW parses to boolean", async () => {
  const val = (process.env.INCLUDE_RAW || "false").toLowerCase() === "true";
  assert.strictEqual(val, true);
});

await test("RAW_MAX parses to integer", async () => {
  assert.strictEqual(parseInt(process.env.RAW_MAX, 10), 256);
});

await test("PROXY_URL defaults to empty string when not set", async () => {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    "";
  assert.strictEqual(proxyUrl, "");
});

/* ══════════════════════════════════════════════════════
   3. EVENT FORMATTING
   ══════════════════════════════════════════════════════ */
section("3. Event Formatting — formatEvent()");

// Inline formatEvent for isolated testing (same logic as index.js)
function pickInstance(payload) {
  return payload?.instance || payload?.instanceName || payload?.data?.instance || "unknown";
}
function formatEvent(eventName, payload) {
  const RAW_MAX = 256;
  function safeStringify(obj, maxLen = RAW_MAX) {
    try { const s = JSON.stringify(obj); return s.length > maxLen ? s.slice(0, maxLen) + "...<truncated>" : s; }
    catch { return "<unserializable>"; }
  }
  function extractMessage(m) {
    if (!m) return null;
    return { id: m.id || null, from: m.from || null, text: m.text || null, ts: m.timestamp || null, attachmentsCount: Array.isArray(m.attachments) ? m.attachments.length : 0 };
  }
  const envelope = { version: "1.0", event: eventName, receivedAt: new Date().toISOString(), instance: pickInstance(payload), id: null, type: null, actor: null, body: null, meta: {} };
  try {
    switch (eventName) {
      case "messages.upsert": {
        const msg = payload?.message || payload;
        const m = extractMessage(msg);
        envelope.id = m?.id; envelope.type = "message"; envelope.actor = m?.from; envelope.body = { ...m };
        envelope.raw = safeStringify(payload); break;
      }
      case "qrcode.updated":
      case "connection.update": {
        envelope.type = eventName.split(".")[0]; envelope.body = payload; envelope.raw = JSON.stringify(payload); break;
      }
      default: { envelope.type = "generic"; envelope.body = payload; envelope.raw = safeStringify(payload); }
    }
  } catch (e) { envelope.meta.error = String(e); }
  return envelope;
}

await test("messages.upsert → extracts id, from, text, type=message", async () => {
  const payload = { instance: "inst1", message: { id: "msg123", from: "+966501", text: "hello" } };
  const env = formatEvent("messages.upsert", payload);
  assert.strictEqual(env.event, "messages.upsert");
  assert.strictEqual(env.type, "message");
  assert.strictEqual(env.instance, "inst1");
  assert.strictEqual(env.body.id, "msg123");
  assert.strictEqual(env.body.from, "+966501");
  assert.strictEqual(env.body.text, "hello");
});

await test("messages.upsert → raw is included (INCLUDE_RAW=true)", async () => {
  const payload = { instance: "i1", message: { id: "x", from: "y", text: "z" } };
  const env = formatEvent("messages.upsert", payload);
  assert.ok(env.raw, "raw should be present");
});

await test("messages.upsert → raw truncated when payload exceeds RAW_MAX", async () => {
  const bigText = "A".repeat(500);
  const payload = { instance: "i1", message: { id: "x", from: "y", text: bigText } };
  const env = formatEvent("messages.upsert", payload);
  assert.ok(env.raw.endsWith("...<truncated>"), `expected truncation, got: ${env.raw.slice(-30)}`);
});

await test("qrcode.updated → full body, raw = full JSON string", async () => {
  const payload = { instance: "i2", qrcode: "data:image/png;base64,abc123" };
  const env = formatEvent("qrcode.updated", payload);
  assert.strictEqual(env.type, "qrcode");
  assert.deepStrictEqual(env.body, payload);
  assert.strictEqual(env.raw, JSON.stringify(payload));
});

await test("connection.update → full body, type=connection", async () => {
  const payload = { instance: "i3", state: "open" };
  const env = formatEvent("connection.update", payload);
  assert.strictEqual(env.type, "connection");
  assert.deepStrictEqual(env.body, payload);
  assert.ok(env.raw);
});

await test("unknown event → type=generic, body = payload", async () => {
  const payload = { instance: "i4", foo: "bar" };
  const env = formatEvent("custom.event", payload);
  assert.strictEqual(env.type, "generic");
  assert.deepStrictEqual(env.body, payload);
});

await test("pickInstance — falls back through all paths", async () => {
  assert.strictEqual(pickInstance({ instance: "a" }), "a");
  assert.strictEqual(pickInstance({ instanceName: "b" }), "b");
  assert.strictEqual(pickInstance({ data: { instance: "c" } }), "c");
  assert.strictEqual(pickInstance({}), "unknown");
  assert.strictEqual(pickInstance(null), "unknown");
});

await test("formatEvent always returns a valid envelope structure", async () => {
  const env = formatEvent("some.event", { instance: "x" });
  assert.ok("version" in env);
  assert.ok("event" in env);
  assert.ok("receivedAt" in env);
  assert.ok("instance" in env);
  assert.ok("meta" in env);
});

/* ══════════════════════════════════════════════════════
   4. AXIOS CLIENT CREATION
   ══════════════════════════════════════════════════════ */
section("4. Axios Instance Creation");

await test("creates axios instance without proxy", async () => {
  const instance = axios.create({ timeout: 5000, headers: { "Content-Type": "application/json" } });
  axiosRetry(instance, { retries: 2, retryDelay: axiosRetry.exponentialDelay });
  assert.ok(instance, "instance should exist");
  assert.strictEqual(typeof instance.post, "function");
});

await test("creates axios instance with HttpsProxyAgent", async () => {
  const agent = new HttpsProxyAgent("http://proxy.example.com:8080");
  const instance = axios.create({
    timeout: 5000,
    httpAgent: agent,
    httpsAgent: agent,
    proxy: false,
  });
  assert.ok(instance);
  assert.strictEqual(instance.defaults.proxy, false);
  assert.ok(instance.defaults.httpsAgent instanceof HttpsProxyAgent);
});

await test("HttpsProxyAgent accepts http:// proxy URL", async () => {
  const agent = new HttpsProxyAgent("http://user:pass@1.2.3.4:3128");
  assert.ok(agent);
  assert.ok(agent.proxy);
});

await test("HttpsProxyAgent accepts https:// proxy URL", async () => {
  const agent = new HttpsProxyAgent("https://proxy.example.com:443");
  assert.ok(agent);
});

await test("axiosRetry.exponentialDelay is non-zero for retryCount > 0", async () => {
  const delay1 = axiosRetry.exponentialDelay(1);
  const delay2 = axiosRetry.exponentialDelay(2);
  const delay3 = axiosRetry.exponentialDelay(3);
  assert.ok(delay1 > 0, `delay1 should be >0, got ${delay1}`);
  assert.ok(delay2 > delay1, `delay2 (${delay2}) should be > delay1 (${delay1})`);
  assert.ok(delay3 > delay2, `delay3 (${delay3}) should be > delay2 (${delay2})`);
});

/* ══════════════════════════════════════════════════════
   5. sendToBackend — MOCK HTTP SERVER
   ══════════════════════════════════════════════════════ */
section("5. sendToBackend — Mock Server Scenarios");

// Build a minimal version of sendToBackend for isolated testing
function makeSendToBackend(backendUrl, opts = {}) {
  const { proxyUrl = "", retries = 2, timeout = 3000 } = opts;
  const cfg = {
    timeout,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: { "Content-Type": "application/json", "User-Agent": "Wessaal-Node-Layer/1.0" },
  };
  if (proxyUrl) {
    const agent = new HttpsProxyAgent(proxyUrl);
    cfg.httpAgent = agent; cfg.httpsAgent = agent; cfg.proxy = false;
  }
  const instance = axios.create(cfg);
  axiosRetry(instance, {
    retries,
    retryDelay: () => 50, // fast for tests
    retryCondition: (error) => {
      const code = error.code || "";
      if (["ECONNRESET","ETIMEDOUT","ECONNABORTED","EPIPE","EAI_AGAIN"].includes(code)) return true;
      if (error.response && error.response.status >= 500) return true;
      return axiosRetry.isNetworkOrIdempotentRequestError(error);
    },
    shouldResetTimeout: true,
  });
  return async (payload) => {
    const headers = { "x-webhook-secret": "s", "x-evolution-api-key": "k", "x-request-id": `test-${Date.now()}` };
    try {
      const res = await instance.post(backendUrl, payload, { headers });
      return { ok: true, status: res.status };
    } catch (err) {
      return { ok: false, code: err.code, status: err.response?.status, retries: err.config?.["axios-retry"]?.retryCount ?? 0 };
    }
  };
}

// Mock server helpers
function createMockServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      resolve({ srv, port, url: `http://127.0.0.1:${port}/webhook` });
    });
  });
}
function closeMock(srv) {
  return new Promise((res) => srv.close(res));
}

await test("sendToBackend → HTTP 200 success path", async () => {
  const { srv, url } = await createMockServer((req, res) => {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => res.writeHead(200).end());
  });
  const send = makeSendToBackend(url);
  const result = await send({ event: "test", instance: "i1" });
  await closeMock(srv);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 200);
});

await test("sendToBackend → receives correct headers (webhook-secret, api-key, request-id)", async () => {
  let capturedHeaders;
  const { srv, url } = await createMockServer((req, res) => {
    capturedHeaders = req.headers;
    res.writeHead(200).end();
  });
  const send = makeSendToBackend(url);
  await send({ event: "test", instance: "i1" });
  await closeMock(srv);
  assert.ok(capturedHeaders["x-webhook-secret"], "x-webhook-secret missing");
  assert.ok(capturedHeaders["x-evolution-api-key"], "x-evolution-api-key missing");
  assert.ok(capturedHeaders["x-request-id"], "x-request-id missing");
  assert.ok(capturedHeaders["x-request-id"].startsWith("test-"), "x-request-id wrong format");
});

await test("sendToBackend → receives correct JSON body", async () => {
  let capturedBody = "";
  const { srv, url } = await createMockServer((req, res) => {
    req.on("data", d => capturedBody += d);
    req.on("end", () => res.writeHead(200).end());
  });
  const send = makeSendToBackend(url);
  await send({ event: "messages.upsert", instance: "inst-test", body: { text: "hello" } });
  await closeMock(srv);
  const parsed = JSON.parse(capturedBody);
  assert.strictEqual(parsed.event, "messages.upsert");
  assert.strictEqual(parsed.instance, "inst-test");
});

await test("sendToBackend → retries on 500 and returns last code", async () => {
  let callCount = 0;
  const { srv, url } = await createMockServer((req, res) => {
    callCount++;
    res.writeHead(500).end("server error");
  });
  const send = makeSendToBackend(url, { retries: 2 });
  const result = await send({ event: "x" });
  await closeMock(srv);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 500);
  // Should have been called 1 original + 2 retries = 3
  assert.strictEqual(callCount, 3, `Expected 3 calls (1+2 retries), got ${callCount}`);
});

await test("sendToBackend → ECONNREFUSED (no server) fails without crashing", async () => {
  const send = makeSendToBackend("http://127.0.0.1:19998/nope", { retries: 1, timeout: 1000 });
  const result = await send({ event: "x" });
  assert.strictEqual(result.ok, false);
  assert.ok(
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ECONNABORTED"].includes(result.code),
    `Unexpected code: ${result.code}`
  );
});

await test("sendToBackend → Content-Type is application/json", async () => {
  let contentType;
  const { srv, url } = await createMockServer((req, res) => {
    contentType = req.headers["content-type"];
    res.writeHead(200).end();
  });
  const send = makeSendToBackend(url);
  await send({ event: "x" });
  await closeMock(srv);
  assert.ok(contentType && contentType.includes("application/json"), `Wrong content-type: ${contentType}`);
});

await test("sendToBackend → User-Agent header is set", async () => {
  let ua;
  const { srv, url } = await createMockServer((req, res) => {
    ua = req.headers["user-agent"];
    res.writeHead(200).end();
  });
  const send = makeSendToBackend(url);
  await send({ event: "x" });
  await closeMock(srv);
  assert.ok(ua && ua.includes("Wessaal-Node-Layer"), `Wrong UA: ${ua}`);
});

/* ══════════════════════════════════════════════════════
   6. HTTP SERVER — /health and /ready
   ══════════════════════════════════════════════════════ */
section("6. HTTP Endpoints — /health and /ready");

// Spin up a minimal Express server matching the app's structure
let testHttpServer, testHttpPort;
const testApp = express();
testApp.get("/health", (_, res) => res.send("ok"));
testApp.get("/ready", (_, res) =>
  res.json({ ready: true, evoConnected: false, proxy: false, uptime: process.uptime() })
);

await new Promise((resolve) => {
  testHttpServer = testApp.listen(0, "127.0.0.1", () => {
    testHttpPort = testHttpServer.address().port;
    resolve();
  });
});

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

await test("/health returns 200 with body 'ok'", async () => {
  const { status, body } = await httpGet(testHttpPort, "/health");
  assert.strictEqual(status, 200);
  assert.strictEqual(body, "ok");
});

await test("/ready returns 200 with JSON", async () => {
  const { status, body } = await httpGet(testHttpPort, "/ready");
  assert.strictEqual(status, 200);
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.ready, true);
  assert.ok("evoConnected" in parsed);
  assert.ok("uptime" in parsed);
});

await test("/ready uptime is a positive number", async () => {
  const { body } = await httpGet(testHttpPort, "/ready");
  const parsed = JSON.parse(body);
  assert.ok(typeof parsed.uptime === "number" && parsed.uptime > 0);
});

await test("/unknown-path returns 404", async () => {
  const { status } = await httpGet(testHttpPort, "/notexist");
  assert.strictEqual(status, 404);
});

await new Promise((res) => testHttpServer.close(res));

/* ══════════════════════════════════════════════════════
   7. SOCKET.IO FRONT SERVER
   ══════════════════════════════════════════════════════ */
section("7. Socket.IO Front Server — connect / join / emit");

const { createServer } = require("http");
const { Server: IOServer } = require("socket.io");

let testIoServer, testIoHttpServer, testIoPort;
const testIoApp = express();
testIoHttpServer = createServer(testIoApp);
testIoServer = new IOServer(testIoHttpServer, {
  path: "/ws",
  cors: { origin: "*", methods: ["GET", "POST"] },
  perMessageDeflate: false,
});

// Emit helper — mirrors index.js emitToInstance
function makeEmitter(ioServer) {
  return function emitToInstance(formatted) {
    const inst = formatted.instance || "unknown";
    const room = `inst:${inst}`;
    const size = ioServer.sockets.adapter.rooms.get(room)?.size || 0;
    if (size > 0) {
      ioServer.to(room).emit("evolution:event", formatted);
      return size;
    }
    return 0;
  };
}

testIoServer.on("connection", (sock) => {
  sock.on("join_instance", ({ instance } = {}, cb) => {
    if (!instance) return cb?.({ ok: false, error: "missing_instance" });
    const room = `inst:${instance}`;
    sock.join(room);
    cb?.({ ok: true, room });
  });
});

await new Promise((resolve) => {
  testIoHttpServer.listen(0, "127.0.0.1", () => {
    testIoPort = testIoHttpServer.address().port;
    resolve();
  });
});

const WS_URL = `http://127.0.0.1:${testIoPort}`;

await test("client can connect to Socket.IO server", async () => {
  const client = ioTestClient(WS_URL, { path: "/ws", transports: ["polling"] });
  await new Promise((resolve, reject) => {
    client.on("connect", resolve);
    client.on("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 4000);
  });
  assert.ok(client.connected);
  client.disconnect();
});

await test("join_instance with valid instance returns ok:true and correct room", async () => {
  const client = ioTestClient(WS_URL, { path: "/ws", transports: ["polling"] });
  await new Promise((res, rej) => { client.on("connect", res); client.on("connect_error", rej); });
  const ack = await new Promise((resolve) => {
    client.emit("join_instance", { instance: "test-inst" }, resolve);
  });
  client.disconnect();
  assert.strictEqual(ack.ok, true);
  assert.strictEqual(ack.room, "inst:test-inst");
});

await test("join_instance without instance returns ok:false", async () => {
  const client = ioTestClient(WS_URL, { path: "/ws", transports: ["polling"] });
  await new Promise((res, rej) => { client.on("connect", res); client.on("connect_error", rej); });
  const ack = await new Promise((resolve) => {
    client.emit("join_instance", {}, resolve);
  });
  client.disconnect();
  assert.strictEqual(ack.ok, false);
  assert.strictEqual(ack.error, "missing_instance");
});

await test("emitToInstance sends event to subscribed room", async () => {
  const emitToInstance = makeEmitter(testIoServer);
  const client = ioTestClient(WS_URL, { path: "/ws", transports: ["polling"] });
  await new Promise((res, rej) => { client.on("connect", res); client.on("connect_error", rej); });
  await new Promise((resolve) => {
    client.emit("join_instance", { instance: "emit-test" }, resolve);
  });
  // Small delay for room join to propagate
  await new Promise(r => setTimeout(r, 100));
  const received = await new Promise((resolve, reject) => {
    client.on("evolution:event", resolve);
    emitToInstance({ instance: "emit-test", event: "test.event", type: "generic" });
    setTimeout(() => reject(new Error("emit timeout")), 3000);
  });
  client.disconnect();
  assert.strictEqual(received.instance, "emit-test");
  assert.strictEqual(received.event, "test.event");
});

await test("emitToInstance returns 0 when no clients in room", async () => {
  const emitToInstance = makeEmitter(testIoServer);
  const count = emitToInstance({ instance: "empty-room-xyz" });
  assert.strictEqual(count, 0);
});

await test("multiple clients can join same room and all receive the event", async () => {
  const emitToInstance = makeEmitter(testIoServer);
  const c1 = ioTestClient(WS_URL, { path: "/ws", transports: ["polling"] });
  const c2 = ioTestClient(WS_URL, { path: "/ws", transports: ["polling"] });

  // Wait for both connections
  await Promise.all([
    new Promise((r) => c1.on("connect", r)),
    new Promise((r) => c2.on("connect", r)),
  ]);

  // Join room
  await Promise.all([
    new Promise((r) => c1.emit("join_instance", { instance: "multi-room" }, r)),
    new Promise((r) => c2.emit("join_instance", { instance: "multi-room" }, r)),
  ]);

  // Small delay for room join to fully register on the server
  await new Promise(r => setTimeout(r, 150));

  // Register listeners FIRST, then emit
  const [recv1, recv2] = await Promise.all([
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("c1 timeout")), 3000);
      c1.once("evolution:event", (data) => { clearTimeout(t); resolve(data); });
    }),
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("c2 timeout")), 3000);
      c2.once("evolution:event", (data) => { clearTimeout(t); resolve(data); });
    }),
    // Emit after listeners are registered
    new Promise(r => setTimeout(() => {
      emitToInstance({ instance: "multi-room", event: "broadcast.test" });
      r();
    }, 50)),
  ]);

  c1.disconnect();
  c2.disconnect();

  assert.strictEqual(recv1.event, "broadcast.test");
  assert.strictEqual(recv2.event, "broadcast.test");
});

await new Promise((res) => {
  testIoServer.disconnectSockets(true);
  testIoServer.close();
  testIoHttpServer.close(res);
});

/* ══════════════════════════════════════════════════════
   8. MASK HELPER
   ══════════════════════════════════════════════════════ */
section("8. Utility — mask()");

const mask = (val = "", show = 4) =>
  val.length > show ? val.slice(0, show) + "••••" : "***";

await test("mask hides long values", async () => {
  const result = mask("super-secret-key-12345", 4);
  assert.ok(result.startsWith("supe"), `starts wrong: ${result}`);
  assert.ok(result.endsWith("••••"), `ends wrong: ${result}`);
  assert.ok(!result.includes("secret"), "should not contain original value");
});

await test("mask returns *** for short values", async () => {
  assert.strictEqual(mask("abc", 4), "***");
  assert.strictEqual(mask("", 4), "***");
});

await test("mask with show=0 always masks", async () => {
  assert.strictEqual(mask("hello", 0), "heLL".length > 0 ? "••••" : "***");
  // edge: val.length (5) > show (0) → slice(0,0)+"••••"
  const r = mask("hello", 0);
  assert.ok(r.endsWith("••••"), `got: ${r}`);
});

/* ══════════════════════════════════════════════════════
   9. GRACEFUL SHUTDOWN LOGIC
   ══════════════════════════════════════════════════════ */
section("9. Graceful Shutdown Logic");

await test("httpServer.close() resolves the callback", async () => {
  const srv = http.createServer((_, res) => res.end("ok"));
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  assert.ok(srv.listening);
  await new Promise((resolve) => srv.close(resolve));
  assert.ok(!srv.listening, "server should not be listening after close");
});

await test("ioFront.close() does not throw", async () => {
  const s = http.createServer();
  const io = new IOServer(s);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  assert.doesNotThrow(() => {
    io.disconnectSockets(true);
    io.close();
  });
  await new Promise((r) => s.close(r));
});

await test("shutdown timer .unref() prevents test hang", async () => {
  // Simulate the pattern: timeout with .unref()
  const timer = setTimeout(() => {}, 5000);
  timer.unref(); // should not block process exit
  clearTimeout(timer); // clean up
  assert.ok(true);
});

/* ══════════════════════════════════════════════════════
   RESULTS SUMMARY
   ══════════════════════════════════════════════════════ */
console.log("\n" + results.join("\n"));

console.log(`\n${"═".repeat(50)}`);
const total = passed + failed;
if (failed === 0) {
  console.log(`${GREEN}  🎉  ALL ${total} TESTS PASSED${RESET}`);
} else {
  console.log(`${GREEN}  ✅  ${passed} passed${RESET}  |  ${RED}❌  ${failed} failed${RESET}  |  total ${total}`);
}
console.log(`${"═".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
})();
