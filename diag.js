require('dotenv').config();
const { io } = require('socket.io-client');

// Usage: set env or pass args. Examples:
// URL=https://eva.hero.delivery node diag.js
// URL=wss://eva.hero.delivery INSTANCE_NAME=my_inst TOKEN=abc node diag.js

const URL = process.env.URL || process.env.EVOLUTION_API_URL || 'https://eva.hero.delivery';
const INSTANCE = process.env.INSTANCE_NAME || process.env.INSTANCE || '';
const GLOBAL = (process.env.WEBSOCKET_GLOBAL_EVENTS || process.env.GLOBAL || '').toString().toLowerCase() === 'true';
const TOKEN = process.env.TOKEN || process.env.AUTH_TOKEN || '';
const ALLOW_POLLING = (process.env.ALLOW_POLLING || '').toString().toLowerCase() === 'true';

function buildUrl() {
  let base = URL.trim();
  if (!GLOBAL && INSTANCE) {
    if (base.endsWith('/')) base = base.slice(0, -1);
    return base + '/' + encodeURIComponent(INSTANCE);
  }
  return base;
}

async function run() {
  const connectUrl = buildUrl();
  console.log('Diagnostic run — connectUrl =', connectUrl);
  console.log('Options:', { TOKEN: !!TOKEN, GLOBAL, ALLOW_POLLING });

  const opts = {
    transports: ALLOW_POLLING ? ['polling', 'websocket'] : ['websocket'],
    reconnection: false,
    timeout: 10000,
  };
  if (TOKEN) opts.auth = { token: TOKEN };

  console.log('Attempting socket.io connection with options:', opts);

  const socket = io(connectUrl, opts);

  socket.on('connect', () => {
    console.log('Connected. id=', socket.id);
    socket.close();
    process.exit(0);
  });

  socket.on('connect_error', (err) => {
    console.error('connect_error received — full object:');
    console.dir(err, { depth: null });
    // err may include err.message and err.data
    try {
      console.error('message:', err && err.message);
      console.error('data:', err && err.data);
    } catch (e) {
      console.error('Error printing err fields:', e);
    }
    socket.close();
    process.exit(2);
  });

  socket.on('error', (err) => {
    console.error('error event:', err);
  });

  socket.on('disconnect', (reason) => {
    console.log('disconnect:', reason);
  });

  // Safety: timeout
  setTimeout(() => {
    console.error('Diagnostic timeout reached without connect or explicit error.');
    try { socket.close(); } catch (e) {}
    process.exit(3);
  }, 15000);
}

run().catch(err => {
  console.error('Unexpected diag error:', err);
  process.exit(4);
});
