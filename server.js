"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { acceptUpgrade } = require("./websocket");
const { createRoomEngine } = require("./public/js/room-engine.js");

const DEFAULT_PORT = 5007;
const DEFAULT_HOST = "0.0.0.0";
const PUBLIC_ROOT = path.join(__dirname, "public");
const peers = new Set();
const engine = createRoomEngine();
const { rooms, normalizeRoomCode, sanitizeNickname } = engine;
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function localNetworks(port) {
  const networks = [];
  const virtualPattern = /virtual|vmware|vbox|hyper-v|wsl|tailscale|loopback|bluetooth|docker|vethernet/i;
  const preferredPattern = /wi-?fi|wireless|wlan|ethernet|이더넷|무선/i;
  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    for (const address of interfaces || []) {
      if (address.family !== "IPv4" || address.internal || address.address.startsWith("169.254.")) continue;
      networks.push({ name, address: address.address, url: "http://" + address.address + ":" + port, priority: virtualPattern.test(name) ? 2 : preferredPattern.test(name) ? 0 : 1 });
    }
  }
  networks.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  return networks.filter((network, index, list) => list.findIndex((item) => item.url === network.url) === index).map(({ name, address, url }) => ({ name, address, url }));
}
function localAddresses(port) {
  return localNetworks(port).map((network) => network.url);
}
function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:");
}
function requestHandler(request, response, port) {
  securityHeaders(response); const requestUrl = new URL(request.url, "http://localhost");
  if (requestUrl.pathname === "/api/info") { const networks = localNetworks(port); response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); return response.end(JSON.stringify({ port, lanUrls: networks.map((network) => network.url), networks })); }
  if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { Allow: "GET, HEAD" }); return response.end(); }
  let pathname;
  try { pathname = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname); } catch { response.writeHead(400); return response.end("Bad request"); }
  const filePath = path.resolve(PUBLIC_ROOT, "." + pathname);
  if (!filePath.startsWith(PUBLIC_ROOT + path.sep) || !MIME[path.extname(filePath)]) { response.writeHead(404); return response.end("Not found"); }
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) { response.writeHead(404); return response.end("Not found"); }
    response.writeHead(200, { "Content-Type": MIME[path.extname(filePath)], "Content-Length": stats.size, "Cache-Control": "no-cache" });
    if (request.method === "HEAD") return response.end(); fs.createReadStream(filePath).pipe(response);
  });
}
function createServer(options = {}) {
  const requestedPort = Object.prototype.hasOwnProperty.call(options, "port") ? options.port : (process.env.PORT || DEFAULT_PORT);
  const port = Number(requestedPort); const host = options.host || process.env.HOST || DEFAULT_HOST;
  const server = http.createServer((request, response) => requestHandler(request, response, server.address()?.port || port));
  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url, "http://localhost");
    if (requestUrl.pathname !== "/ws") return socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    const peer = acceptUpgrade(request, socket, head); if (!peer) return;
    peers.add(peer); peer.on("message", (message) => engine.handleMessage(peer, message)); peer.on("close", () => { peers.delete(peer); engine.detachPeer(peer); }); peer.sendJSON({ type: "connected" });
  });
  const stopTimers = engine.startTimers();
  const heartbeat = setInterval(() => {
    for (const peer of peers) { if (!peer.alive) peer.close(4000, "Heartbeat timeout"); else peer.ping(); }
  }, 30000);
  heartbeat.unref(); server.on("close", () => { clearInterval(heartbeat); stopTimers(); });
  return { server, port, host, listen(callback) { return server.listen(port, host, callback); }, close(callback) { for (const peer of peers) peer.close(1001, "Server shutdown"); return server.close(callback); } };
}
if (require.main === module) {
  const app = createServer(); app.listen(() => {
    const activePort = app.server.address().port; console.log("TS 게임센터: http://localhost:" + activePort);
    const urls = localAddresses(activePort); if (urls.length) console.log("휴대폰 접속: " + urls.join(" 또는 "));
  });
}
module.exports = { createServer, rooms, normalizeRoomCode, sanitizeNickname };
