// fakeHost.fixture.mjs -- a stand-in for the real robot-console host,
// used by supervisor.test.ts and by the manual real-browser check of the
// supervisor. The real host opens USB/serial ports and must never be
// started by tests (or next to a developer's running `npm run dev`).
//
// It speaks just enough of the host's WebSocket contract
// (packages/host/src/wsMessages.ts) for the production UI to render: a
// `snapshot` with no devices on every connect. Any non-JSON text frame is
// echoed back, which is what the supervisor tests use to prove a proxied
// socket carries data both ways.
//
// Env knobs (all optional):
//   ROBOT_CONSOLE_PORT          port to listen on (the supervisor sets it)
//   FAKE_HOST_NO_LISTEN=1       never listen (start-timeout tests)
//   FAKE_HOST_LISTEN_DELAY_MS   wait before listening
//   FAKE_HOST_IGNORE_SIGTERM=1  ignore SIGTERM (kill-timeout tests)
import http from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.env.ROBOT_CONSOLE_PORT);
const log = (line) => console.log(`fake-host[${process.pid}]: ${line}`);

if (process.env.FAKE_HOST_NO_LISTEN) {
  log("not listening (FAKE_HOST_NO_LISTEN)");
  setInterval(() => undefined, 1000);
  if (process.env.FAKE_HOST_IGNORE_SIGTERM) {
    process.on("SIGTERM", () => log("ignoring SIGTERM"));
  }
} else {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("fake host\n");
  });
  const wss = new WebSocketServer({ server });
  let seq = 0;
  wss.on("connection", (socket) => {
    log("client connected");
    socket.send(
      JSON.stringify({
        type: "snapshot",
        seq: ++seq,
        at: Date.now(),
        devices: [],
        unassigned: [],
        relays: [],
        firmware: { relay: { configured: false }, robot: { configured: false } },
        wifi: { ssid: null, source: null },
        tasks: [],
      }),
    );
    socket.on("message", (data, isBinary) => {
      const text = isBinary ? null : data.toString();
      if (text !== null && !text.trimStart().startsWith("{")) {
        socket.send(`echo:${process.pid}:${text}`);
      }
    });
    socket.on("close", () => log("client disconnected"));
  });

  const listen = () => server.listen(port, "127.0.0.1", () => log(`listening on 127.0.0.1:${port}`));
  const delay = Number(process.env.FAKE_HOST_LISTEN_DELAY_MS ?? 0);
  if (delay > 0) {
    setTimeout(listen, delay);
  } else {
    listen();
  }

  const shutdown = (signal) => {
    if (process.env.FAKE_HOST_IGNORE_SIGTERM) {
      log(`ignoring ${signal}`);
      return;
    }
    log(`received ${signal}, shutting down`);
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
