require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { io: evoIo } = require("socket.io-client");
const axios = require("axios");

/** =========================
 *  A) Front Socket Server
 ========================= */
const FRONT_WS_PORT = Number(process.env.FRONT_WS_PORT || 4000);
const FRONT_ORIGIN = (process.env.FRONT_ORIGIN || "*").split(",");

const app = express();
app.get("/health", (_, res) => res.send("ok"));

const server = http.createServer(app);

const ioFront = new Server(server, {
  cors: { origin: FRONT_ORIGIN, credentials: true },
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
  console.log("✅ Front WS listening on", FRONT_WS_PORT);
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

const socketOpts = { reconnectionAttempts: 5, reconnectionDelay: 2000 };
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

async function sendToBackend(formatted) {
  if (!BACKEND_URL) return;

  const headers = { "Content-Type": "application/json" };
  if (FORWARDER_WEBHOOK_SECRET)
    headers["x-webhook-secret"] = FORWARDER_WEBHOOK_SECRET;
  if (FORWARDER_API_KEY) headers["x-evolution-api-key"] = FORWARDER_API_KEY;

  await axios.post(BACKEND_URL, formatted, { headers, timeout: 5000 });
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
}
