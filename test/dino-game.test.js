"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createObstacles, createDinoGame, setDinoAction, advanceDinoGame, publicDinoGame } = require("../dino-game");
const racers = [{ id: "p1", nickname: "핑크", dinoSkin: "pink", connected: true }, { id: "p2", nickname: "청록", dinoSkin: "cyan", connected: true }];

test("같은 시드는 완전히 같은 장애물 순서를 만든다", () => {
  assert.deepEqual(createObstacles(7721, 500), createObstacles(7721, 500));
  assert.notDeepEqual(createObstacles(7721, 500), createObstacles(7722, 500));
});
test("점프와 숙이기는 대응 장애물만 회피한다", () => {
  const game = createDinoGame(racers, { now: 1000, countdownMs: 0, seed: 10, finishDistance: 300 });
  const obstacle = game.obstacles[0]; game.distance = obstacle.distance - 1; game.lastTickAt = 1000;
  setDinoAction(game, "p1", obstacle.type === "ground" ? "jump" : "duck", 1000);
  advanceDinoGame(game, 1100);
  assert.equal(game.players[0].dodged, 1); assert.equal(game.players[0].hp, 3);
  assert.equal(game.players[1].hits, 1); assert.equal(game.players[1].hp, 2);
});
test("체력이 모두 닳으면 탈락하고 마지막 생존자가 우승한다", () => {
  const game = createDinoGame(racers, { now: 1000, countdownMs: 0, seed: 7, finishDistance: 500 });
  game.players[1].hp = 1; const obstacle = game.obstacles[0]; game.distance = obstacle.distance - 1; game.lastTickAt = 1000;
  setDinoAction(game, "p1", obstacle.type === "ground" ? "jump" : "duck", 1000); advanceDinoGame(game, 1100);
  assert.equal(game.status, "finished"); assert.equal(game.winnerId, "p1"); assert.equal(game.ranking[0], "p1");
});
test("공개 상태에는 내부 판정값 대신 화면에 필요한 값만 포함한다", () => {
  const game = createDinoGame(racers, { now: 1000, countdownMs: 3000, seed: 3 }); const state = publicDinoGame(game, 1500);
  assert.equal(state.countdown, 3); assert.equal(state.players[0].skin, "pink"); assert.equal("lastObstacleIndex" in state.players[0], false); assert.ok(state.obstacles.length > 0);
});
test("중복·오래된 입력과 점프 중 숙이기는 현재 조작을 덮어쓰지 않는다", () => {
  const game = createDinoGame(racers, { now: 1000, countdownMs: 0, seed: 4 });
  assert.equal(setDinoAction(game, "p1", "jump", 1000, 8).ok, true);
  const stale = setDinoAction(game, "p1", "duck", 1010, 7);
  assert.equal(stale.ignored, true); assert.equal(game.players[0].action, "jump");
  const midairDuck = setDinoAction(game, "p1", "duck", 1020, 9);
  assert.equal(midairDuck.reason, "jump-active"); assert.equal(game.players[0].action, "jump");
  assert.equal(setDinoAction(game, "p1", "duck", 1800, 10).ok, true); assert.equal(game.players[0].action, "duck");
});
test("점프 연타로 체공 시간을 무한히 늘릴 수 없다", () => {
  const game = createDinoGame(racers, { now: 1000, countdownMs: 0, seed: 4 });
  setDinoAction(game, "p1", "jump", 1000, 1);
  const firstUntil = game.players[0].actionUntil;
  const repeated = setDinoAction(game, "p1", "jump", 1200, 2);
  assert.equal(repeated.reason, "jump-active");
  assert.equal(game.players[0].actionUntil, firstUntil);
  assert.equal(setDinoAction(game, "p1", "jump", firstUntil + 1, 3).ok, true);
  assert.ok(game.players[0].actionUntil > firstUntil);
});
test("1인 연습에서 체력이 0이면 우승자가 아니라 실패로 끝난다", () => {
  const game = createDinoGame([racers[0]], { now: 1000, countdownMs: 0, seed: 7, finishDistance: 500 });
  game.players[0].hp = 1;
  const obstacle = game.obstacles[0]; game.distance = obstacle.distance - 1; game.lastTickAt = 1000;
  advanceDinoGame(game, 1100);
  assert.equal(game.status, "finished");
  assert.equal(game.winnerId, null);
  assert.match(game.lastAction.message, /연습 종료/);
});
test("긴 서버 틱에서도 지나간 모든 장애물을 한 번씩 판정한다", () => {
  const game = createDinoGame(racers, { now: 1000, countdownMs: 0, seed: 8, finishDistance: 500 });
  game.players[0].hp = 99; game.players[1].hp = 99;
  advanceDinoGame(game, 11000);
  const crossed = game.obstacles.filter((obstacle) => obstacle.distance <= game.distance).length;
  assert.ok(crossed >= 3); assert.equal(game.players[0].hits + game.players[0].dodged, crossed); assert.equal(game.players[1].hits + game.players[1].dodged, crossed);
  advanceDinoGame(game, 11000); assert.equal(game.players[0].hits + game.players[0].dodged, crossed);
});
test("스테이지 목표 거리에 도달하면 다음 스테이지로 진행하고 체력과 장애물이 갱신된다", () => {
  const game = createDinoGame([racers[0]], { now: 1000, countdownMs: 0, seed: 12 });
  game.players[0].hp = 2;
  assert.equal(game.stage, 1);
  assert.equal(game.stageGoal, 350);
  const initialObsCount = game.obstacles.length;
  game.distance = 349;
  game.players[0].lastObstacleIndex = game.obstacles.length - 1;
  game.lastTickAt = 1000;
  advanceDinoGame(game, 1100);
  assert.equal(game.stage, 2);
  assert.equal(game.stageGoal, 750);
  assert.equal(game.players[0].hp, 3);
  assert.equal(game.lastAction.type, "stage-clear");
  assert.ok(game.obstacles.length > initialObsCount);
});
test("카운트다운 중 1초 단위로 변경 상태를 반환한다", () => {
  const game = createDinoGame(racers, { now: 1000, countdownMs: 3000, seed: 15 });
  assert.equal(game.status, "countdown");
  assert.equal(advanceDinoGame(game, 1500), false);
  assert.equal(advanceDinoGame(game, 2050), true);
  assert.equal(advanceDinoGame(game, 3050), true);
  assert.equal(advanceDinoGame(game, 4000), true);
  assert.equal(game.status, "running");
});

test("장애물에 동전(coin)이 없고 회피 시 콤보가 증가하며 피격 시 콤보가 초기화된다", () => {
  const game = createDinoGame(racers, { now: 1000, countdownMs: 0, seed: 99 });
  const kinds = new Set(game.obstacles.map((o) => o.kind));
  assert.equal(kinds.has("coin"), false, "coin 장애물은 완전히 제거되어야 함");
  assert.ok(kinds.has("spikes") || kinds.has("barrel") || kinds.has("zap") || kinds.has("laser"), "새로운 위험 장애물이 포함되어야 함");

  const player = game.players[0];
  assert.equal(player.combo, 0);
  assert.equal(player.maxCombo, 0);

  // Jump over ground obstacle
  const groundObs = game.obstacles.find((o) => o.type === "ground");
  assert.ok(groundObs);
  game.distance = groundObs.distance - 1;
  game.lastTickAt = 1000;
  setDinoAction(game, "p1", "jump", 1000);
  advanceDinoGame(game, 1100);

  assert.equal(player.dodged, 1);
  assert.equal(player.combo, 1);
  assert.equal(player.maxCombo, 1);

  // Wait for jump to land (jump is 520ms)
  game.lastTickAt = 1100;
  advanceDinoGame(game, 1600);
  assert.equal(player.action, "run");

  // Hit next obstacle while on ground
  const nextObs = game.obstacles.find((o) => o.distance > game.distance && o.type === "ground");
  assert.ok(nextObs);
  game.distance = nextObs.distance - 1;
  game.lastTickAt = 1600;
  advanceDinoGame(game, 1700);

  assert.equal(player.combo, 0, "피격 시 콤보가 0으로 초기화되어야 함");
  assert.equal(player.maxCombo, 1, "최대 콤보는 유지되어야 함");
});

test("전기(zap) 아이템을 획득하면 전방 장애물이 모두 파괴되고 점수와 콤보를 획득한다", () => {
  const game = createDinoGame([racers[0]], { now: 1000, countdownMs: 0, seed: 15, finishDistance: 600 });
  const zapObs = game.obstacles.find((o) => o.kind === "zap");
  assert.ok(zapObs, "zap 아이템이 생성되어야 함");

  const player = game.players[0];
  const zapIndex = game.obstacles.indexOf(zapObs);
  player.lastObstacleIndex = zapIndex - 1;
  game.distance = zapObs.distance - 1;
  game.lastTickAt = 1000;
  advanceDinoGame(game, 1100);

  assert.equal(zapObs.destroyed, true, "전기 아이템은 획득 시 destroyed 처리되어야 함");
  assert.equal(player.hp, 3, "전기를 먹어도 체력이 깎이지 않아야 함");
  assert.ok(player.combo >= 2, "전기 획득 시 콤보가 증가해야 함");
  assert.ok(player.score > 0, "보너스 점수가 지급되어야 함");
  assert.equal(game.lastAction.type, "zap-blast");
});

test("4인 다이노 경기에서 거리·점수·생존 여부에 따라 순위가 실시간 정렬된다", () => {
  const fourRacers = [
    { id: "p1", nickname: "선수1", dinoSkin: "pink", connected: true },
    { id: "p2", nickname: "선수2", dinoSkin: "cyan", connected: true },
    { id: "p3", nickname: "선수3", dinoSkin: "green", connected: true },
    { id: "p4", nickname: "선수4", dinoSkin: "yellow", connected: true },
  ];
  const game = createDinoGame(fourRacers, { now: 1000, countdownMs: 0, seed: 10, finishDistance: 500 });
  assert.equal(game.ranking.length, 4, "초기 순위 배열은 4명 모두 포함해야 함");

  game.players[0].dodged = 1;
  game.players[0].bonusScore = 100;
  game.players[0].hp = 3;

  game.players[1].dodged = 5;
  game.players[1].bonusScore = 500;
  game.players[1].hp = 3;

  game.players[2].dodged = 3;
  game.players[2].bonusScore = 250;
  game.players[2].hp = 2;

  game.players[3].distance = 30;
  game.players[3].dodged = 0;
  game.players[3].hp = 0;
  game.players[3].alive = false;

  game.lastTickAt = 1000;
  advanceDinoGame(game, 1050);

  assert.equal(game.ranking.length, 4);
  assert.equal(game.ranking[0], "p2", "1위는 최고 거리/점수 p2");
  assert.equal(game.ranking[1], "p3", "2위는 p3");
  assert.equal(game.ranking[2], "p1", "3위는 p1");
  assert.equal(game.ranking[3], "p4", "4위는 탈락한 p4");

  const pub = publicDinoGame(game, 1050);
  assert.deepEqual(pub.ranking, ["p2", "p3", "p1", "p4"], "공개 상태의 ranking도 일치해야 함");
});



