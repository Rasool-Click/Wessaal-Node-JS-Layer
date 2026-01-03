const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// فرونت socket server
const app = express();
const server = http.createServer(app);

const ioFront = new Server(server, {
  cors: { origin: (process.env.FRONT_ORIGIN || "*").split(",") },
});

ioFront.on("connection", (socket) => {
  socket.on("subscribe", ({ instance }) => {
    if (!instance) return;
    socket.join(`inst:${instance}`);
    console.log("Front subscribed to", `inst:${instance}`);
  });
});

server.listen(process.env.FRONT_WS_PORT || 4000, () => {
  console.log("✅ Front WS listening on", process.env.FRONT_WS_PORT || 4000);
});

// helper تبعت الحدث لغرفة الانستانس
function emitToInstance(formatted) {
  console.log("emitToInstance", formatted);
  const inst = formatted.instance || "unknown";
  ioFront.to(`inst:${inst}`).emit("evolution:event", formatted);
}

module.exports = { emitToInstance };
