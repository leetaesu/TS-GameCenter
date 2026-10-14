"use strict";

const SKINS = ["pink", "cyan", "yellow", "violet"];
const MAX_DISTANCE = 1200;
const BASE_SPEED = 26;
const JUMP_MS = 380;
const DUCK_MS = 380;
const STAGE_CHECKPOINTS = [350, 750, 1200, 1750, 2400];
const MAX_STAGES = 5;

function seededRandom(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return function random() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function createObstacles(seed, finishDistance = MAX_DISTANCE) {
  const random = seededRandom(seed);
  const groundKinds = ["cabinet", "cone", "cable", "spikes", "barrel"];
  const airKinds = ["drone", "sign", "laser"];
  const obstacles = [];
  let distance = 42;
  let index = 0;
  let lastZapDistance = -999;
  while (distance < finishDistance - 20) {
    if (distance > 88 && distance - lastZapDistance >= 95 && random() < 0.35) {
      obstacles.push({ id: "obstacle-" + index, distance: Math.round(distance), type: "item", kind: "zap" });
      lastZapDistance = distance;
      distance += 32 + Math.round(random() * 22);
      index += 1;
      continue;
    }
    const type = random() > 0.42 ? "ground" : "air";
    const kinds = type === "ground" ? groundKinds : airKinds;
    obstacles.push({ id: "obstacle-" + index, distance: Math.round(distance), type, kind: kinds[Math.floor(random() * kinds.length)] });
    distance += 38 + Math.round(random() * 28);
    index += 1;
  }
  return obstacles;
}

function createObstaclesForStage(seed, stage, startDist, endDist, startIndex = 0) {
  const random = seededRandom((Number(seed) + stage * 7919) >>> 0);
  const groundKinds = ["cabinet", "cone", "cable", "spikes", "barrel"];
  const airKinds = ["drone", "sign", "laser"];
  const obstacles = [];
  let distance = startDist + 36;
  let index = startIndex;
  let lastZapDistance = startDist;
  const airRatio = Math.min(0.58, 0.38 + stage * 0.05);
  const minSpacing = Math.max(28, 38 - stage * 2);
  while (distance < endDist - 25) {
    if (distance - lastZapDistance >= 90 && random() < 0.35) {
      obstacles.push({
        id: "obstacle-" + index,
        distance: Math.round(distance),
        type: "item",
        kind: "zap",
        stage,
      });
      lastZapDistance = distance;
      distance += minSpacing + Math.round(random() * 20);
      index += 1;
      continue;
    }
    const type = random() < airRatio ? "air" : "ground";
    const kinds = type === "ground" ? groundKinds : airKinds;
    obstacles.push({
      id: "obstacle-" + index,
      distance: Math.round(distance),
      type,
      kind: kinds[Math.floor(random() * kinds.length)],
      stage,
    });
    distance += minSpacing + Math.round(random() * 26);
    index += 1;
  }
  return obstacles;
}

function createDinoGame(players, options = {}) {
  const now = options.now ?? Date.now();
  const countdownMs = options.countdownMs ?? 3000;
  const seed = options.seed ?? ((now ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
  const isCustomFinish = Number.isSafeInteger(options.finishDistance);
  const maxStage = options.maxStage ?? (isCustomFinish ? 1 : MAX_STAGES);
  const stage = options.stage ?? 1;
  const stageGoals = isCustomFinish ? [options.finishDistance] : STAGE_CHECKPOINTS;
  const finishDistance = options.finishDistance ?? (stageGoals[maxStage - 1] || 2400);
  const stageGoal = stageGoals[Math.min(stageGoals.length - 1, stage - 1)];
  const playersList = players.map((player, index) => ({
    id: player.id,
    nickname: player.nickname,
    skin: player.dinoSkin || SKINS[index % SKINS.length],
    connected: player.connected,
    hp: 3,
    alive: true,
    action: "run",
    actionStartedAt: 0,
    actionUntil: 0,
    actionHistory: [],
    lastInputSequence: -1,
    distance: 0,
    score: 0,
    dodged: 0,
    combo: 0,
    maxCombo: 0,
    bonusScore: 0,
    hits: 0,
    lastObstacleIndex: -1,
    finishedAt: null,
  }));
  return {
    kind: "dino",
    roundId: String(options.roundId || seed + "-" + now),
    status: countdownMs > 0 ? "countdown" : "running",
    seed,
    stage,
    maxStage,
    stageGoals,
    stageGoal,
    startedAt: now + countdownMs,
    lastTickAt: now + countdownMs,
    lastCountdownSec: Math.max(1, Math.ceil(countdownMs / 1000)),
    distance: 0,
    speed: BASE_SPEED,
    finishDistance,
    obstacles: createObstacles(seed, stageGoal),
    winnerId: null,
    ranking: playersList.map((p) => p.id),
    actionId: 0,
    lastAction: { type: "started", message: players.length === 1 ? "네온 다이노 연습이 곧 시작됩니다!" : "네온 다이노 레이스가 곧 시작됩니다!" },
    players: playersList,
  };
}

function rankPlayers(game) {
  return game.players.slice().sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (b.distance !== a.distance) return b.distance - a.distance;
    if (b.score !== a.score) return b.score - a.score;
    if (b.hp !== a.hp) return b.hp - a.hp;
    if (b.dodged !== a.dodged) return b.dodged - a.dodged;
    return a.nickname.localeCompare(b.nickname, "ko");
  });
}

function finishGame(game, now) {
  if (game.status === "finished") return;
  game.status = "finished";
  game.ranking = rankPlayers(game).map((player) => player.id);
  const soloFailed = game.players.length === 1 && !game.players[0].alive;
  const allCleared = game.stage >= game.maxStage && game.distance >= game.finishDistance;
  game.winnerId = soloFailed ? null : game.ranking[0] || null;
  game.actionId += 1;
  const winner = game.players.find((player) => player.id === game.winnerId);
  game.lastAction = soloFailed
    ? { type: "finished", playerId: null, message: "연습 종료! STAGE " + game.stage + "에서 탈락했습니다. 다시 도전해 더 멀리 달려보세요." }
    : allCleared
    ? { type: "finished", playerId: game.winnerId, message: "★ ALL STAGES CLEAR! " + (winner ? winner.nickname : "플레이어") + " 전 스테이지 완주 성공! ★" }
    : { type: "finished", playerId: game.winnerId, message: (winner ? winner.nickname : "플레이어") + " 우승! 레이스가 끝났습니다." };
  for (const player of game.players) if (!player.finishedAt) player.finishedAt = now;
}

function setDinoAction(game, playerId, action, now = Date.now(), sequence) {
  if (!game || game.status !== "running") return { ok: false, error: "레이스가 진행 중일 때만 조작할 수 있습니다." };
  const player = game.players.find((item) => item.id === playerId);
  if (!player || !player.alive) return { ok: false, error: "달릴 수 있는 플레이어가 아닙니다." };
  if (Number.isSafeInteger(sequence)) {
    if (sequence <= player.lastInputSequence) return { ok: true, ignored: true };
    player.lastInputSequence = sequence;
  }
  if (action === "jump") {
    if (player.action === "jump" && now < player.actionUntil) return { ok: true, ignored: true, reason: "jump-active" };
    if (player.action === "duck") {
      const activeDuck = player.actionHistory[player.actionHistory.length - 1];
      if (activeDuck?.action === "duck") activeDuck.until = Math.min(activeDuck.until, now);
    }
    player.action = "jump";
    player.actionStartedAt = now;
    player.actionUntil = now + JUMP_MS;
    player.actionHistory.push({ action: "jump", from: now, until: player.actionUntil, sequence: player.lastInputSequence });
  } else if (action === "duck") {
    if (player.action === "jump" && now < player.actionUntil) return { ok: true, ignored: true, reason: "jump-active" };
    player.action = "duck";
    player.actionStartedAt = now;
    player.actionUntil = now + DUCK_MS;
    player.actionHistory.push({ action: "duck", from: now, until: player.actionUntil, sequence: player.lastInputSequence });
  } else if (action === "run") {
    if (player.action === "duck") {
      const activeDuck = player.actionHistory[player.actionHistory.length - 1];
      if (activeDuck?.action === "duck") activeDuck.until = Math.min(activeDuck.until, now);
      player.action = "run";
      player.actionStartedAt = now;
      player.actionUntil = 0;
    }
  } else return { ok: false, error: "지원하지 않는 조작입니다." };
  return { ok: true };
}

function actionAt(player, at) {
  for (let index = player.actionHistory.length - 1; index >= 0; index -= 1) {
    const input = player.actionHistory[index];
    if (input.from <= at && at < input.until) return input.action;
  }
  return "run";
}

function advanceDinoGame(game, now = Date.now()) {
  if (!game || game.status === "finished") return false;
  let changed = false;
  if (game.status === "countdown") {
    const sec = Math.max(0, Math.ceil((game.startedAt - now) / 1000));
    if (game.lastCountdownSec !== sec) {
      game.lastCountdownSec = sec;
      changed = true;
    }
    if (now < game.startedAt) return changed;
    game.status = "running";
    game.lastTickAt = game.startedAt;
    game.actionId += 1;
    game.lastAction = { type: "race-start", message: game.players.length === 1 ? "GO! 연습 주행을 시작합니다." : `GO! 공룡 ${game.players.length}마리가 출발했습니다.` };
    return true;
  }

  const tickStartedAt = game.lastTickAt;
  const previousDistance = game.distance;
  const elapsed = Math.max(0, (now - tickStartedAt) / 1000);
  if (!elapsed) return changed;
  game.lastTickAt = now;
  game.speed = BASE_SPEED + (game.stage - 1) * 3.5 + Math.min(22, game.distance / 38);
  game.distance = Math.min(game.finishDistance, game.distance + game.speed * elapsed);

  for (const player of game.players) {
    if (!player.alive) continue;
    player.distance = game.distance;
    for (let index = player.lastObstacleIndex + 1; index < game.obstacles.length; index += 1) {
      const obstacle = game.obstacles[index];
      if (obstacle.distance > game.distance) break;
      player.lastObstacleIndex = index;

      if (obstacle.destroyed) {
        player.dodged += 1;
        continue;
      }

      if (obstacle.kind === "zap" || obstacle.type === "item") {
        obstacle.destroyed = true;
        player.dodged += 1;
        player.combo = (player.combo || 0) + 2;
        if (player.combo > (player.maxCombo || 0)) player.maxCombo = player.combo;
        player.bonusScore = (player.bonusScore || 0) + 300;

        const blastRange = 140;
        let destroyedCount = 0;
        for (let d = index + 1; d < game.obstacles.length; d += 1) {
          const target = game.obstacles[d];
          if (target.distance > game.distance + blastRange) break;
          if (!target.destroyed && target.kind !== "zap" && target.type !== "item") {
            target.destroyed = true;
            destroyedCount += 1;
          }
        }
        game.actionId += 1;
        game.lastBlast = {
          id: game.actionId,
          at: now,
          playerId: player.id,
          count: destroyedCount,
        };
        game.lastAction = {
          type: "zap-blast",
          playerId: player.id,
          destroyedCount,
          message: `⚡ ${player.nickname} 전기 획득! EMP 폭발로 장애물 ${destroyedCount}개 파괴! 💥`,
        };
        continue;
      }

      const progress = game.distance === previousDistance ? 1 : Math.max(0, Math.min(1, (obstacle.distance - previousDistance) / (game.distance - previousDistance)));
      const crossingAt = tickStartedAt + elapsed * 1000 * progress;
      const crossingAction = actionAt(player, crossingAt);
      const avoided = (obstacle.type === "ground" && crossingAction === "jump") || (obstacle.type === "air" && crossingAction === "duck");
      if (avoided) {
        player.dodged += 1;
        player.combo = (player.combo || 0) + 1;
        if (player.combo > (player.maxCombo || 0)) player.maxCombo = player.combo;
        const comboBonus = Math.min(200, (player.combo - 1) * 25);
        player.bonusScore = (player.bonusScore || 0) + comboBonus;
        game.actionId += 1;
        game.lastAction = {
          type: "dodge",
          playerId: player.id,
          combo: player.combo,
          message: player.combo >= 3 ? `${player.nickname} ${player.combo}연속 회피!` : `${player.nickname} 회피 성공!`
        };
      } else {
        player.combo = 0;
        player.hp -= 1;
        player.hits += 1;
        game.actionId += 1;
        game.lastAction = { type: "hit", playerId: player.id, message: player.nickname + " 충돌! 체력이 1칸 줄었습니다." };
        if (player.hp <= 0) {
          player.hp = 0;
          player.alive = false;
          player.action = "down";
          player.finishedAt = now;
          game.actionId += 1;
          game.lastAction = { type: "knockout", playerId: player.id, message: player.nickname + " 탈락!" };
          break;
        }
      }
    }
    if (player.actionUntil && now >= player.actionUntil) {
      player.action = "run";
      player.actionStartedAt = now;
      player.actionUntil = 0;
    }
    player.actionHistory = player.actionHistory.filter((input) => input.until >= now - 1000);
    player.score = Math.round(player.distance * 10) + player.dodged * 100 + (player.bonusScore || 0);
  }

  game.ranking = rankPlayers(game).map((player) => player.id);

  const alive = game.players.filter((player) => player.alive);
  const anyoneOut = alive.length < game.players.length;

  if (game.distance >= game.stageGoal && game.stage < game.maxStage) {
    const prevGoal = game.stageGoal;
    game.stage += 1;
    game.stageGoal = game.stageGoals[Math.min(game.stageGoals.length - 1, game.stage - 1)];
    const nextObstacles = createObstaclesForStage(game.seed, game.stage, prevGoal, game.stageGoal, game.obstacles.length);
    game.obstacles.push(...nextObstacles);
    for (const player of game.players) {
      if (player.alive) {
        player.hp = Math.min(3, player.hp + 1);
        player.bonusScore = (player.bonusScore || 0) + 500;
      }
    }
    game.actionId += 1;
    game.lastAction = {
      type: "stage-clear",
      stage: game.stage,
      message: `★ STAGE ${game.stage - 1} CLEAR! STAGE ${game.stage} 진입! (SPEED UP + HP 회복) ★`,
    };
    changed = true;
  }

  if ((anyoneOut && alive.length <= 1) || game.distance >= game.finishDistance) finishGame(game, now);
  return true;
}

function publicDinoGame(game, now = Date.now()) {
  if (!game) return null;
  return {
    kind: "dino",
    roundId: game.roundId,
    status: game.status,
    stage: game.stage || 1,
    maxStage: game.maxStage || 1,
    stageGoal: game.stageGoal || game.finishDistance,
    startedAt: game.startedAt,
    countdown: game.status === "countdown" ? Math.max(1, Math.ceil((game.startedAt - now) / 1000)) : 0,
    distance: Math.round(game.distance),
    speed: Number((game.speed / BASE_SPEED).toFixed(1)),
    finishDistance: game.finishDistance,
    winnerId: game.winnerId,
    ranking: game.ranking,
    actionId: game.actionId,
    lastBlast: game.lastBlast || null,
    lastAction: game.lastAction,
    obstacles: game.obstacles.filter((obstacle) => obstacle.distance >= game.distance - 25 && obstacle.distance <= game.distance + 220).map((obstacle) => ({
      id: obstacle.id,
      type: obstacle.type,
      kind: obstacle.kind,
      distance: obstacle.distance,
      offset: Math.round(obstacle.distance - game.distance),
      destroyed: Boolean(obstacle.destroyed),
    })),
    players: game.players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      skin: player.skin,
      connected: player.connected,
      hp: player.hp,
      alive: player.alive,
      action: player.action,
      combo: player.combo || 0,
      maxCombo: player.maxCombo || 0,
      distance: Math.round(player.distance),
      score: player.score,
      dodged: player.dodged,
      hits: player.hits,
    })),
  };
}

module.exports = { SKINS, MAX_DISTANCE, BASE_SPEED, createObstacles, createDinoGame, setDinoAction, advanceDinoGame, publicDinoGame, rankPlayers };

