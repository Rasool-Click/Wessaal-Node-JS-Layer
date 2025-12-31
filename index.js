require('dotenv').config();
const { io } = require('socket.io-client');

/*
  Contract:
  - Inputs (env): EVOLUTION_API_URL, INSTANCE_NAME (if not global), WEBSOCKET_ENABLED, WEBSOCKET_GLOBAL_EVENTS, EVENTS (comma list)
  - Outputs: logs of socket connection and incoming events
  - Errors: will exit if WEBSOCKET_ENABLED != 'true' or EVOLUTION_API_URL missing
*/

const WEBSOCKET_ENABLED = (process.env.WEBSOCKET_ENABLED || '').toLowerCase() === 'true';
const WEBSOCKET_GLOBAL_EVENTS = (process.env.WEBSOCKET_GLOBAL_EVENTS || '').toLowerCase() === 'true';
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL; // e.g. https://api.yoursite.com or wss://...
const INSTANCE_NAME = process.env.INSTANCE_NAME || '';
const EVENTS = (process.env.EVENTS || '').split(',').map(s => s.trim()).filter(Boolean); // optional list of events

if (!WEBSOCKET_ENABLED) {
  console.log('WEBSOCKET_ENABLED is not true. Exiting. Set WEBSOCKET_ENABLED=true to enable WebSocket listening.');
  process.exit(0);
}

if (!EVOLUTION_API_URL) {
  console.error('EVOLUTION_API_URL is not set. Please set it in the environment or .env file.');
  process.exit(1);
}

let connectUrl = EVOLUTION_API_URL;
if (!WEBSOCKET_GLOBAL_EVENTS) {
  // traditional mode requires instance name
  if (!INSTANCE_NAME) {
    console.error('WEBSOCKET_GLOBAL_EVENTS is false (traditional mode). INSTANCE_NAME must be provided.');
    process.exit(1);
  }
  // append instance name to the path (ensure no duplicate slashes)
  try {
    const urlObj = new URL(EVOLUTION_API_URL);
    // preserve origin and append pathname
    let basePath = urlObj.pathname === '/' ? '' : urlObj.pathname.replace(/\/$/, '');
    urlObj.pathname = `${basePath}/${INSTANCE_NAME}`;
    connectUrl = urlObj.toString();
  } catch (err) {
    // EVOLUTION_API_URL might be a bare wss://host without trailing slash; just concat safely
    connectUrl = `${EVOLUTION_API_URL.replace(/\/$/, '')}/${INSTANCE_NAME}`;
  }
}

console.log('Connecting to Evolution API WebSocket at', connectUrl);

// Allow polling fallback by default to handle servers that block websocket upgrades.
// To avoid noisy websocket upgrade probe errors, when ALLOW_POLLING=true we use
// polling-only (no upgrade) by default. Set ALLOW_POLLING=false to force websocket-only.
const ALLOW_POLLING = (process.env.ALLOW_POLLING || 'true').toString().toLowerCase() === 'true';

const socketOpts = {
  reconnectionAttempts: 5,
  reconnectionDelay: 2000,
};

if (ALLOW_POLLING) {
  // Use polling-only and disable upgrade probe to avoid websocket upgrade errors
  socketOpts.transports = ['polling'];
  socketOpts.upgrade = false;
} else {
  socketOpts.transports = ['websocket'];
  socketOpts.upgrade = true;
}

const socket = io(connectUrl, socketOpts);

socket.on('connect', () => {
  console.log('Connected. socket id =', socket.id);
});

socket.on('disconnect', (reason) => {
  console.log('Disconnected from server. Reason:', reason);
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err && err.message ? err.message : err);
  try {
    if (err && err.data) console.error('connect_error.data =', err.data);
    // If ws transport produced an http response (e.g. 400) the underlying
    // error object may contain more details; print them for debugging.
    console.error('connect_error (full):');
    console.dir(err, { depth: null });
  } catch (e) {
    console.error('Error logging connect_error details:', e);
  }
});

// If EVENTS env provided, listen only to those; otherwise, log everything with onAny
if (EVENTS.length > 0) {
  console.log('Subscribing to events:', EVENTS.join(', '));
  EVENTS.forEach(evt => {
    socket.on(evt, (data) => {
      console.log('Event:', evt, JSON.stringify(data));
    });
  });
} else {
  console.log('No EVENTS env provided — logging all events via socket.onAny');
  socket.onAny((event, ...args) => {
    try {
      const payload = args.length === 1 ? args[0] : args;
      console.log(`Event received: ${event} ->`, JSON.stringify(payload));
    } catch (e) {
      console.log('Event received:', event, args);
    }
  });
}

// graceful shutdown
function shutdown() {
  console.log('Shutting down: disconnecting socket...');
  if (socket && socket.connected) socket.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// keep process alive
setInterval(() => {}, 1 << 30);
