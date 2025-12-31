# Evolution API WebSocket Listener

Small Node.js app that connects to the Evolution API WebSocket (socket.io) and logs incoming events.

## Setup

1. Copy `.env.example` to `.env` and edit values (EVOLUTION_API_URL is required):

   cp .env.example .env

2. Install dependencies:

   npm install

3. Run the app:

   npm start

## Environment variables (see `.env.example`)
- WEBSOCKET_ENABLED: set to `true` to enable WebSocket. Otherwise app exits.
- WEBSOCKET_GLOBAL_EVENTS: `true` for global mode (connect to base URL), `false` for instance/traditional mode (append `INSTANCE_NAME` to URL).
- EVOLUTION_API_URL: base API URL (include protocol, e.g. `wss://api.yoursite.com` or `https://api.yoursite.com`).
- INSTANCE_NAME: required in traditional mode.
- EVENTS: optional comma-separated list of event names to subscribe to. If omitted, the app logs all incoming events.

## Notes
- The app uses `socket.io-client` and connects with the `websocket` transport.
- It logs `connect`, `disconnect`, `connect_error` and all events (or only those listed in `EVENTS`).
- Use `socket.disconnect()` gracefully by stopping the process (SIGINT / SIGTERM handled).

## Example
In `.env` for global mode:

WEBSOCKET_ENABLED=true
WEBSOCKET_GLOBAL_EVENTS=true
EVOLUTION_API_URL=wss://api.yoursite.com

Or traditional:

WEBSOCKET_ENABLED=true
WEBSOCKET_GLOBAL_EVENTS=false
EVOLUTION_API_URL=wss://api.yoursite.com
INSTANCE_NAME=my_instance

Then:

npm install
npm start

