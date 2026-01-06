require("dotenv").config();
const { io } = require("socket.io-client");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");

/**
 * DEEP LOGGING TRACKER
 * Helps you see exactly where the chain breaks: Evolution -> Node -> Browser
 */
const track = (stage, status, detail = "") => {
  const time = new Date().toLocaleTimeString();
  const icon = status === "ERROR" ? "❌" : status === "SUCCESS" ? "✅" : "ℹ️";
  console.log(
    `[${time}] ${icon} [${stage.padEnd(10)}] ${status.padEnd(8)} | ${detail}`
  );
};

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

// Front Socket Server Config
const FRONT_WS_PORT = Number(
  process.env.PORT || process.env.FRONT_WS_PORT || 4000
);
const FRONT_ORIGIN = (process.env.FRONT_ORIGIN || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const FRONT_WS_PATH = process.env.FRONT_WS_PATH || "/ws";
const TRUST_PROXY =
  (process.env.TRUST_PROXY || "true").toLowerCase() === "true";

const app = express();
if (TRUST_PROXY) app.set("trust proxy", 1);
app.get("/health", (_, res) => res.send("ok"));
app.get("/ready", (_, res) => res.send("ready"));

const server = http.createServer(app);
const ioFront = new Server(server, {
  path: FRONT_WS_PATH,
  cors: { origin: FRONT_ORIGIN, credentials: true, methods: ["GET", "POST"] },
  perMessageDeflate: false,
});

// --- STAGE 1: BROWSER CONNECTIONS ---
ioFront.on("connection", (socket) => {
  track("FRONT_WS", "CONNECT", `Browser linked: ${socket.id}`);

  socket.on("join_instance", ({ instance }, cb) => {
    try {
      if (!instance) {
        track(
          "FRONT_WS",
          "ERROR",
          `Join attempt failed: No instance name provided.`
        );
        return cb?.({ ok: false, error: "missing_instance" });
      }
      const room = `inst:${instance}`;
      socket.join(room);
      track("FRONT_WS", "SUCCESS", `Browser ${socket.id} joined room: ${room}`);
      return cb?.({ ok: true, room });
    } catch (e) {
      track("FRONT_WS", "ERROR", `Room join error: ${e.message}`);
      return cb?.({ ok: false, error: String(e) });
    }
  });

  socket.on("disconnect", (reason) => {
    track(
      "FRONT_WS",
      "INFO",
      `Browser ${socket.id} disconnected. Reason: ${reason}`
    );
  });
});

server.listen(FRONT_WS_PORT, () => {
  console.log(`\n🚀 WESSAAL NODE LAYER STARTED`);
  console.log(`📡 Listening on: ${FRONT_WS_PORT} | Path: ${FRONT_WS_PATH}`);
  console.log(`🌍 Origins: ${FRONT_ORIGIN.join(", ")}\n`);
});

function emitToInstance(formatted) {
  const inst = formatted.instance || "unknown";
  const room = `inst:${inst}`;

  // Check if anyone is actually listening in this room
  const activeListeners = ioFront.sockets.adapter.rooms.get(room)?.size || 0;

  if (activeListeners > 0) {
    track(
      "FLOW",
      "FORWARD",
      `Sending to ${activeListeners} client(s) in room: ${room}`
    );
    ioFront.to(room).emit("evolution:event", formatted);
  } else {
    track(
      "FLOW",
      "DROP",
      `No browser is listening in room: ${room}. Event discarded.`
    );
  }
}

// --- STAGE 2: EVOLUTION API CONNECTION ---
if (!WEBSOCKET_ENABLED) {
  track("SYS", "INFO", "WEBSOCKET_ENABLED is false. Exiting.");
  process.exit(0);
}

if (!EVOLUTION_API_URL) {
  track("SYS", "ERROR", "EVOLUTION_API_URL is missing. Exiting.");
  process.exit(1);
}

let connectUrl = EVOLUTION_API_URL;
if (!WEBSOCKET_GLOBAL_EVENTS) {
  if (!INSTANCE_NAME) {
    track("SYS", "ERROR", "Traditional mode requires INSTANCE_NAME.");
    process.exit(1);
  }
  try {
    const urlObj = new URL(EVOLUTION_API_URL);
    let basePath =
      urlObj.pathname === "/" ? "" : urlObj.pathname.replace(/\/$/, "");
    urlObj.pathname = `${basePath}/${INSTANCE_NAME}`;
    connectUrl = urlObj.toString();
  } catch (err) {
    connectUrl = `${EVOLUTION_API_URL.replace(/\/$/, "")}/${INSTANCE_NAME}`;
  }
}

track("EVO_API", "INFO", `Connecting to Evolution: ${connectUrl}`);

const ALLOW_POLLING =
  (process.env.ALLOW_POLLING || "true").toString().toLowerCase() === "true";

const socketOpts = {
  reconnectionAttempts: 10,
  reconnectionDelay: 2000,
};

if (ALLOW_POLLING) {
  socketOpts.transports = ["polling"];
  socketOpts.upgrade = false;
} else {
  socketOpts.transports = ["websocket"];
  socketOpts.upgrade = true;
}

const socket = io(connectUrl, socketOpts);

socket.on("connect", () => {
  track("EVO_API", "SUCCESS", `Connected to Evolution API! ID: ${socket.id}`);
});

socket.on("disconnect", (reason) => {
  track("EVO_API", "INFO", `Disconnected from Evolution. Reason: ${reason}`);
});

socket.on("connect_error", (err) => {
  track("EVO_API", "ERROR", `Connection failed: ${err.message}`);
});

// --- STAGE 3: DATA FORWARDING & FORMATTING ---
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
    } catch (e) {
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
      attachmentsCount: Array.isArray(m.attachments) ? m.attachments.length : 0,
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

async function sendToBackend(formatted) {
  if (!BACKEND_URL) return;
  const headers = { "Content-Type": "application/json" };
  if (FORWARDER_WEBHOOK_SECRET)
    headers["x-webhook-secret"] = FORWARDER_WEBHOOK_SECRET;
  if (FORWARDER_API_KEY) headers["x-evolution-api-key"] = FORWARDER_API_KEY;

  try {
    await axios.post(BACKEND_URL, formatted, { headers, timeout: 5000 });
    track("FORWARD", "SUCCESS", `Sent to Webhook: ${BACKEND_URL}`);
  } catch (err) {
    track("FORWARD", "ERROR", `Webhook failed: ${err.message}`);
  }
}

// Subscribe to events
if (FORWARD_EVENTS.length > 0) {
  FORWARD_EVENTS.forEach((evt) => {
    socket.on(evt, async (data) => {
      const formatted = formatEvent(evt, data);
      track(
        "FLOW",
        "RECEIVE",
        `Event: ${evt} (Instance: ${formatted.instance})`
      );
      await sendToBackend(formatted);
      emitToInstance(formatted);
    });
  });
} else {
  socket.onAny(async (event, ...args) => {
    const payload = args.length === 1 ? args[0] : args;
    const formatted = formatEvent(event, payload);
    track(
      "FLOW",
      "RECEIVE",
      `Event: ${event} (Instance: ${formatted.instance})`
    );
    await sendToBackend(formatted);
    emitToInstance(formatted);
  });
}

function shutdown() {
  track("SYS", "INFO", "Shutting down...");
  if (socket?.connected) socket.disconnect();
  try {
    ioFront?.close();
    server?.close();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {}, 1 << 30);
