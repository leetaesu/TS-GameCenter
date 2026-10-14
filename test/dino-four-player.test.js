"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer, rooms } = require("../server");

function inbox(socket) {
  const queue = []; const waiters = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data); const waiter = waiters.find((item) => item.predicate(message));
    if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); } else queue.push(message);
  });
  return { next(predicate, timeout = 5000) {
    const found = queue.find(predicate); if (found) { queue.splice(queue.indexOf(found), 1); return Promise.resolve(found); }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve }; waiters.push(waiter);
      setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error("4인 테스트 메시지 대기 시간 초과")); }, timeout).unref();
    });
  } };
}
async function connect(port) {
  const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws"); await once(socket, "open"); return { socket, messages: inbox(socket) };
}
function send(client, type, payload = {}) { client.socket.send(JSON.stringify({ type, ...payload })); }

test("다이노 3인 방도 같은 상태로 시작하고 완주한다", { timeout: 10000 }, async (context) => {
  rooms.clear(); const app = createServer({ port: 0, host: "127.0.0.1" }); app.listen(); await once(app.server, "listening");
  const port = app.server.address().port; const clients = await Promise.all([connect(port), connect(port), connect(port)]);
  context.after(() => new Promise((resolve) => app.close(resolve))); context.after(() => clients.forEach((client) => client.socket.close()));

  send(clients[0], "create-room", { nickname: "방장", gameType: "dino" });
  const welcome = await clients[0].messages.next((message) => message.type === "welcome");
  await clients[0].messages.next((message) => message.type === "room-state" && message.room.players.length === 1);
  for (let index = 1; index < 3; index += 1) {
    send(clients[index], "join-room", { roomCode: welcome.roomCode, nickname: `선수${index + 1}` });
    await clients[index].messages.next((message) => message.type === "welcome");
    await clients[index].messages.next((message) => message.type === "room-state" && message.room.players.length === index + 1);
    send(clients[index], "toggle-ready");
  }
  await clients[0].messages.next((message) => message.type === "room-state" && message.room.players.every((player) => player.ready));
  send(clients[0], "start-game");
  const states = await Promise.all(clients.map((client) => client.messages.next((message) => message.type === "room-state" && message.room.status === "game")));
  assert.ok(states.every((message) => message.room.game.players.length === 3));
  assert.equal(new Set(states[0].room.game.players.map((player) => player.skin)).size, 3);
  const serverRoom = rooms.get(welcome.roomCode);
  serverRoom.game.startedAt = Date.now() - 20; serverRoom.game.lastTickAt = serverRoom.game.startedAt; serverRoom.game.finishDistance = 1;
  const finishes = await Promise.all(clients.map((client) => client.messages.next((message) => message.type === "room-state" && message.room.game?.status === "finished")));
  assert.ok(finishes.every((message) => message.room.game.ranking.length === 3));
});

test("다이노 4인이 입장·재접속·방장 승계·재대결·완주한다", { timeout: 15000 }, async (context) => {
  rooms.clear(); const app = createServer({ port: 0, host: "127.0.0.1" }); app.listen(); await once(app.server, "listening");
  const port = app.server.address().port; const clients = await Promise.all([connect(port), connect(port), connect(port), connect(port)]);
  context.after(() => new Promise((resolve) => app.close(resolve))); context.after(() => clients.forEach((client) => client.socket.close()));

  send(clients[0], "create-room", { nickname: "방장", gameType: "dino" });
  const hostWelcome = await clients[0].messages.next((message) => message.type === "welcome");
  await clients[0].messages.next((message) => message.type === "room-state" && message.room.players.length === 1);
  for (let index = 1; index < clients.length; index += 1) {
    send(clients[index], "join-room", { roomCode: hostWelcome.roomCode, nickname: "선수" + (index + 1) });
    await clients[index].messages.next((message) => message.type === "welcome");
    await clients[index].messages.next((message) => message.type === "room-state" && message.room.players.length === index + 1);
  }
  const full = await clients[0].messages.next((message) => message.type === "room-state" && message.room.players.length === 4);
  assert.equal(new Set(full.room.players.map((player) => player.dinoSkin)).size, 4);
  for (let index = 1; index < clients.length; index += 1) send(clients[index], "toggle-ready");
  await clients[0].messages.next((message) => message.type === "room-state" && message.room.players.every((player) => player.ready));
  send(clients[0], "start-game");
  const firstRace = await clients[0].messages.next((message) => message.type === "room-state" && message.room.status === "game");
  const firstRoundId = firstRace.room.game.roundId; const serverRoom = rooms.get(hostWelcome.roomCode);
  serverRoom.game.startedAt = Date.now() - 20; serverRoom.game.lastTickAt = serverRoom.game.startedAt;
  await Promise.all(clients.map((client) => client.messages.next((message) => message.type === "room-state" && message.room.game?.status === "running")));

  send(clients[0], "dino-jump", { sequence: 10, roundId: firstRoundId }); send(clients[0], "dino-duck", { active: true, sequence: 9, roundId: firstRoundId });
  const inputState = await clients[0].messages.next((message) => message.type === "room-state" && message.room.game?.players.some((player) => player.id === message.room.selfId && player.action === "jump"));
  assert.equal(inputState.room.game.players.find((player) => player.id === inputState.room.selfId).action, "jump");

  const oldHostId = hostWelcome.playerId; clients[0].socket.close();
  const transferred = await clients[1].messages.next((message) => message.type === "room-state" && message.room.hostId !== oldHostId);
  assert.equal(transferred.room.hostId, transferred.room.selfId);
  const returning = await connect(port); clients[0] = returning;
  send(returning, "join-room", { roomCode: hostWelcome.roomCode, nickname: "방장복귀", token: hostWelcome.token });
  const returnWelcome = await returning.messages.next((message) => message.type === "welcome");
  assert.equal(returnWelcome.playerId, oldHostId);
  await returning.messages.next((message) => message.type === "room-state" && message.room.players.length === 4);

  send(clients[1], "return-lobby");
  await Promise.all(clients.map((client) => client.messages.next((message) => message.type === "room-state" && message.room.status === "lobby")));
  send(clients[0], "toggle-ready"); send(clients[2], "toggle-ready"); send(clients[3], "toggle-ready");
  await clients[1].messages.next((message) => message.type === "room-state" && message.room.players.every((player) => player.ready));
  send(clients[1], "start-game");
  const secondRace = await clients[1].messages.next((message) => message.type === "room-state" && message.room.status === "game" && message.room.game?.roundId !== firstRoundId);
  assert.notEqual(secondRace.room.game.roundId, firstRoundId);
  serverRoom.game.startedAt = Date.now() - 20; serverRoom.game.lastTickAt = serverRoom.game.startedAt; serverRoom.game.finishDistance = 1;
  const finishes = await Promise.all(clients.map((client) => client.messages.next((message) => message.type === "room-state" && message.room.game?.status === "finished")));
  const winnerIds = new Set(finishes.map((message) => message.room.game.winnerId));
  const rankings = new Set(finishes.map((message) => message.room.game.ranking.join(",")));
  assert.equal(winnerIds.size, 1); assert.equal(rankings.size, 1); assert.equal(finishes[0].room.game.ranking.length, 4);
  const finishedRoundId = finishes[0].room.game.roundId;
  send(clients[1], "dino-rematch");
  const rematches = await Promise.all(clients.map((client) => client.messages.next((message) => message.type === "room-state" && message.room.game?.status === "countdown" && message.room.game.roundId !== finishedRoundId && message.room.game.roundId !== firstRoundId)));
  assert.equal(new Set(rematches.map((message) => message.room.game.roundId)).size, 1);
  const rematchRoundId = rematches[0].room.game.roundId;
  serverRoom.game.startedAt = Date.now() - 20; serverRoom.game.lastTickAt = serverRoom.game.startedAt;
  await clients[1].messages.next((message) => message.type === "room-state" && message.room.game?.status === "running");
  const rematchHost = serverRoom.game.players.find((player) => player.id === serverRoom.hostId);
  send(clients[1], "dino-jump", { sequence: 999, roundId: firstRoundId });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(rematchHost.action, "run");
  assert.equal(rematchHost.lastInputSequence, -1);
  send(clients[1], "dino-jump", { sequence: 1000, roundId: rematchRoundId });
  const accepted = await clients[1].messages.next((message) => message.type === "room-state" && message.room.game?.players.find((player) => player.id === message.room.selfId)?.action === "jump");
  assert.equal(accepted.room.game.roundId, rematchRoundId);
});
