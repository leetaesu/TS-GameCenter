"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRoomEngine } = require("../public/js/room-engine.js");

function makePeer() {
  const peer = { roomCode: null, playerId: null, messages: [], sendJSON(data) { peer.messages.push(data); }, close() {} };
  return peer;
}

test("P2P 방장은 4자리 방 코드를 직접 정할 수 있다", () => {
  const engine = createRoomEngine({ allowChosenCode: true });
  const host = makePeer();
  engine.handleMessage(host, JSON.stringify({ type: "create-room", nickname: "방장", gameType: "dino", roomCode: "4321" }));
  assert.equal(host.messages.find((message) => message.type === "welcome").roomCode, "4321");
  const guest = makePeer();
  engine.handleMessage(guest, JSON.stringify({ type: "join-room", nickname: "친구", roomCode: "4321" }));
  const state = guest.messages.filter((message) => message.type === "room-state").pop();
  assert.deepEqual(state.room.players.map((player) => player.nickname), ["방장", "친구"]);
});

test("서버 모드에서는 클라이언트가 방 코드를 고를 수 없다", () => {
  const engine = createRoomEngine();
  const peer = makePeer();
  engine.handleMessage(peer, JSON.stringify({ type: "create-room", nickname: "누군가", gameType: "bell", roomCode: "1111" }));
  assert.match(peer.messages.find((message) => message.type === "welcome").roomCode, /^\d{4}$/);
});

test("이미 사용 중인 코드는 새 코드로 대체된다", () => {
  const engine = createRoomEngine({ allowChosenCode: true });
  const first = makePeer(), second = makePeer();
  engine.handleMessage(first, JSON.stringify({ type: "create-room", nickname: "a", gameType: "bell", roomCode: "7777" }));
  engine.handleMessage(second, JSON.stringify({ type: "create-room", nickname: "b", gameType: "bell", roomCode: "7777" }));
  assert.notEqual(second.messages.find((message) => message.type === "welcome").roomCode, "7777");
});
