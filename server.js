"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { acceptUpgrade } = require("./websocket");
const { createGame, flipCard, ringBell, publicGame, validateGameState } = require("./game");
const { SKINS, createDinoGame, setDinoAction, advanceDinoGame, publicDinoGame } = require("./dino-game");

const DEFAULT_PORT = 5007;
const DEFAULT_HOST = "0.0.0.0";
const PUBLIC_ROOT = path.join(__dirname, "public");
const ROOM_MAX_AGE = 2 * 60 * 60 * 1000;
const rooms = new Map();
const peers = new Set();
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const AVATARS = ["joystick", "alien", "rocket", "ghost"];

function normalizeRoomCode(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(-4); }
function sanitizeNickname(value) {
  const nickname = String(value || "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 12);
  return nickname || "동네 게이머";
}
function normalizeGameType(value) { return value === "dino" ? "dino" : "bell"; }
function createRoomCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = String(crypto.randomInt(1000, 10000));
    if (!rooms.has(code)) return code;
  }
  throw new Error("방 코드를 만들지 못했습니다.");
}
function createPlayer(nickname, index) {
  return { id: crypto.randomUUID(), token: crypto.randomBytes(18).toString("base64url"), nickname: sanitizeNickname(nickname), avatar: AVATARS[index % AVATARS.length], dinoSkin: SKINS[index % SKINS.length], ready: index === 0, connected: true, peer: null, joinedAt: Date.now() };
}
function serializeRoom(room, playerId) {
  const game = room.gameType === "dino" ? publicDinoGame(room.game) : publicGame(room.game);
  return {
    code: room.code, status: room.status, gameType: room.gameType, hostId: room.hostId, selfId: playerId,
    players: [...room.players.values()].map((player) => ({ id: player.id, nickname: player.nickname, avatar: player.avatar, dinoSkin: player.dinoSkin, ready: player.ready, connected: player.connected, host: player.id === room.hostId })),
    game, serverTime: Date.now(),
  };
}
function sendError(peer, message) { peer.sendJSON({ type: "error", message }); }
function broadcastRoom(room) {
  room.updatedAt = Date.now();
  for (const player of room.players.values()) if (player.connected && player.peer) player.peer.sendJSON({ type: "room-state", room: serializeRoom(room, player.id) });
}
function attachPlayer(peer, room, player) {
  if (player.peer && player.peer !== peer) player.peer.close(4001, "New connection");
  player.connected = true; player.peer = peer; peer.roomCode = room.code; peer.playerId = player.id;
  const gamePlayer = room.game?.players.find((item) => item.id === player.id);
  if (gamePlayer) gamePlayer.connected = true;
  if (room.gameType === "bell" && room.game?.status === "playing") {
    const current = room.game.players.find((item) => item.id === room.game.turnId);
    if (!current?.connected) {
      const next = room.game.players.find((item) => item.connected && item.deck.length > 0);
      room.game.turnId = next?.id || room.game.turnId;
    }
  }
  peer.sendJSON({ type: "welcome", roomCode: room.code, playerId: player.id, token: player.token });
  broadcastRoom(room);
}
function transferHost(room) {
  if (room.players.get(room.hostId)?.connected) return;
  const next = [...room.players.values()].find((player) => player.connected);
  room.hostId = next?.id || room.hostId;
}
function pruneDisconnectedPlayers(room) {
  for (const [id, item] of room.players) if (!item.connected) room.players.delete(id);
  transferHost(room);
}
function detachPeer(peer, removeFromLobby = false) {
  if (!peer.roomCode || !peer.playerId) return;
  const room = rooms.get(peer.roomCode); const player = room?.players.get(peer.playerId);
  if (!room || !player || player.peer !== peer) return;
  player.connected = false; player.peer = null;
  if (room.status === "lobby" || removeFromLobby) room.players.delete(player.id);
  const gamePlayer = room.game?.players.find((item) => item.id === player.id);
  if (gamePlayer) gamePlayer.connected = false;
  if (room.gameType === "bell" && room.game?.status === "playing" && room.game.turnId === player.id) {
    const candidates = room.game.players.filter((item) => item.connected && item.deck.length > 0);
    if (candidates.length) room.game.turnId = candidates[0].id;
  }
  transferHost(room);
  if ([...room.players.values()].some((item) => item.connected)) broadcastRoom(room);
  else if (room.status === "lobby") rooms.delete(room.code);
  peer.roomCode = null; peer.playerId = null;
}
function joinRoom(peer, data, creating = false) {
  if (peer.playerId) return sendError(peer, "이미 방에 참가 중입니다.");
  let room;
  if (creating) {
    const code = createRoomCode();
    room = { code, status: "lobby", gameType: normalizeGameType(data.gameType), hostId: null, players: new Map(), game: null, createdAt: Date.now(), updatedAt: Date.now(), lastDinoBroadcastAt: 0 };
    rooms.set(code, room);
  } else {
    room = rooms.get(normalizeRoomCode(data.roomCode));
    if (!room) return sendError(peer, "방을 찾을 수 없습니다. 코드를 다시 확인해주세요.");
  }
  if (data.token) {
    const returning = [...room.players.values()].find((player) => player.token === data.token);
    if (returning) { returning.nickname = sanitizeNickname(data.nickname || returning.nickname); return attachPlayer(peer, room, returning); }
  }
  if (room.status !== "lobby") return sendError(peer, "이미 게임이 시작된 방입니다.");
  if (room.players.size >= 4) return sendError(peer, "방이 가득 찼습니다.");
  const player = createPlayer(data.nickname, room.players.size);
  room.players.set(player.id, player);
  if (!room.hostId) room.hostId = player.id;
  attachPlayer(peer, room, player);
}
function withRoom(peer, callback) {
  const room = rooms.get(peer.roomCode); const player = room?.players.get(peer.playerId);
  if (!room || !player) return sendError(peer, "방 연결이 끊어졌습니다.");
  callback(room, player);
}
function handleMessage(peer, raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return sendError(peer, "잘못된 메시지입니다."); }
  if (!data || typeof data.type !== "string") return sendError(peer, "메시지 종류가 없습니다.");
  if (data.type === "create-room") return joinRoom(peer, data, true);
  if (data.type === "join-room") return joinRoom(peer, data, false);
  if (data.type === "leave-room") { detachPeer(peer, true); return peer.sendJSON({ type: "left-room" }); }
  withRoom(peer, (room, player) => {
    if (data.type === "set-nickname") { player.nickname = sanitizeNickname(data.nickname); return broadcastRoom(room); }
    if (data.type === "set-dino-skin") {
      if (room.gameType !== "dino" || room.status !== "lobby" || !SKINS.includes(data.skin)) return sendError(peer, "선택할 수 없는 공룡입니다.");
      if ([...room.players.values()].some((item) => item.id !== player.id && item.dinoSkin === data.skin)) return sendError(peer, "다른 플레이어가 사용 중인 공룡입니다.");
      player.dinoSkin = data.skin; return broadcastRoom(room);
    }
    if (data.type === "toggle-ready") {
      if (room.status !== "lobby") return sendError(peer, "대기실에서만 준비할 수 있습니다.");
      player.ready = player.id === room.hostId ? true : !player.ready; return broadcastRoom(room);
    }
    if (data.type === "start-game") {
      if (player.id !== room.hostId) return sendError(peer, "방장만 게임을 시작할 수 있습니다.");
      const connected = [...room.players.values()].filter((item) => item.connected);
      const minimumPlayers = room.gameType === "dino" ? 1 : 2;
      if (connected.length < minimumPlayers) return sendError(peer, room.gameType === "dino" ? "다이노 연습 모드를 시작할 참가자가 필요합니다." : "최소 2명이 필요합니다.");
      if (!connected.every((item) => item.ready)) return sendError(peer, "모든 참가자가 준비해야 합니다.");
      room.game = room.gameType === "dino" ? createDinoGame(connected) : createGame(connected);
      room.status = "game"; return broadcastRoom(room);
    }
    if (data.type === "flip-card") {
      if (room.gameType !== "bell") return sendError(peer, "종치기 방에서만 사용할 수 있습니다.");
      if (data.roundId !== room.game?.roundId || !Number.isSafeInteger(data.tableRevision) || data.tableRevision !== room.game?.tableRevision) return;
      if (Date.now() - (peer.lastFlipAt || 0) < 120) return;
      peer.lastFlipAt = Date.now(); const result = flipCard(room.game, player.id);
      if (!result.ok) return sendError(peer, result.error);
      if (!validateGameState(room.game).ok) return sendError(peer, "게임 상태를 확인할 수 없습니다.");
      return broadcastRoom(room);
    }
    if (data.type === "ring-bell") {
      if (room.gameType !== "bell") return sendError(peer, "종치기 방에서만 사용할 수 있습니다.");
      if (data.roundId !== room.game?.roundId || !Number.isSafeInteger(data.tableRevision)) return;
      if (Date.now() - (peer.lastBellAt || 0) < 300) return;
      peer.lastBellAt = Date.now(); const result = ringBell(room.game, player.id, data.tableRevision);
      if (!result.ok) return sendError(peer, result.error);
      if (result.ignored) return;
      if (!validateGameState(room.game).ok) return sendError(peer, "게임 상태를 확인할 수 없습니다.");
      return broadcastRoom(room);
    }
    if (data.type === "dino-jump" || data.type === "dino-duck") {
      if (room.gameType !== "dino") return sendError(peer, "다이노 런 방에서만 사용할 수 있습니다.");
      if (data.roundId !== room.game?.roundId || !Number.isSafeInteger(data.sequence)) return;
      const now = Date.now();
      const action = data.type === "dino-jump" ? "jump" : (data.active === false ? "run" : "duck");
      if (action !== "run" && now - (peer.lastDinoInputAt || 0) < 45) return;
      if (action !== "run") peer.lastDinoInputAt = now;
      const result = setDinoAction(room.game, player.id, action, now, Number.isSafeInteger(data.sequence) ? data.sequence : undefined);
      if (!result.ok && room.game?.status !== "countdown") return sendError(peer, result.error);
      return broadcastRoom(room);
    }
    if (data.type === "return-lobby") {
      if (player.id !== room.hostId) return sendError(peer, "방장만 대기실로 돌아갈 수 있습니다.");
      pruneDisconnectedPlayers(room);
      room.status = "lobby"; room.game = null;
      for (const item of room.players.values()) item.ready = item.id === room.hostId;
      return broadcastRoom(room);
    }
    if (data.type === "dino-rematch") {
      if (room.gameType !== "dino" || room.game?.status !== "finished") return sendError(peer, "종료된 다이노 레이스에서만 재대결할 수 있습니다.");
      if (player.id !== room.hostId) return sendError(peer, "방장만 재대결을 시작할 수 있습니다.");
      const connected = [...room.players.values()].filter((item) => item.connected);
      if (connected.length < 1) return sendError(peer, "재대결할 참가자가 필요합니다.");
      pruneDisconnectedPlayers(room);
      for (const item of connected) item.ready = true;
      room.game = createDinoGame(connected);
      room.status = "game";
      return broadcastRoom(room);
    }
    if (data.type === "bell-rematch") {
      if (room.gameType !== "bell" || room.game?.status !== "finished") return sendError(peer, "종료된 종치기 게임에서만 재대결할 수 있습니다.");
      if (player.id !== room.hostId) return sendError(peer, "방장만 재대결을 시작할 수 있습니다.");
      const connected = [...room.players.values()].filter((item) => item.connected);
      if (connected.length < 2) return sendError(peer, "재대결에는 최소 2명이 필요합니다.");
      pruneDisconnectedPlayers(room);
      for (const item of connected) item.ready = true;
      room.game = createGame(connected);
      room.status = "game";
      return broadcastRoom(room);
    }
    sendError(peer, "지원하지 않는 동작입니다.");
  });
}
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
    peers.add(peer); peer.on("message", (message) => handleMessage(peer, message)); peer.on("close", () => { peers.delete(peer); detachPeer(peer); }); peer.sendJSON({ type: "connected" });
  });
  const dinoTicker = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.status !== "game" || room.gameType !== "dino" || room.game?.status === "finished") continue;
      if (![...room.players.values()].some((player) => player.connected)) continue;
      const changed = advanceDinoGame(room.game, now);
      if (changed && (now - room.lastDinoBroadcastAt >= 100 || room.game.status === "finished")) { room.lastDinoBroadcastAt = now; broadcastRoom(room); }
    }
  }, 50);
  dinoTicker.unref();
  const heartbeat = setInterval(() => {
    for (const peer of peers) { if (!peer.alive) peer.close(4000, "Heartbeat timeout"); else peer.ping(); }
    const cutoff = Date.now() - ROOM_MAX_AGE;
    for (const [code, room] of rooms) if (room.updatedAt < cutoff && ![...room.players.values()].some((player) => player.connected)) rooms.delete(code);
  }, 30000);
  heartbeat.unref(); server.on("close", () => { clearInterval(heartbeat); clearInterval(dinoTicker); });
  return { server, port, host, listen(callback) { return server.listen(port, host, callback); }, close(callback) { for (const peer of peers) peer.close(1001, "Server shutdown"); return server.close(callback); } };
}
if (require.main === module) {
  const app = createServer(); app.listen(() => {
    const activePort = app.server.address().port; console.log("TS 게임센터: http://localhost:" + activePort);
    const urls = localAddresses(activePort); if (urls.length) console.log("휴대폰 접속: " + urls.join(" 또는 "));
  });
}
module.exports = { createServer, rooms, normalizeRoomCode, sanitizeNickname };
