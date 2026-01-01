require("dotenv").config();
const { io } = require("socket.io-client");
const { emitToInstance } = require("./server");

/*
  Contract:
  - Inputs (env): EVOLUTION_API_URL, INSTANCE_NAME (if not global), WEBSOCKET_ENABLED, WEBSOCKET_GLOBAL_EVENTS, EVENTS (comma list)
  - Outputs: logs of socket connection and incoming events
  - Errors: will exit if WEBSOCKET_ENABLED != 'true' or EVOLUTION_API_URL missing
*/

const WEBSOCKET_ENABLED =
  (process.env.WEBSOCKET_ENABLED || "").toLowerCase() === "true";
const WEBSOCKET_GLOBAL_EVENTS =
  (process.env.WEBSOCKET_GLOBAL_EVENTS || "").toLowerCase() === "true";
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL; // e.g. https://api.yoursite.com or wss://...
const INSTANCE_NAME = process.env.INSTANCE_NAME || "";
const EVENTS = (process.env.EVENTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean); // optional list of events

if (!WEBSOCKET_ENABLED) {
  console.log(
    "WEBSOCKET_ENABLED is not true. Exiting. Set WEBSOCKET_ENABLED=true to enable WebSocket listening."
  );
  process.exit(0);
}

if (!EVOLUTION_API_URL) {
  console.error(
    "EVOLUTION_API_URL is not set. Please set it in the environment or .env file."
  );
  process.exit(1);
}

let connectUrl = EVOLUTION_API_URL;
if (!WEBSOCKET_GLOBAL_EVENTS) {
  // traditional mode requires instance name
  if (!INSTANCE_NAME) {
    console.error(
      "WEBSOCKET_GLOBAL_EVENTS is false (traditional mode). INSTANCE_NAME must be provided."
    );
    process.exit(1);
  }
  // append instance name to the path (ensure no duplicate slashes)
  try {
    const urlObj = new URL(EVOLUTION_API_URL);
    // preserve origin and append pathname
    let basePath =
      urlObj.pathname === "/" ? "" : urlObj.pathname.replace(/\/$/, "");
    urlObj.pathname = `${basePath}/${INSTANCE_NAME}`;
    connectUrl = urlObj.toString();
  } catch (err) {
    // EVOLUTION_API_URL might be a bare wss://host without trailing slash; just concat safely
    connectUrl = `${EVOLUTION_API_URL.replace(/\/$/, "")}/${INSTANCE_NAME}`;
  }
}

console.log("Connecting to Evolution API WebSocket at", connectUrl);

// Allow polling fallback by default to handle servers that block websocket upgrades.
// To avoid noisy websocket upgrade probe errors, when ALLOW_POLLING=true we use
// polling-only (no upgrade) by default. Set ALLOW_POLLING=false to force websocket-only.
const ALLOW_POLLING =
  (process.env.ALLOW_POLLING || "true").toString().toLowerCase() === "true";

const socketOpts = {
  reconnectionAttempts: 5,
  reconnectionDelay: 2000,
};

if (ALLOW_POLLING) {
  // Use polling-only and disable upgrade probe to avoid websocket upgrade errors
  socketOpts.transports = ["polling"];
  socketOpts.upgrade = false;
} else {
  socketOpts.transports = ["websocket"];
  socketOpts.upgrade = true;
}

const socket = io(connectUrl, socketOpts);

socket.on("connect", () => {
  console.log("Connected. socket id =", socket.id);
});

socket.on("disconnect", (reason) => {
  console.log("Disconnected from server. Reason:", reason);
});

socket.on("connect_error", (err) => {
  console.error("Connection error:", err && err.message ? err.message : err);
  try {
    if (err && err.data) console.error("connect_error.data =", err.data);
    // If ws transport produced an http response (e.g. 400) the underlying
    // error object may contain more details; print them for debugging.
    console.error("connect_error (full):");
    console.dir(err, { depth: null });
  } catch (e) {
    console.error("Error logging connect_error details:", e);
  }
});

// Forwarding setup
const axios = require("axios");
const BACKEND_URL = process.env.BACKEND_URL || "";
const BACKEND_API_KEY = process.env.BACKEND_API_KEY || "";
// Read auth values from env. Support either BACKEND_* names or the Laravel-style
// EVOLUTION_* names so you can reuse the same .env values.
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
    (payload &&
      (payload.instance || payload.instanceName || payload.data?.instance)) ||
    "unknown"
  );
}

function formatEvent(eventName, payload) {
  // Official normalized envelope v1
  // { version, event, id?, type?, instance, receivedAt, actor?, body, meta, raw }
  const MAX_RAW = RAW_MAX; // controlled by env; default 512 bytes

  function safeStringify(obj, maxLen = MAX_RAW) {
    try {
      const s = JSON.stringify(obj);
      return s.length > maxLen ? s.slice(0, maxLen) + "...<truncated>" : s;
    } catch (e) {
      try {
        return String(obj).slice(0, maxLen);
      } catch (e2) {
        return "<unserializable>";
      }
    }
  }

  function extractMessage(m) {
    // m may be a message object from Evolution events — extract common fields
    if (!m) return null;
    const id = m.id || m._id || m.messageId || null;
    const from = m.from || m.author || m.sender || null;
    const to = m.to || m.recipients || null;
    const text =
      m.text ||
      m.body ||
      (m.content && (m.content.text || m.content.body)) ||
      null;
    const ts = m.timestamp || m.ts || m.createdAt || null;
    const attachments = Array.isArray(m.attachments)
      ? m.attachments.map((a) => ({ type: a.type, url: a.url, name: a.name }))
      : m.attachments
      ? ["<unknown-attachments>"]
      : [];
    return {
      id,
      from,
      to,
      text,
      ts,
      attachmentsCount: attachments.length,
      attachments,
    };
  }

  function extractContact(c) {
    if (!c) return null;
    return {
      id: c.id || c._id || c.contactId || null,
      name: c.name || c.fullName || c.displayName || null,
      phones: [].concat(c.phone || c.phones || []).filter(Boolean),
      emails: [].concat(c.email || c.emails || []).filter(Boolean),
    };
  }

  // Minimal envelope (only include necessary fields)
  const envelope = {
    version: "1.0",
    event: eventName,
    receivedAt: new Date().toISOString(),
    instance: pickInstance(payload),
    // id/type/actor may be set per-event below
    id: null,
    type: null,
    actor: null,
    // body should contain only the minimal useful data per event
    body: null,
    // small meta with only essential routing info
    meta: {},
  };

  try {
    // Event-specific normalization
    switch (eventName) {
      case "messages.upsert": {
        // payload may be { message: {...} } or the message itself
        const msg = payload?.message || payload;
        const m = extractMessage(msg);
        envelope.id = m?.id || null;
        envelope.type = "message";
        envelope.actor = m?.from || null;
        // Minimal message body: id, from, text snippet, timestamp, attachmentsCount
        envelope.id = m?.id || null;
        envelope.type = "message";
        envelope.actor = m?.from || null;
        envelope.body = {
          id: m?.id || null,
          from: m?.from || null,
          snippet: (m?.text && String(m.text).slice(0, 256)) || null,
          timestamp: m?.ts || null,
          attachmentsCount: m?.attachmentsCount || 0,
        };
        if (INCLUDE_RAW) envelope.raw = safeStringify(payload);
        break;
      }
      case "contacts.update": {
        const contact = payload?.contact || payload;
        const c = extractContact(contact);
        envelope.id = c?.id || null;
        envelope.type = "contact";
        // Minimal contact: id, name, up to 3 phones, up to 2 emails
        envelope.body = {
          id: c?.id || null,
          name: c?.name || null,
          phones: (c?.phones || []).slice(0, 3),
          emails: (c?.emails || []).slice(0, 2),
        };
        if (INCLUDE_RAW) envelope.raw = safeStringify(payload);
        break;
      }
      case "chats.update": {
        const chat = payload?.chat || payload;
        envelope.id = chat?.id || chat?._id || null;
        envelope.type = "chat";
        envelope.body = {
          id: envelope.id,
          title: chat?.title || chat?.name || null,
          participantsCount: Array.isArray(chat?.participants)
            ? chat.participants.length
            : null,
        };
        if (INCLUDE_RAW) envelope.raw = safeStringify(payload);
        break;
      }
      default: {
        // Generic attempt to pick useful fields
        envelope.type =
          typeof payload === "object" && payload !== null
            ? payload.type || payload.eventType || "generic"
            : typeof payload;
        // For generic events keep only top-level keys that are small and useful
        envelope.body = (function genericBody(p) {
          if (!p) return null;
          const small = {};
          const keys = Object.keys(p).slice(0, 6); // pick up to 6 keys
          keys.forEach((k) => {
            try {
              const v = p[k];
              // skip large arrays/objects
              if (typeof v === "string" && v.length > 512)
                small[k] = String(v).slice(0, 128) + "...";
              else if (Array.isArray(v)) small[k] = v.slice(0, 3);
              else if (typeof v === "object" && v !== null)
                small[k] = "<object>";
              else small[k] = v;
            } catch (e) {
              small[k] = "<unserializable>";
            }
          });
          return small;
        })(payload);
        if (INCLUDE_RAW) envelope.raw = safeStringify(payload);
      }
      case "qrcode.updated": {
        // For QR code events we send the full event payload (no shrinking).
        // This preserves all properties the Evolution service provides for QR codes.
        envelope.type = "qrcode";
        try {
          envelope.body = payload;
        } catch (e) {
          envelope.body = null;
          envelope.meta.normalizationError = String(e);
        }
        // Include an untruncated raw payload so the receiver can inspect everything.
        try {
          envelope.raw = JSON.stringify(payload);
        } catch (e) {
          envelope.raw = safeStringify(payload, MAX_RAW);
        }
        break;
      }
      case "connection.update": {
        // For connection.update events we also want the full payload (no shrinking).
        envelope.type = "connection";
        try {
          envelope.body = payload;
        } catch (e) {
          envelope.body = null;
          envelope.meta.normalizationError = String(e);
        }
        try {
          envelope.raw = JSON.stringify(payload);
        } catch (e) {
          envelope.raw = safeStringify(payload, MAX_RAW);
        }
        break;
      }
    }
  } catch (e) {
    // If normalization fails, fallback to minimal envelope
    envelope.body = null;
    envelope.meta.error = "normalization_failed";
    envelope.meta.normalizationError = String(e);
  }

  return envelope;
}

async function sendToBackend(formatted) {
  if (!BACKEND_URL) {
    console.warn("BACKEND_URL not configured — skipping forward");
    return;
  }

  const headers = { "Content-Type": "application/json" };
  // Build the two headers requested: x-webhook-secret and x-evolution-api-key.
  // Only include them when present in the environment.
  if (FORWARDER_WEBHOOK_SECRET)
    headers["x-webhook-secret"] = FORWARDER_WEBHOOK_SECRET;
  if (FORWARDER_API_KEY) headers["x-evolution-api-key"] = FORWARDER_API_KEY;

  const maxTries = 2;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      await axios.post(BACKEND_URL, formatted, { headers, timeout: 5000 });

      return;
    } catch (err) {
      if (attempt < maxTries)
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      else console.error("Giving up forwarding event after max attempts");
    }
  }
}

// If FORWARD_EVENTS set, subscribe only to those; otherwise, forward all via onAny
if (FORWARD_EVENTS.length > 0) {
  console.log("Subscribing and forwarding events:", FORWARD_EVENTS.join(", "));
  FORWARD_EVENTS.forEach((evt) => {
    socket.on(evt, async (data) => {
      try {
        const formatted = formatEvent(evt, data);
        console.log("Event:", evt, formatted.instance);
        await sendToBackend(formatted);
        emitToInstance(formatted);
      } catch (e) {
        console.error("Error handling event", evt, e);
      }
    });
  });
} else {
  console.log(
    "No FORWARD_EVENTS env provided — handling all events via socket.onAny"
  );
  socket.onAny(async (event, ...args) => {
    try {
      const payload = args.length === 1 ? args[0] : args;
      const formatted = formatEvent(event, payload);
      console.log(`Event received: ${event} -> instance=${formatted.instance}`);
      await sendToBackend(formatted);
      emitToInstance(formatted);
    } catch (e) {
      console.error("Error processing event", event, e);
    }
  });
}

// graceful shutdown
function shutdown() {
  console.log("Shutting down: disconnecting socket...");
  if (socket && socket.connected) socket.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// keep process alive
setInterval(() => {}, 1 << 30);
