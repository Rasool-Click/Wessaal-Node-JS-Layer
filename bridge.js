require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { io: evoIo } = require("socket.io-client");
const axios = require("axios");
const crypto = require("crypto");

/** =========================
 *  A) Front Socket Server
 ========================= */
// Prefer platform-provided PORT, fallback to FRONT_WS_PORT, then 4000
const FRONT_WS_PORT = Number(process.env.PORT || process.env.FRONT_WS_PORT || 4000);
const FRONT_ORIGIN = (process.env.FRONT_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);
const FRONT_WS_PATH = process.env.FRONT_WS_PATH || "/ws"; // mount socket under a path for reverse proxy
const TRUST_PROXY = (process.env.TRUST_PROXY || "true").toLowerCase() === "true";

const app = express();
if (TRUST_PROXY) app.set("trust proxy", 1);
// Health/Readiness endpoints for production probes
app.get("/health", (_, res) => res.send("ok"));
app.get("/ready", (_, res) => res.send("ready"));

const server = http.createServer(app);

const ioFront = new Server(server, {
  path: FRONT_WS_PATH,
  cors: { origin: FRONT_ORIGIN, credentials: true, methods: ["GET", "POST"] },
  perMessageDeflate: false,
});

ioFront.on("connection", (socket) => {
  console.log("✅ Front connected:", socket.id);

  // هذا اللي الفرونت عندك بيستخدمه (مع ACK)
  socket.on("join_instance", ({ instance }, cb) => {
    try {
      if (!instance) return cb?.({ ok: false, error: "missing_instance" });

      const room = `inst:${instance}`;
      socket.join(room);
      console.log("✅ joined room:", room);

      return cb?.({ ok: true, room });
    } catch (e) {
      return cb?.({ ok: false, error: String(e) });
    }
  });
});

server.listen(FRONT_WS_PORT, () => {
  console.log("✅ Front WS listening on", FRONT_WS_PORT, "path:", FRONT_WS_PATH, "origins:", FRONT_ORIGIN.join(", "));
});

/** =========================
 *  B) Evolution Listener (Client)
 ========================= */
const WEBSOCKET_ENABLED =
  (process.env.WEBSOCKET_ENABLED || "").toLowerCase() === "true";
const WEBSOCKET_GLOBAL_EVENTS =
  (process.env.WEBSOCKET_GLOBAL_EVENTS || "").toLowerCase() === "true";
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const INSTANCE_NAME = process.env.INSTANCE_NAME || "";

if (!WEBSOCKET_ENABLED) {
  console.log("WEBSOCKET_ENABLED is not true. Exiting.");
  process.exit(0);
}
if (!EVOLUTION_API_URL) {
  console.error("EVOLUTION_API_URL is not set.");
  process.exit(1);
}

let connectUrl = EVOLUTION_API_URL;
if (!WEBSOCKET_GLOBAL_EVENTS) {
  if (!INSTANCE_NAME) {
    console.error("Traditional mode: INSTANCE_NAME must be provided.");
    process.exit(1);
  }
  try {
    const urlObj = new URL(EVOLUTION_API_URL);
    let basePath =
      urlObj.pathname === "/" ? "" : urlObj.pathname.replace(/\/$/, "");
    urlObj.pathname = `${basePath}/${INSTANCE_NAME}`;
    connectUrl = urlObj.toString();
  } catch {
    connectUrl = `${EVOLUTION_API_URL.replace(/\/$/, "")}/${INSTANCE_NAME}`;
  }
}

console.log("Connecting to Evolution at", connectUrl);

const ALLOW_POLLING =
  (process.env.ALLOW_POLLING || "true").toLowerCase() === "true";

const socketOpts = { reconnectionAttempts: 10, reconnectionDelay: 2000 };
if (ALLOW_POLLING) {
  socketOpts.transports = ["polling"];
  socketOpts.upgrade = false;
} else {
  socketOpts.transports = ["websocket"];
  socketOpts.upgrade = true;
}

const evoSocket = evoIo(connectUrl, socketOpts);

evoSocket.on("connect", () =>
  console.log("✅ Evolution connected:", evoSocket.id)
);
evoSocket.on("disconnect", (r) => console.log("Evolution disconnected:", r));
evoSocket.on("connect_error", (e) =>
  console.error("Evolution connect_error:", e?.message || e)
);

/** =========================
 *  C) Forward to Laravel + Emit to Front
 ========================= */
const BACKEND_URL = process.env.BACKEND_URL || "";
const FORWARDER_API_KEY =
  process.env.BACKEND_API_KEY || process.env.EVOLUTION_API_KEY || "";
const FORWARDER_WEBHOOK_SECRET =
  process.env.BACKEND_WEBHOOK_SECRET ||
  process.env.EVOLUTION_WEBHOOK_SECRET ||
  "";

const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 7000);
const FORWARD_RETRIES = Number(process.env.FORWARD_RETRIES || 3);

const FORWARD_EVENTS = (process.env.FORWARD_EVENTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function pickInstance(payload) {
  return (
    (payload &&
      (payload.instance || payload.instanceName || payload.data?.instance)) ||
    "unknown"
  );
}

function formatEvent(eventName, payload) {
  return {
    version: "1.0",
    event: eventName,
    receivedAt: new Date().toISOString(),
    instance: pickInstance(payload),
    body: payload,
  };
}

function mask(val) {
  if (!val || typeof val !== "string") return "missing";
  if (val.length <= 6) return "***";
  return `${val.slice(0, 3)}...${val.slice(-3)}`;
}

async function sendToBackend(formatted) {
  if (!BACKEND_URL) return;

  const headers = { "Content-Type": "application/json" };
  if (FORWARDER_WEBHOOK_SECRET)
    headers["x-webhook-secret"] = FORWARDER_WEBHOOK_SECRET;
  if (FORWARDER_API_KEY) headers["x-evolution-api-key"] = FORWARDER_API_KEY;
  // Add a request id for traceability through proxies
  headers["x-request-id"] = crypto.randomUUID();

  // Masked debug log (safe in production)
  try {
    console.log("Forwarding ->", BACKEND_URL, "hdr:", {
      "x-webhook-secret": mask(FORWARDER_WEBHOOK_SECRET),
      "x-evolution-api-key": mask(FORWARDER_API_KEY),
      "x-request-id": headers["x-request-id"],
    });
  } catch {}

  let attempt = 0;
  while (attempt < FORWARD_RETRIES) {
    try {
      await axios.post(BACKEND_URL, formatted, {
        headers,
        timeout: FORWARD_TIMEOUT_MS,
        validateStatus: (s) => s >= 200 && s < 500, // don’t retry on 4xx
      });
      return;
    } catch (e) {
      attempt++;
      const msg = e?.response ? `HTTP ${e.response.status}` : e?.message || String(e);
      console.warn(`Forward attempt ${attempt} failed:`, msg);
      if (attempt >= FORWARD_RETRIES) {
        console.error("Giving up forwarding event after max attempts");
        return;
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

function emitToFront(formatted) {
  ioFront.to(`inst:${formatted.instance}`).emit("evolution:event", formatted);
}

async function handleEvent(evtName, payload) {
  const formatted = formatEvent(evtName, payload);
  console.log("Event:", evtName, "instance=", formatted.instance);

  try {
    await sendToBackend(formatted);
  } catch (e) {
    console.error("Forward failed:", e?.message || e);
  }

  emitToFront(formatted);
}

if (FORWARD_EVENTS.length > 0) {
  console.log("Subscribing:", FORWARD_EVENTS.join(", "));
  FORWARD_EVENTS.forEach((evt) => {
    evoSocket.on(evt, (data) => handleEvent(evt, data));
  });
} else {
  console.log("No FORWARD_EVENTS — listening onAny");
  evoSocket.onAny((evt, ...args) => {
    const payload = args.length === 1 ? args[0] : args;
    handleEvent(evt, payload);
  });

  /** =========================
   *  D) Graceful Shutdown
   ========================= */
  function shutdown(sig) {
    console.log(`Received ${sig}, shutting down gracefully...`);
    try { evoSocket.disconnect(); } catch {}
    try { ioFront.disconnectSockets(true); ioFront.close(); } catch {}
    server.close(() => {
      console.log("HTTP server closed.");
      process.exit(0);
    });
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
