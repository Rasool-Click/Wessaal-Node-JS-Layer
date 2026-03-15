/* ─────────────────────────────────────────────────────────────
   WESSAAL NODE LAYER — Unified Bridge & Forwarder
   ─────────────────────────────────────────────────────────────
   • Connects to Evolution API via socket.io-client (Stage 2)
   • Forwards events to Laravel backend via Axios  (Stage 3)
   • Broadcasts to frontend browsers via Socket.IO (Stage 1)
   • Supports outbound HTTPS proxy to bypass ISP/edge blocks
   • Exponential-backoff retries on ECONNRESET / ETIMEDOUT / 5xx
   • Pre-flight TLS handshake diagnostics on startup
   ───────────────────────────────────────────────────────────── */

require("dotenv").config();

const { io: ioClient } = require("socket.io-client");
const express = require("express");
const http = require("http");
const tls = require("tls");
const dns = require("dns");
const { Server } = require("socket.io");
const axios = require("axios");
const axiosRetry = require("axios-retry").default || require("axios-retry");
const { HttpsProxyAgent } = require("https-proxy-agent");

/* ───────── Helpers ───────── */

const track = (stage, status, detail = "") => {
  const time = new Date().toISOString();
  const icon =
    status === "ERROR" ? "❌" : status === "SUCCESS" ? "✅" : "ℹ️";
  console.log(
    `[${time}] ${icon} [${stage.padEnd(12)}] ${status.padEnd(8)} | ${detail}`,
  );
};

const mask = (val = "", show = 4) =>
  val.length > show ? val.slice(0, show) + "••••" : "***";

/* ───────── Environment ───────── */

const WEBSOCKET_ENABLED =
  (process.env.WEBSOCKET_ENABLED || "").toLowerCase() === "true";
const WEBSOCKET_GLOBAL_EVENTS =
  (process.env.WEBSOCKET_GLOBAL_EVENTS || "").toLowerCase() === "true";
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const INSTANCE_NAME = process.env.INSTANCE_NAME || "";
const EVENTS = (process.env.EVENTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const FRONT_WS_PORT = Number(
  process.env.PORT || process.env.FRONT_WS_PORT || 4000,
);
const FRONT_ORIGIN = (process.env.FRONT_ORIGIN || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const FRONT_WS_PATH = process.env.FRONT_WS_PATH || "/ws";
const TRUST_PROXY =
  (process.env.TRUST_PROXY || "true").toLowerCase() === "true";

const BACKEND_URL = process.env.BACKEND_URL || "";
const FORWARDER_API_KEY =
  process.env.BACKEND_API_KEY || process.env.EVOLUTION_API_KEY || "";
const FORWARDER_WEBHOOK_SECRET =
  process.env.BACKEND_WEBHOOK_SECRET ||
  process.env.EVOLUTION_WEBHOOK_SECRET ||
  "";
const FORWARD_EVENTS = (process.env.FORWARD_EVENTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const INCLUDE_RAW =
  (process.env.INCLUDE_RAW || "false").toLowerCase() === "true";
const RAW_MAX = parseInt(process.env.RAW_MAX, 10) || 512;

const FORWARD_TIMEOUT_MS =
  parseInt(process.env.FORWARD_TIMEOUT_MS, 10) || 10000;
const FORWARD_RETRIES = parseInt(process.env.FORWARD_RETRIES, 10) || 4;

// Proxy — set HTTPS_PROXY or HTTP_PROXY in .env to tunnel outbound traffic
const PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy ||
  "";

/* ================================================================
   STAGE 0 — PRE-FLIGHT TLS HANDSHAKE DIAGNOSTICS
   ================================================================ */

async function preflightCheck(targetUrl) {
  if (!targetUrl) return;

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    track("PREFLIGHT", "ERROR", `Invalid BACKEND_URL: ${targetUrl}`);
    return;
  }

  const host = parsed.hostname;
  const port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);
  const isHttps = parsed.protocol === "https:";

  track("PREFLIGHT", "INFO", `Target: ${host}:${port} (${parsed.protocol})`);

  // ── DNS Resolution ──
  try {
    const addresses = await dns.promises.resolve4(host);
    track("PREFLIGHT", "SUCCESS", `DNS resolved: ${addresses.join(", ")}`);
  } catch (err) {
    track(
      "PREFLIGHT",
      "ERROR",
      `DNS resolution failed: ${err.code} — ${err.message}`,
    );
    return;
  }

  // ── TCP + TLS Handshake (HTTPS targets only) ──
  if (isHttps) {
    await new Promise((resolve) => {
      const sock = tls.connect(
        {
          host,
          port: Number(port),
          servername: host,
          timeout: 8000,
          rejectUnauthorized: true,
        },
        () => {
          const proto = sock.getProtocol?.() || "unknown";
          const cipher = sock.getCipher?.()?.name || "unknown";
          const cert = sock.getPeerCertificate?.();
          const cn = cert?.subject?.CN || "n/a";
          const validTo = cert?.valid_to || "n/a";
          track(
            "PREFLIGHT",
            "SUCCESS",
            `TLS OK — proto=${proto}, cipher=${cipher}, CN=${cn}, validTo=${validTo}`,
          );
          sock.end();
          resolve();
        },
      );

      sock.on("error", (err) => {
        track(
          "PREFLIGHT",
          "ERROR",
          `TLS handshake FAILED — code=${err.code || "n/a"}, errno=${err.errno || "n/a"}, msg=${err.message}`,
        );
        track(
          "PREFLIGHT",
          "INFO",
          "⚠️  This strongly suggests an ISP/edge filter is resetting the connection. Configure HTTPS_PROXY to bypass.",
        );
        resolve();
      });

      sock.on("timeout", () => {
        track("PREFLIGHT", "ERROR", "TLS handshake timed out (8 s)");
        sock.destroy();
        resolve();
      });
    });
  }

  // ── Proxy reachability (if configured) ──
  if (PROXY_URL) {
    track("PREFLIGHT", "INFO", `Proxy configured: ${mask(PROXY_URL, 20)}`);
    try {
      const agent = new HttpsProxyAgent(PROXY_URL);
      const testRes = await axios.head(targetUrl, {
        httpAgent: agent,
        httpsAgent: agent,
        timeout: 8000,
        validateStatus: () => true,
      });
      track(
        "PREFLIGHT",
        "SUCCESS",
        `Proxy HEAD check returned HTTP ${testRes.status}`,
      );
    } catch (err) {
      track(
        "PREFLIGHT",
        "ERROR",
        `Proxy HEAD check failed — ${err.code || ""} ${err.message}`,
      );
    }
  }
}

/* ================================================================
   STAGE 1 — FRONT-END SOCKET.IO SERVER  (Browser Broadcasting)
   ================================================================ */

let evoSocket = null; // referenced by /ready and shutdown

const app = express();
if (TRUST_PROXY) app.set("trust proxy", 1);

app.get("/health", (_, res) => res.send("ok"));
app.get("/ready", (_, res) =>
  res.json({
    ready: true,
    evoConnected: !!evoSocket?.connected,
    proxy: !!PROXY_URL,
    uptime: process.uptime(),
  }),
);

const httpServer = http.createServer(app);
const ioFront = new Server(httpServer, {
  path: FRONT_WS_PATH,
  cors: {
    origin: FRONT_ORIGIN,
    credentials: true,
    methods: ["GET", "POST"],
  },
  perMessageDeflate: false,
});

ioFront.on("connection", (sock) => {
  track("FRONT_WS", "CONNECT", `Browser linked: ${sock.id}`);

  sock.on("join_instance", ({ instance } = {}, cb) => {
    try {
      if (!instance) {
        track("FRONT_WS", "ERROR", "Join failed — no instance name");
        return cb?.({ ok: false, error: "missing_instance" });
      }
      const room = `inst:${instance}`;
      sock.join(room);
      track("FRONT_WS", "SUCCESS", `${sock.id} → room ${room}`);
      return cb?.({ ok: true, room });
    } catch (e) {
      track("FRONT_WS", "ERROR", `Room join error: ${e.message}`);
      return cb?.({ ok: false, error: String(e) });
    }
  });

  sock.on("disconnect", (reason) => {
    track("FRONT_WS", "INFO", `${sock.id} disconnected (${reason})`);
  });
});

function emitToInstance(formatted) {
  const inst = formatted.instance || "unknown";
  const room = `inst:${inst}`;
  const size = ioFront.sockets.adapter.rooms.get(room)?.size || 0;

  if (size > 0) {
    track("EMIT", "SUCCESS", `→ ${size} client(s) in ${room}`);
    ioFront.to(room).emit("evolution:event", formatted);
  } else {
    track("EMIT", "DROP", `No listeners in ${room}`);
  }
}

/* ================================================================
   STAGE 2 — EVOLUTION API CLIENT  (Inbound Events)
   ================================================================ */

function bootEvolutionClient() {
  if (!WEBSOCKET_ENABLED) {
    track("SYS", "INFO", "WEBSOCKET_ENABLED=false — evolution client skipped");
    return;
  }
  if (!EVOLUTION_API_URL) {
    track("SYS", "ERROR", "EVOLUTION_API_URL missing — exiting");
    process.exit(1);
  }

  let connectUrl = EVOLUTION_API_URL;
  if (!WEBSOCKET_GLOBAL_EVENTS) {
    if (!INSTANCE_NAME) {
      track("SYS", "ERROR", "Traditional mode requires INSTANCE_NAME");
      process.exit(1);
    }
    try {
      const u = new URL(EVOLUTION_API_URL);
      let base = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
      u.pathname = `${base}/${INSTANCE_NAME}`;
      connectUrl = u.toString();
    } catch {
      connectUrl = `${EVOLUTION_API_URL.replace(/\/$/, "")}/${INSTANCE_NAME}`;
    }
  }

  track("EVO_API", "INFO", `Connecting → ${connectUrl}`);

  const ALLOW_POLLING =
    (process.env.ALLOW_POLLING || "true").toLowerCase() === "true";

  const socketOpts = {
    // ── Robust reconnection for unstable networks ──
    reconnection: true,
    reconnectionAttempts: Infinity, // never give up
    reconnectionDelay: 2000, // start at 2 s
    reconnectionDelayMax: 30000, // cap at 30 s
    randomizationFactor: 0.3, // jitter ±30 %
    timeout: 20000, // connection timeout
    // ── Keep-alive ──
    pingInterval: 25000,
    pingTimeout: 20000,
  };

  if (ALLOW_POLLING) {
    socketOpts.transports = ["polling"];
    socketOpts.upgrade = false;
  } else {
    socketOpts.transports = ["websocket"];
    socketOpts.upgrade = true;
  }

  evoSocket = ioClient(connectUrl, socketOpts);

  evoSocket.on("connect", () => {
    track("EVO_API", "SUCCESS", `Connected — ID: ${evoSocket.id}`);
  });

  evoSocket.on("disconnect", (reason) => {
    track("EVO_API", "INFO", `Disconnected (${reason})`);
  });

  evoSocket.on("connect_error", (err) => {
    track(
      "EVO_API",
      "ERROR",
      `Connect error — code=${err.code || "n/a"} msg=${err.message}`,
    );
  });

  evoSocket.io.on("reconnect_attempt", (attempt) => {
    track("EVO_API", "INFO", `Reconnect attempt #${attempt}`);
  });

  evoSocket.io.on("reconnect", (attempt) => {
    track("EVO_API", "SUCCESS", `Reconnected after ${attempt} attempt(s)`);
  });

  evoSocket.io.on("reconnect_failed", () => {
    track(
      "EVO_API",
      "ERROR",
      "Reconnection exhausted (should not happen with Infinity)",
    );
  });

  // ── Event subscription ──
  if (FORWARD_EVENTS.length > 0) {
    FORWARD_EVENTS.forEach((evt) => {
      evoSocket.on(evt, async (data) => {
        const formatted = formatEvent(evt, data);
        track("FLOW", "RECEIVE", `${evt} (instance: ${formatted.instance})`);
        await sendToBackend(formatted);
        emitToInstance(formatted);
      });
    });
  } else {
    evoSocket.onAny(async (event, ...args) => {
      const payload = args.length === 1 ? args[0] : args;
      const formatted = formatEvent(event, payload);
      track("FLOW", "RECEIVE", `${event} (instance: ${formatted.instance})`);
      await sendToBackend(formatted);
      emitToInstance(formatted);
    });
  }
}

/* ================================================================
   STAGE 3 — OUTBOUND AXIOS CLIENT  (Backend Forwarding)
   ================================================================ */

/** Build a dedicated axios instance with proxy, retries, timeouts */
function createApiClient() {
  const cfg = {
    timeout: FORWARD_TIMEOUT_MS,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Wessaal-Node-Layer/1.0",
    },
  };

  // ── Outbound proxy — routes traffic via external IP ──
  if (PROXY_URL) {
    const agent = new HttpsProxyAgent(PROXY_URL);
    cfg.httpAgent = agent;
    cfg.httpsAgent = agent;
    cfg.proxy = false; // disable axios' built-in env proxy
    track("AXIOS", "INFO", `Proxy agent attached: ${mask(PROXY_URL, 20)}`);
  }

  const instance = axios.create(cfg);

  // ── Exponential-backoff retries ──
  axiosRetry(instance, {
    retries: FORWARD_RETRIES,
    retryDelay: (retryCount) => {
      const delay = axiosRetry.exponentialDelay(retryCount);
      track("RETRY", "INFO", `Back-off #${retryCount} — waiting ${delay} ms`);
      return delay;
    },
    retryCondition: (error) => {
      // Network-level resets / timeouts
      const code = error.code || "";
      if (
        [
          "ECONNRESET",
          "ETIMEDOUT",
          "ECONNABORTED",
          "EPIPE",
          "EAI_AGAIN",
          "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
        ].includes(code)
      ) {
        return true;
      }
      // 5xx server errors
      if (error.response && error.response.status >= 500) {
        return true;
      }
      // Fallback to built-in check
      return axiosRetry.isNetworkOrIdempotentRequestError(error);
    },
    shouldResetTimeout: true,
    onRetry: (retryCount, error, requestConfig) => {
      track(
        "RETRY",
        "INFO",
        `[${retryCount}/${FORWARD_RETRIES}] code=${error.code || "n/a"} status=${error.response?.status || "n/a"} url=${requestConfig.url}`,
      );
    },
  });

  return instance;
}

const api = createApiClient();

/** Extract local outbound IP from the failed request socket */
function getLocalAddress(err) {
  const addr = err?.request?.socket?.localAddress;
  const port = err?.request?.socket?.localPort;
  if (addr) return `${addr}:${port}`;
  return "unknown";
}

async function sendToBackend(formatted) {
  if (!BACKEND_URL) return;

  const headers = {};
  if (FORWARDER_WEBHOOK_SECRET)
    headers["x-webhook-secret"] = FORWARDER_WEBHOOK_SECRET;
  if (FORWARDER_API_KEY)
    headers["x-evolution-api-key"] = FORWARDER_API_KEY;

  // Unique request ID for end-to-end tracing
  headers["x-request-id"] = `wn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const res = await api.post(BACKEND_URL, formatted, { headers });
    track(
      "FORWARD",
      "SUCCESS",
      `HTTP ${res.status} → ${BACKEND_URL} [req:${headers["x-request-id"]}]`,
    );
  } catch (err) {
    const code = err.code || "UNKNOWN";
    const status = err.response?.status || "n/a";
    const localAddr = getLocalAddress(err);
    const retries = err.config?.["axios-retry"]?.retryCount ?? 0;

    track(
      "FORWARD",
      "ERROR",
      [
        `FAILED after ${retries}/${FORWARD_RETRIES} retries`,
        `code=${code}`,
        `status=${status}`,
        `localIP=${localAddr}`,
        `errno=${err.errno || "n/a"}`,
        `msg=${err.message}`,
        `proxy=${PROXY_URL ? "yes" : "no"}`,
        `req=${headers["x-request-id"]}`,
      ].join(" | "),
    );

    // Actionable hint for known ISP blocks
    if (
      ["ECONNRESET", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE"].includes(
        code,
      ) &&
      !PROXY_URL
    ) {
      track(
        "FORWARD",
        "INFO",
        "⚠️  Persistent ECONNRESET without proxy — set HTTPS_PROXY in .env to route around the block.",
      );
    }
  }
}

/* ================================================================
   EVENT FORMATTING
   ================================================================ */

function pickInstance(payload) {
  return (
    payload?.instance ||
    payload?.instanceName ||
    payload?.data?.instance ||
    "unknown"
  );
}

function formatEvent(eventName, payload) {
  const MAX_RAW = RAW_MAX;

  function safeStringify(obj, maxLen = MAX_RAW) {
    try {
      const s = JSON.stringify(obj);
      return s.length > maxLen ? s.slice(0, maxLen) + "...<truncated>" : s;
    } catch {
      return "<unserializable>";
    }
  }

  function extractMessage(m) {
    if (!m) return null;
    return {
      id: m.id || m._id || m.messageId || null,
      from: m.from || m.author || m.sender || null,
      text:
        m.text ||
        m.body ||
        (m.content && (m.content.text || m.content.body)) ||
        null,
      ts: m.timestamp || m.ts || m.createdAt || null,
      attachmentsCount: Array.isArray(m.attachments)
        ? m.attachments.length
        : 0,
    };
  }

  const envelope = {
    version: "1.0",
    event: eventName,
    receivedAt: new Date().toISOString(),
    instance: pickInstance(payload),
    id: null,
    type: null,
    actor: null,
    body: null,
    meta: {},
  };

  try {
    switch (eventName) {
      case "messages.upsert": {
        const msg = payload?.message || payload;
        const m = extractMessage(msg);
        envelope.id = m?.id;
        envelope.type = "message";
        envelope.actor = m?.from;
        envelope.body = { ...m };
        if (INCLUDE_RAW) envelope.raw = safeStringify(payload);
        break;
      }
      case "qrcode.updated":
      case "connection.update": {
        // Full payloads — no truncation
        envelope.type = eventName.split(".")[0];
        envelope.body = payload;
        envelope.raw = JSON.stringify(payload);
        break;
      }
      default: {
        envelope.type = "generic";
        envelope.body = payload;
        if (INCLUDE_RAW) envelope.raw = safeStringify(payload);
      }
    }
  } catch (e) {
    envelope.meta.error = String(e);
  }
  return envelope;
}

/* ================================================================
   BOOT SEQUENCE
   ================================================================ */

async function main() {
  console.log("\n╔═══════════════════════════════════════════════╗");
  console.log("║       WESSAAL NODE LAYER — Starting...        ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  // ── Config summary (masked secrets) ──
  console.log("── Config ──────────────────────────────────────");
  console.log(`  BACKEND_URL        : ${BACKEND_URL || "(not set)"}`);
  console.log(
    `  HTTPS_PROXY        : ${PROXY_URL ? mask(PROXY_URL, 20) : "(not set)"}`,
  );
  console.log(
    `  WEBHOOK_SECRET     : ${FORWARDER_WEBHOOK_SECRET ? mask(FORWARDER_WEBHOOK_SECRET) : "(not set)"}`,
  );
  console.log(
    `  API_KEY            : ${FORWARDER_API_KEY ? mask(FORWARDER_API_KEY) : "(not set)"}`,
  );
  console.log(`  FORWARD_RETRIES    : ${FORWARD_RETRIES}`);
  console.log(`  FORWARD_TIMEOUT_MS : ${FORWARD_TIMEOUT_MS}`);
  console.log(`  EVOLUTION_API_URL  : ${EVOLUTION_API_URL || "(not set)"}`);
  console.log(`  WEBSOCKET_ENABLED  : ${WEBSOCKET_ENABLED}`);
  console.log(`  GLOBAL_EVENTS      : ${WEBSOCKET_GLOBAL_EVENTS}`);
  console.log(`  INSTANCE_NAME      : ${INSTANCE_NAME || "(all)"}`);
  console.log(`  FRONT_WS_PORT      : ${FRONT_WS_PORT}`);
  console.log(`  FRONT_WS_PATH      : ${FRONT_WS_PATH}`);
  console.log(`  TRUST_PROXY        : ${TRUST_PROXY}`);
  console.log("────────────────────────────────────────────────\n");

  // ── Pre-flight TLS diagnostics ──
  await preflightCheck(BACKEND_URL);

  // ── Start HTTP + front WS server ──
  await new Promise((resolve, reject) => {
    httpServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        track("SYS", "ERROR", `Port ${FRONT_WS_PORT} is already in use. Set a different PORT or FRONT_WS_PORT in .env`);
        reject(err);
      } else {
        reject(err);
      }
    });
    httpServer.listen(FRONT_WS_PORT, () => {
      console.log(`\n🚀 WESSAAL NODE LAYER STARTED`);
      console.log(`📡 Listening on :${FRONT_WS_PORT} | Path: ${FRONT_WS_PATH}`);
      console.log(`🌍 Origins: ${FRONT_ORIGIN.join(", ")}\n`);
      resolve();
    });
  });

  // ── Connect to Evolution API ──
  bootEvolutionClient();
}

main().catch((err) => {
  track("SYS", "ERROR", `Fatal boot error: ${err.message}`);
  process.exit(1);
});

/* ================================================================
   GRACEFUL SHUTDOWN
   ================================================================ */

function shutdown(signal) {
  track("SYS", "INFO", `Shutdown signal: ${signal}`);
  if (evoSocket?.connected) evoSocket.disconnect();
  try {
    ioFront.disconnectSockets(true);
    ioFront.close();
  } catch {}
  httpServer.close(() => {
    track("SYS", "INFO", "HTTP server closed");
    process.exit(0);
  });
  // Force exit after 5 s if graceful close hangs
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
