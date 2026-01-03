const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

// 1. Add Express CORS (for the initial polling request)
const cors = require("cors");
app.use(cors({
  origin: ["http://localhost:3000", "https://rasool-dev.netlify.app"],
  methods: ["GET", "POST"],
  credentials: true
}));

const server = http.createServer(app);

// 2. Add Socket.io CORS
const ioFront = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "https://rasool-dev.netlify.app"],
    methods: ["GET", "POST"],
    credentials: true
  },
  allowEIO3: true // Helps with version compatibility
});

// Basic Health Check to stop "Cannot GET /"
app.get("/", (req, res) => {
  res.send("✅ Wessaal WebSocket Server is running.");
});

ioFront.on("connection", (socket) => {
  socket.on("subscribe", ({ instance }) => {
    if (!instance) return;
    socket.join(`inst:${instance}`);
    console.log("Front subscribed to", `inst:${instance}`);
  });
});

server.listen(process.env.FRONT_WS_PORT || 3000, () => {
  console.log("✅ Front WS listening on port", process.env.FRONT_WS_PORT || 3000);
});

module.exports = { emitToInstance: (formatted) => {
  const inst = formatted.instance || "unknown";
  ioFront.to(`inst:${inst}`).emit("evolution:event", formatted);
}};