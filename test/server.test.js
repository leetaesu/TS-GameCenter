"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer, rooms } = require("../server");

function inbox(socket) {
  const queue = []; const waiters = [];
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(event.data); const waiter = waiters.find((item) => item.predicate(value));
    if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(value); } else queue.push(value);
  });
  return { next(predicate, timeout = 4000) {
    const found = queue.find(predicate); if (found) { queue.splice(queue.indexOf(found), 1); return Promise.resolve(found); }
    return new Promise((resolve, reject) => { const item = { predicate, resolve }; waiters.push(item); setTimeout(() => { const index = waiters.indexOf(item); if (index >= 0) waiters.splice(index, 1); reject(new Error("메시지 대기 시간 초과")); }, timeout).unref(); });
  } };
}
async function openPair(app) {
  app.listen(); await once(app.server, "listening"); const port = app.server.address().port;
  const first = new WebSocket("ws://127.0.0.1:" + port + "/ws"); const second = new WebSocket("ws://127.0.0.1:" + port + "/ws");
  await Promise.all([once(first, "open"), once(second, "open")]); return { port, first, second, one: inbox(first), two: inbox(second) };
}
async function makeReadyRoom(pair, gameType) {
  pair.first.send(JSON.stringify({ type: "create-room", nickname: "방장", gameType }));
  const welcome = await pair.one.next((value) => value.type === "welcome"); await pair.one.next((value) => value.type === "room-state");
  pair.second.send(JSON.stringify({ type: "join-room", roomCode: welcome.roomCode, nickname: "친구" }));
  await pair.two.next((value) => value.type === "welcome"); await pair.two.next((value) => value.type === "room-state" && value.room.players.length === 2);
  pair.second.send(JSON.stringify({ type: "toggle-ready" })); await pair.one.next((value) => value.type === "room-state" && value.room.players.every((player) => player.ready));
  return welcome.roomCode;
}

test("정적 화면과 2인 종치기 방 흐름이 동작한다", async (context) => {
  rooms.clear(); const app = createServer({ port: 0, host: "127.0.0.1" }); const pair = await openPair(app);
  context.after(() => new Promise((resolve) => app.close(resolve))); context.after(() => { pair.first.close(); pair.second.close(); });
  const response = await fetch("http://127.0.0.1:" + pair.port + "/"); assert.equal(response.status, 200); assert.match(await response.text(), /TS 게임센터/);
  const info = await (await fetch("http://127.0.0.1:" + pair.port + "/api/info")).json();
  assert.ok(Array.isArray(info.lanUrls)); assert.ok(Array.isArray(info.networks)); assert.ok(info.networks.every((network) => network.url.includes(":" + pair.port)));
  await makeReadyRoom(pair, "bell"); pair.first.send(JSON.stringify({ type: "start-game" }));
  const started = await pair.one.next((value) => value.type === "room-state" && value.room.status === "game");
  assert.equal(started.room.gameType, "bell"); assert.equal(started.room.game.players.length, 2); assert.equal(started.room.game.status, "playing");
});

test("2인 다이노 방은 스킨과 공통 장애물을 포함해 시작한다", async (context) => {
  rooms.clear(); const app = createServer({ port: 0, host: "127.0.0.1" }); const pair = await openPair(app);
  context.after(() => new Promise((resolve) => app.close(resolve))); context.after(() => { pair.first.close(); pair.second.close(); });
  const code = await makeReadyRoom(pair, "dino"); pair.first.send(JSON.stringify({ type: "start-game" }));
  const started = await pair.one.next((value) => value.type === "room-state" && value.room.status === "game");
  assert.equal(started.room.gameType, "dino"); assert.equal(started.room.game.status, "countdown"); assert.equal(started.room.game.players.length, 2); assert.ok(started.room.game.obstacles.length > 0);
  assert.deepEqual(started.room.game.players.map((player) => player.skin), ["pink", "cyan"]);
  const serverRoom = rooms.get(code); serverRoom.game.startedAt = Date.now() - 10; serverRoom.game.lastTickAt = serverRoom.game.startedAt;
  await pair.one.next((value) => value.type === "room-state" && value.room.game?.status === "running");
  pair.first.send(JSON.stringify({ type: "dino-jump", roundId: started.room.game.roundId, sequence: 1 }));
  const jumped = await pair.one.next((value) => value.type === "room-state" && value.room.game?.players.some((player) => player.id === value.room.selfId && player.action === "jump"));
  assert.equal(jumped.room.game.status, "running");
});

test("1인 다이노 연습 모드는 시작·조작·완주·재대결한다", { timeout: 8000 }, async (context) => {
  rooms.clear(); const app = createServer({ port: 0, host: "127.0.0.1" }); app.listen(); await once(app.server, "listening");
  const port = app.server.address().port; const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws");
  context.after(() => new Promise((resolve) => app.close(resolve))); context.after(() => socket.close());
  await once(socket, "open"); const box = inbox(socket);
  socket.send(JSON.stringify({ type: "create-room", nickname: "혼자연습", gameType: "dino" }));
  const welcome = await box.next((value) => value.type === "welcome");
  await box.next((value) => value.type === "room-state" && value.room.players.length === 1);
  socket.send(JSON.stringify({ type: "start-game" }));
  const started = await box.next((value) => value.type === "room-state" && value.room.status === "game");
  assert.equal(started.room.game.players.length, 1); assert.equal(started.room.game.status, "countdown");
  const firstRoundId = started.room.game.roundId; const serverRoom = rooms.get(welcome.roomCode);
  serverRoom.game.startedAt = Date.now() - 20; serverRoom.game.lastTickAt = serverRoom.game.startedAt;
  await box.next((value) => value.type === "room-state" && value.room.game?.status === "running");
  socket.send(JSON.stringify({ type: "dino-jump", roundId: firstRoundId, sequence: 1 }));
  await box.next((value) => value.type === "room-state" && value.room.game?.players[0].action === "jump");
  serverRoom.game.finishDistance = serverRoom.game.distance + 1;
  const finished = await box.next((value) => value.type === "room-state" && value.room.game?.status === "finished");
  assert.equal(finished.room.game.winnerId, finished.room.selfId); assert.deepEqual(finished.room.game.ranking, [finished.room.selfId]);
  socket.send(JSON.stringify({ type: "dino-rematch" }));
  const rematch = await box.next((value) => value.type === "room-state" && value.room.game?.status === "countdown" && value.room.game.roundId !== firstRoundId);
  assert.equal(rematch.room.game.players.length, 1);
});
