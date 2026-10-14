"use strict";

const crypto = require("node:crypto");

const FRUITS = ["strawberry", "banana", "lime", "plum"];
const CARD_COUNTS = new Map([[1, 5], [2, 3], [3, 3], [4, 2], [5, 1]]);
const DECK_SIZE = 56;

function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function createDeck(random = Math.random) {
  const deck = [];
  for (const fruit of FRUITS) {
    for (const [value, count] of CARD_COUNTS) {
      for (let copy = 0; copy < count; copy += 1) {
        deck.push({ id: `${fruit}-${value}-${copy}`, fruit, value });
      }
    }
  }
  return shuffle(deck, random);
}

function createGame(players, random = Math.random) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
    throw new RangeError("종치기는 2~4명으로 시작해야 합니다.");
  }
  const deck = createDeck(random);
  const gamePlayers = players.map((player) => ({
    id: player.id,
    nickname: player.nickname,
    avatar: player.avatar,
    connected: player.connected,
    deck: [],
    discard: [],
  }));
  deck.forEach((card, index) => gamePlayers[index % gamePlayers.length].deck.push(card));
  return {
    kind: "bell",
    roundId: crypto.randomUUID(),
    status: "playing",
    players: gamePlayers,
    turnId: gamePlayers[0].id,
    winnerId: null,
    actionId: 0,
    tableRevision: 0,
    resolvedBellRevision: -1,
    lastAction: { type: "started", message: "첫 번째 라운드가 시작되었습니다." },
    startedAt: Date.now(),
  };
}

function topCard(player) {
  return player.discard[player.discard.length - 1] || null;
}

function fruitCounts(game) {
  const counts = Object.fromEntries(FRUITS.map((fruit) => [fruit, 0]));
  for (const player of game.players) {
    const card = topCard(player);
    if (card) counts[card.fruit] += card.value;
  }
  return counts;
}

function activePlayers(game) {
  return game.players.filter((player) => player.deck.length > 0);
}

function finishIfNeeded(game) {
  const active = activePlayers(game);
  if (active.length > 1) return false;
  game.status = "finished";
  game.winnerId = active[0]?.id || game.players
    .slice()
    .sort((a, b) => (b.deck.length + b.discard.length) - (a.deck.length + a.discard.length))[0]?.id || null;
  game.turnId = null;
  game.actionId += 1;
  game.lastAction = { type: "finished", playerId: game.winnerId, message: "마지막까지 카드를 지킨 플레이어가 우승했습니다!" };
  return true;
}

function nextTurn(game, fromId) {
  const start = game.players.findIndex((player) => player.id === fromId);
  for (let offset = 1; offset <= game.players.length; offset += 1) {
    const player = game.players[(start + offset) % game.players.length];
    if (player.connected && player.deck.length > 0) return player.id;
  }
  return null;
}

function flipCard(game, playerId) {
  if (!game || game.status !== "playing") return { ok: false, error: "진행 중인 게임이 아닙니다." };
  if (game.turnId !== playerId) return { ok: false, error: "아직 내 차례가 아닙니다." };
  const player = game.players.find((item) => item.id === playerId);
  if (!player || player.deck.length === 0) return { ok: false, error: "뒤집을 카드가 없습니다." };
  const card = player.deck.shift();
  player.discard.push(card);
  game.tableRevision += 1;
  game.actionId += 1;
  game.lastAction = { type: "flip", playerId, card, message: `${player.nickname} 님이 카드를 뒤집었습니다.` };
  if (!finishIfNeeded(game)) {
    game.turnId = nextTurn(game, playerId);
    if (!game.turnId) game.turnId = player.deck.length > 0 ? player.id : null;
  }
  return { ok: true, card, tableRevision: game.tableRevision };
}

function ringBell(game, playerId, expectedRevision = game?.tableRevision) {
  if (!game || game.status !== "playing") return { ok: false, error: "진행 중인 게임이 아닙니다." };
  const player = game.players.find((item) => item.id === playerId);
  if (!player) return { ok: false, error: "게임 참가자가 아닙니다." };
  if (expectedRevision !== game.tableRevision) return { ok: true, ignored: true, reason: "stale-table" };
  if (game.resolvedBellRevision === game.tableRevision) return { ok: true, ignored: true, reason: "already-rung" };

  // 같은 공개 카드 상태에서는 서버에 가장 먼저 도착한 종 입력만 인정한다.
  game.resolvedBellRevision = game.tableRevision;
  const matches = Object.entries(fruitCounts(game)).filter(([, count]) => count === 5).map(([fruit]) => fruit);
  game.actionId += 1;
  if (matches.length) {
    const collected = [];
    for (const item of game.players) collected.push(...item.discard.splice(0));
    player.deck.push(...collected);
    game.turnId = player.id;
    game.tableRevision += 1;
    game.resolvedBellRevision = game.tableRevision;
    game.lastAction = { type: "correct-bell", playerId, fruits: matches, collected: collected.length, message: `${player.nickname} 정답! 카드 ${collected.length}장을 가져갑니다.` };
    return { ok: true, correct: true, collected: collected.length };
  }

  let penalty = 0;
  for (const opponent of game.players) {
    if (opponent.id !== player.id && player.deck.length) {
      opponent.deck.push(player.deck.shift());
      penalty += 1;
    }
  }
  game.tableRevision += 1;
  game.resolvedBellRevision = game.tableRevision;
  game.lastAction = { type: "wrong-bell", playerId, penalty, message: `${player.nickname} 오답! 상대에게 카드 ${penalty}장을 줍니다.` };
  finishIfNeeded(game);
  return { ok: true, correct: false, penalty };
}

function validateGameState(game) {
  const errors = [];
  if (!game || game.kind !== "bell") return { ok: false, errors: ["invalid-game"] };
  const cards = game.players.flatMap((player) => [...player.deck, ...player.discard]);
  if (cards.length !== DECK_SIZE) errors.push(`card-count:${cards.length}`);
  const ids = cards.map((card) => card.id);
  if (new Set(ids).size !== ids.length) errors.push("duplicate-card-id");
  if (game.status === "playing" && !game.players.some((player) => player.id === game.turnId && player.deck.length > 0)) errors.push("invalid-turn");
  if (game.status === "finished" && !game.players.some((player) => player.id === game.winnerId)) errors.push("invalid-winner");
  return { ok: errors.length === 0, errors };
}

function publicGame(game) {
  if (!game) return null;
  return {
    kind: "bell",
    roundId: game.roundId,
    status: game.status,
    turnId: game.turnId,
    winnerId: game.winnerId,
    actionId: game.actionId,
    tableRevision: game.tableRevision,
    bellOpen: game.resolvedBellRevision !== game.tableRevision,
    lastAction: game.lastAction,
    counts: fruitCounts(game),
    players: game.players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      avatar: player.avatar,
      connected: player.connected,
      cards: player.deck.length,
      pile: player.discard.length,
      faceUp: topCard(player),
    })),
  };
}

module.exports = {
  DECK_SIZE,
  FRUITS,
  createDeck,
  createGame,
  flipCard,
  ringBell,
  publicGame,
  fruitCounts,
  shuffle,
  validateGameState,
};
