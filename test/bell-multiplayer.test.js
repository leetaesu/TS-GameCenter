"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer, rooms } = require("../server");
const { validateGameState } = require("../game");

function inbox(socket) {
  const queue = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(event.data);
    const waiter = waiters.find((item) => item.predicate(value));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else queue.push(value);
  });
  return {
    next(predicate, timeout = 4000) {
      const found = queue.find(predicate);
      if (found) {
        queue.splice(queue.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const item = { predicate, resolve };
        item.timer = setTimeout(() => {
          const index = waiters.indexOf(item);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("메시지 대기 시간 초과"));
        }, timeout);
        item.timer.unref();
        waiters.push(item);
      });
    },
  };
}

async function openClient(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const box = inbox(socket);
  await once(socket, "open");
  await box.next((value) => value.type === "connected");
  return { socket, box };
}

async function setupBellRoom(count) {
  rooms.clear();
  const app = createServer({ port: 0, host: "127.0.0.1" });
  app.listen();
  await once(app.server, "listening");
  const port = app.server.address().port;
  const clients = [];
  const host = await openClient(port);
  clients.push(host);
  host.socket.send(JSON.stringify({ type: "create-room", nickname: "1P", gameType: "bell" }));
  const hostWelcome = await host.box.next((value) => value.type === "welcome");
  await host.box.next((value) => value.type === "room-state" && value.room.players.length === 1);

  for (let index = 1; index < count; index += 1) {
    const client = await openClient(port);
    clients.push(client);
    client.socket.send(JSON.stringify({ type: "join-room", roomCode: hostWelcome.roomCode, nickname: `${index + 1}P` }));
    client.welcome = await client.box.next((value) => value.type === "welcome");
    await client.box.next((value) => value.type === "room-state" && value.room.players.length === index + 1);
  }
  for (const client of clients.slice(1)) client.socket.send(JSON.stringify({ type: "toggle-ready" }));
  await host.box.next((value) => value.type === "room-state" && value.room.players.length === count && value.room.players.every((player) => player.ready));
  return { app, port, clients, code: hostWelcome.roomCode, hostWelcome };
}

async function closeSetup(setup) {
  await new Promise((resolve) => setup.app.close(resolve));
}

for (const count of [2, 3, 4]) {
  test(`${count}인 종치기 방이 입장·준비·시작되고 56장을 공유한다`, async () => {
    const setup = await setupBellRoom(count);
    try {
      setup.clients[0].socket.send(JSON.stringify({ type: "start-game" }));
      const states = await Promise.all(setup.clients.map((client) => client.box.next((value) => value.type === "room-state" && value.room.status === "game")));
      const roundIds = new Set(states.map((state) => state.room.game.roundId));
      assert.equal(roundIds.size, 1);
      assert.ok(states.every((state) => state.room.game.players.length === count));
      assert.equal(states[0].room.game.players.reduce((sum, player) => sum + player.cards + player.pile, 0), 56);
      assert.equal(validateGameState(rooms.get(setup.code).game).ok, true);
    } finally {
      await closeSetup(setup);
    }
  });
}

test("4인 동시 종은 최초 한 명만 처리하고 재접속·방장 승계·재대결이 유지된다", { timeout: 10000 }, async () => {
  const setup = await setupBellRoom(4);
  try {
    setup.clients[0].socket.send(JSON.stringify({ type: "start-game" }));
    const started = await setup.clients[0].box.next((value) => value.type === "room-state" && value.room.status === "game");
    const serverRoom = rooms.get(setup.code);
    const firstRoundId = serverRoom.game.roundId;
    const firstCard = serverRoom.game.players[0].deck.shift();
    const secondCard = serverRoom.game.players[1].deck.shift();
    Object.assign(firstCard, { fruit: "plum", value: 2 });
    Object.assign(secondCard, { fruit: "plum", value: 3 });
    serverRoom.game.players[0].discard.push(firstCard);
    serverRoom.game.players[1].discard.push(secondCard);
    serverRoom.game.tableRevision = 1;

    const bell = JSON.stringify({ type: "ring-bell", roundId: firstRoundId, tableRevision: 1 });
    setup.clients[2].socket.send(bell);
    setup.clients[1].socket.send(bell);
    setup.clients[3].socket.send(bell);
    setup.clients[0].socket.send(bell);
    const synced = await Promise.all(setup.clients.map((client) => client.box.next((value) => value.type === "room-state" && value.room.game?.lastAction?.type === "correct-bell")));
    assert.equal(new Set(synced.map((state) => state.room.game.actionId)).size, 1);
    assert.equal(serverRoom.game.actionId, 1);
    assert.equal(serverRoom.game.players.reduce((sum, player) => sum + player.discard.length, 0), 0);
    assert.equal(validateGameState(serverRoom.game).ok, true);

    const originalHostId = started.room.hostId;
    const originalHostToken = setup.hostWelcome.token;
    setup.clients[0].socket.close();
    const transferred = await setup.clients[1].box.next((value) => value.type === "room-state" && value.room.hostId === value.room.selfId);
    assert.notEqual(transferred.room.hostId, originalHostId);

    const returning = await openClient(setup.port);
    setup.clients.push(returning);
    returning.socket.send(JSON.stringify({ type: "join-room", roomCode: setup.code, nickname: "1P 복귀", token: originalHostToken }));
    const rejoined = await returning.box.next((value) => value.type === "welcome");
    const restored = await returning.box.next((value) => value.type === "room-state" && value.room.status === "game");
    assert.equal(rejoined.playerId, originalHostId);
    assert.equal(restored.room.game.roundId, firstRoundId);
    assert.equal(restored.room.players.length, 4);

    serverRoom.game.status = "finished";
    serverRoom.game.winnerId = serverRoom.hostId;
    serverRoom.game.turnId = null;
    setup.clients[1].socket.send(JSON.stringify({ type: "bell-rematch" }));
    const rematch = await returning.box.next((value) => value.type === "room-state" && value.room.game?.status === "playing" && value.room.game.roundId !== firstRoundId);
    assert.equal(rematch.room.game.players.length, 4);
    assert.equal(validateGameState(serverRoom.game).ok, true);

    const actionBefore = serverRoom.game.actionId;
    returning.socket.send(JSON.stringify({ type: "ring-bell", roundId: firstRoundId, tableRevision: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(serverRoom.game.actionId, actionBefore);
    returning.socket.send(JSON.stringify({ type: "ring-bell", roundId: rematch.room.game.roundId, tableRevision: 0 }));
    const wrongBell = await returning.box.next((value) => value.type === "room-state" && value.room.game?.lastAction?.type === "wrong-bell");
    assert.equal(wrongBell.room.game.tableRevision, 1);
    returning.socket.send(JSON.stringify({ type: "flip-card", roundId: rematch.room.game.roundId, tableRevision: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(serverRoom.game.actionId, actionBefore + 1);
    returning.socket.send(JSON.stringify({ type: "flip-card", roundId: rematch.room.game.roundId, tableRevision: 1 }));
    await returning.box.next((value) => value.type === "room-state" && value.room.game?.actionId === actionBefore + 2);

    setup.clients[3].socket.close();
    await returning.box.next((value) => value.type === "room-state" && value.room.players.some((item) => !item.connected));
    setup.clients[1].socket.send(JSON.stringify({ type: "return-lobby" }));
    const lobby = await returning.box.next((value) => value.type === "room-state" && value.room.status === "lobby");
    assert.equal(lobby.room.players.length, 3);
    assert.ok(lobby.room.players.every((item) => item.connected));
  } finally {
    await closeSetup(setup);
  }
});

test("전원이 잠깐 끊긴 뒤 먼저 돌아온 참가자에게 종치기 차례를 복구한다", async () => {
  const setup = await setupBellRoom(2);
  try {
    setup.clients[0].socket.send(JSON.stringify({ type: "start-game" }));
    await setup.clients[0].box.next((value) => value.type === "room-state" && value.room.status === "game");
    const closeEvents = setup.clients.map((client) => once(client.socket, "close"));
    setup.clients.forEach((client) => client.socket.close());
    await Promise.all(closeEvents);

    const returningSecond = await openClient(setup.port);
    setup.clients.push(returningSecond);
    returningSecond.socket.send(JSON.stringify({ type: "join-room", roomCode: setup.code, nickname: "2P 복귀", token: setup.clients[1].welcome.token }));
    await returningSecond.box.next((value) => value.type === "welcome");
    const restored = await returningSecond.box.next((value) => value.type === "room-state" && value.room.status === "game");
    assert.equal(restored.room.game.turnId, restored.room.selfId);
  } finally {
    await closeSetup(setup);
  }
});

test("방장 권한·최대 4명·알 수 없는 명령·정적 경로를 서버가 거부한다", async () => {
  const setup = await setupBellRoom(4);
  try {
    setup.clients[1].socket.send(JSON.stringify({ type: "start-game" }));
    const hostOnly = await setup.clients[1].box.next((value) => value.type === "error");
    assert.match(hostOnly.message, /방장/);

    setup.clients[2].socket.send(JSON.stringify({ type: "not-a-command" }));
    const unknown = await setup.clients[2].box.next((value) => value.type === "error");
    assert.match(unknown.message, /지원하지 않는/);

    const fifth = await openClient(setup.port);
    setup.clients.push(fifth);
    fifth.socket.send(JSON.stringify({ type: "join-room", roomCode: setup.code, nickname: "5P" }));
    const full = await fifth.box.next((value) => value.type === "error");
    assert.match(full.message, /가득/);

    const traversal = await fetch(`http://127.0.0.1:${setup.port}/%2e%2e/server.js`);
    assert.equal(traversal.status, 404);
  } finally {
    await closeSetup(setup);
  }
});
