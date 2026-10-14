"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DECK_SIZE,
  createDeck,
  createGame,
  flipCard,
  ringBell,
  fruitCounts,
  validateGameState,
} = require("../game");

function players(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    nickname: `${index + 1}P`,
    avatar: "joystick",
    connected: true,
  }));
}

function expose(game, playerIndex, fruit, value) {
  const card = game.players[playerIndex].deck.shift();
  Object.assign(card, { fruit, value });
  game.players[playerIndex].discard.push(card);
  return card;
}

test("종치기 덱은 고유한 56장이며 과일별 14장이다", () => {
  const deck = createDeck(() => 0.5);
  assert.equal(deck.length, DECK_SIZE);
  assert.equal(new Set(deck.map((card) => card.id)).size, DECK_SIZE);
  for (const fruit of ["strawberry", "banana", "lime", "plum"]) {
    assert.equal(deck.filter((card) => card.fruit === fruit).length, 14);
  }
});

test("2·3·4인에게 56장을 빠짐없이 분배한다", () => {
  const expected = { 2: [28, 28], 3: [19, 19, 18], 4: [14, 14, 14, 14] };
  for (const count of [2, 3, 4]) {
    const game = createGame(players(count), () => 0.5);
    assert.deepEqual(game.players.map((player) => player.deck.length), expected[count]);
    assert.equal(validateGameState(game).ok, true);
  }
  assert.throws(() => createGame(players(1)), /2~4명/);
  assert.throws(() => createGame(players(5)), /2~4명/);
});

test("자기 차례에만 뒤집고 4인 차례가 순환한다", () => {
  const game = createGame(players(4), () => 0.5);
  assert.equal(flipCard(game, "p2").ok, false);
  for (const id of ["p1", "p2", "p3", "p4"]) assert.equal(flipCard(game, id).ok, true);
  assert.equal(game.turnId, "p1");
  assert.equal(game.tableRevision, 4);
  assert.equal(validateGameState(game).ok, true);
});

test("연결이 끊긴 참가자는 다음 차례에서 건너뛴다", () => {
  const game = createGame(players(3), () => 0.5);
  game.players[1].connected = false;
  assert.equal(flipCard(game, "p1").ok, true);
  assert.equal(game.turnId, "p3");
  assert.equal(flipCard(game, "p3").ok, true);
  assert.equal(game.turnId, "p1");
  assert.equal(validateGameState(game).ok, true);
});

test("같은 과일 합계가 정확히 5면 최초 종 입력자가 공개 더미를 획득한다", () => {
  const game = createGame(players(2), () => 0.5);
  expose(game, 0, "strawberry", 2);
  expose(game, 1, "strawberry", 3);
  game.tableRevision = 2;
  assert.equal(fruitCounts(game).strawberry, 5);
  const before = game.players[1].deck.length;
  const first = ringBell(game, "p2", 2);
  const second = ringBell(game, "p1", 2);
  assert.deepEqual(first, { ok: true, correct: true, collected: 2 });
  assert.equal(second.ignored, true);
  assert.equal(game.players[1].deck.length, before + 2);
  assert.equal(game.turnId, "p2");
  assert.equal(validateGameState(game).ok, true);
});

test("오답 종은 상대마다 한 장씩 주고 같은 공개 상태의 중복 종은 무시한다", () => {
  const game = createGame(players(4), () => 0.5);
  expose(game, 0, "banana", 2);
  expose(game, 1, "lime", 2);
  game.tableRevision = 2;
  const before = game.players.map((player) => player.deck.length);
  const first = ringBell(game, "p1", 2);
  const actionId = game.actionId;
  const duplicate = ringBell(game, "p2", 2);
  assert.equal(first.correct, false);
  assert.equal(first.penalty, 3);
  assert.equal(game.players[0].deck.length, before[0] - 3);
  assert.deepEqual(game.players.slice(1).map((player, index) => player.deck.length - before[index + 1]), [1, 1, 1]);
  assert.equal(duplicate.ignored, true);
  assert.equal(game.actionId, actionId);
  assert.equal(validateGameState(game).ok, true);
});

test("늦게 도착한 이전 테이블 종은 무시하고 새 카드 뒤집기 후 다시 종칠 수 있다", () => {
  const game = createGame(players(2), () => 0.5);
  assert.equal(flipCard(game, "p1").ok, true);
  const stale = ringBell(game, "p2", 0);
  assert.equal(stale.reason, "stale-table");
  const current = ringBell(game, "p2", 1);
  assert.equal(current.ok, true);
  assert.equal(game.tableRevision, 2);
  assert.equal(ringBell(game, "p1", 1).reason, "stale-table");
  assert.equal(flipCard(game, "p2").ok, true);
  assert.equal(ringBell(game, "p1", 3).ignored, undefined);
  assert.equal(validateGameState(game).ok, true);
});

test("마지막 덱 카드를 뒤집으면 남은 한 명을 단일 승자로 확정한다", () => {
  const game = createGame(players(2), () => 0.5);
  game.players[1].deck.push(...game.players[0].deck.splice(1));
  const result = flipCard(game, "p1");
  assert.equal(result.ok, true);
  assert.equal(game.status, "finished");
  assert.equal(game.winnerId, "p2");
  assert.equal(game.turnId, null);
  assert.equal(validateGameState(game).ok, true);
});
