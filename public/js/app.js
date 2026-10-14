(function () {
  "use strict";

  var socket = null;
  var room = null;
  var selectedGame = "bell";
  var serverInfo = { lanUrls: [], networks: [] };
  var reconnectTimer = null;
  var intentionalClose = false;
  var lastActionId = -1;
  var toastTimer = null;
  var audioContext = null;
  var soundOn = localStorage.getItem("ts-arcade-sound") !== "off";
  var duckHeld = false;
  var duckPointerId = null;
  var dinoInputSequence = 0;
  var lastLeaderId = null;
  var lastSelfHp = null;
  var nicknameInput = document.getElementById("nicknameInput");
  var roomCodeInput = document.getElementById("roomCodeInput");
  var connectionLabel = document.getElementById("connectionLabel");

  nicknameInput.value = localStorage.getItem("ts-arcade-nickname") || "";
  updateSoundButton();

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function showToast(message, isError) {
    var toast = document.getElementById("toast");
    toast.textContent = message; toast.classList.toggle("is-error", Boolean(isError)); toast.classList.add("is-visible");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toast.classList.remove("is-visible"); }, 2600);
  }
  function tone(kind) {
    if (!soundOn) return;
    try {
      audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
      var now = audioContext.currentTime; var oscillator = audioContext.createOscillator(); var gain = audioContext.createGain();
      oscillator.connect(gain); gain.connect(audioContext.destination);
      var settings = { click: [220, 0.04, "square"], flip: [360, 0.06, "square"], bell: [880, 0.22, "sine"], jump: [420, 0.08, "square"], dodge: [560, 0.08, "triangle"], combo: [780, 0.14, "sine"], blast: [380, 0.35, "sawtooth"], hit: [100, 0.18, "sawtooth"], success: [660, 0.35, "square"], error: [120, 0.28, "sawtooth"] }[kind] || [300, 0.05, "square"];
      oscillator.type = settings[2]; oscillator.frequency.setValueAtTime(settings[0], now);
      if (kind === "dodge") oscillator.frequency.exponentialRampToValueAtTime(840, now + settings[1]);
      if (kind === "combo") oscillator.frequency.exponentialRampToValueAtTime(1150, now + settings[1]);
      if (kind === "blast") oscillator.frequency.exponentialRampToValueAtTime(55, now + settings[1]);
      if (kind === "success") oscillator.frequency.exponentialRampToValueAtTime(1320, now + settings[1]);
      if (kind === "bell") oscillator.frequency.exponentialRampToValueAtTime(420, now + settings[1]);
      gain.gain.setValueAtTime(0.1, now); gain.gain.exponentialRampToValueAtTime(0.001, now + settings[1]); oscillator.start(now); oscillator.stop(now + settings[1]);
    } catch (_) {}
  }
  function updateSoundButton() {
    var button = document.querySelector('[data-action="toggle-sound"]');
    button.setAttribute("aria-pressed", String(soundOn)); button.querySelector("span").textContent = soundOn ? "ON" : "OFF";
  }
  function setScreen(name) {
    if (name !== "game") stopDinoLoop();
    var active = document.querySelector("[data-screen].is-active");
    var changed = !active || active.getAttribute("data-screen") !== name;
    document.querySelectorAll("[data-screen]").forEach(function (screen) { screen.classList.toggle("is-active", screen.getAttribute("data-screen") === name); });
    if (name === "game") {
      document.body.classList.add("game-locked");
      document.documentElement.classList.add("game-locked");
    } else {
      document.body.classList.remove("game-locked");
      document.documentElement.classList.remove("game-locked");
    }
    if (changed) window.scrollTo({ top: 0, behavior: "instant" });
  }
  function tokenKey(code) { return "ts-arcade-room-" + code; }
  function send(type, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) { showToast("서버와 다시 연결 중입니다. 잠시 후 눌러주세요.", true); return false; }
    socket.send(JSON.stringify(Object.assign({ type: type }, payload || {}))); return true;
  }
  function sendDinoInput(type, payload) {
    if (!room || !room.game) return false;
    dinoInputSequence += 1;
    return send(type, Object.assign({ sequence: dinoInputSequence, roundId: room.game.roundId }, payload || {}));
  }
  function sendBellInput(type) {
    if (!room || !room.game) return false;
    return send(type, { roundId: room.game.roundId, tableRevision: room.game.tableRevision });
  }
  function connect() {
    clearTimeout(reconnectTimer);
    var protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(protocol + "//" + location.host + "/ws"); connectionLabel.textContent = "CONNECTING";
    socket.addEventListener("open", function () {
      connectionLabel.textContent = "LOCAL CONNECT"; connectionLabel.style.color = "";
      if (room) send("join-room", { roomCode: room.code, nickname: localStorage.getItem("ts-arcade-nickname") || "동네 게이머", token: sessionStorage.getItem(tokenKey(room.code)) });
      else if (requestedRoom && sessionStorage.getItem(tokenKey(requestedRoom))) send("join-room", { roomCode: requestedRoom, nickname: localStorage.getItem("ts-arcade-nickname") || "동네 게이머", token: sessionStorage.getItem(tokenKey(requestedRoom)) });
    });
    socket.addEventListener("message", function (event) {
      var data; try { data = JSON.parse(event.data); } catch (_) { return; }
      if (data.type === "welcome") { sessionStorage.setItem(tokenKey(data.roomCode), data.token); history.replaceState(null, "", "/?room=" + encodeURIComponent(data.roomCode)); return; }
      if (data.type === "room-state") {
        var oldStatus = room && room.status; room = data.room; selectedGame = room.gameType;
        if (room.gameType === "dino" && room.game) {
          var ownRacer = room.game.players.find(function (player) { return player.id === room.selfId; });
          var currentLeader = room.game.players.slice().sort(function (a, b) { return b.score - a.score || b.hp - a.hp; })[0];
          if (room.game.status === "running" && lastLeaderId && currentLeader && currentLeader.id !== lastLeaderId) showToast("NEW LEADER! " + currentLeader.nickname);
          if (lastSelfHp !== null && ownRacer && ownRacer.hp < lastSelfHp) {
            document.body.classList.add("dino-hit-flash"); setTimeout(function () { document.body.classList.remove("dino-hit-flash"); }, 180);
          }
          lastLeaderId = currentLeader ? currentLeader.id : null; lastSelfHp = ownRacer ? ownRacer.hp : null;
        } else { lastLeaderId = null; lastSelfHp = null; }
        if (room.game && room.game.actionId !== lastActionId) {
          if (lastActionId >= 0 && room.game.lastAction) {
            var action = room.game.lastAction;
            if (["hit", "knockout", "wrong-bell"].indexOf(action.type) >= 0) tone("hit");
            else if (["finished", "correct-bell"].indexOf(action.type) >= 0) tone("success");
            else if (action.type === "flip") tone("flip");
            if (action.type !== "race-start") showToast(action.message, ["hit", "knockout", "wrong-bell"].indexOf(action.type) >= 0);
            if (action.type === "correct-bell" || action.type === "wrong-bell") {
              var bellClass = action.type === "correct-bell" ? "bell-correct-flash" : "bell-wrong-flash";
              document.body.classList.add(bellClass);
              setTimeout(function () { document.body.classList.remove(bellClass); }, 220);
            }
          }
          lastActionId = room.game.actionId;
        }
        if (room.status === "game") { if (room.gameType === "dino") renderDinoGame(); else renderBellGame(); }
        else { if (room.gameType === "dino") renderDinoLobby(); else renderBellLobby(); }
        if (oldStatus === "lobby" && room.status === "game") tone("success");
        return;
      }
      if (data.type === "left-room") { room = null; requestedRoom = null; lastActionId = -1; lastLeaderId = null; lastSelfHp = null; history.replaceState(null, "", "/"); setScreen("home"); return; }
      if (data.type === "error") { showToast(data.message, true); tone("error"); }
    });
    socket.addEventListener("close", function () { connectionLabel.textContent = "RECONNECT"; connectionLabel.style.color = "#ff8f8a"; if (!intentionalClose) reconnectTimer = setTimeout(connect, 1200); });
  }
  function nickname() {
    var value = nicknameInput.value.trim() || "동네 게이머"; nicknameInput.value = value; localStorage.setItem("ts-arcade-nickname", value); return value;
  }
  function inviteUrl() {
    var stored = localStorage.getItem("ts-arcade-lan-url");
    var base = stored && serverInfo.lanUrls.indexOf(stored) >= 0 ? stored : serverInfo.lanUrls[0];
    return base ? base.replace(/\/+$/, "") + "/?room=" + encodeURIComponent(room.code) : "";
  }
  function copyText(text, success) {
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { showToast(success); }).catch(function () { fallbackCopy(text, success); });
    else fallbackCopy(text, success);
  }
  function fallbackCopy(text, success) {
    var area = document.createElement("textarea"); area.value = text; area.style.position = "fixed"; area.style.opacity = "0"; document.body.appendChild(area); area.select();
    try { document.execCommand("copy"); showToast(success); } catch (_) { showToast("복사하지 못했습니다.", true); } area.remove();
  }
  function avatarIcon(name) { return { joystick: "🕹", alien: "👾", rocket: "🚀", ghost: "👻" }[name] || "🕹"; }
  function lobbyFrame(title, subtitle, body, footer) {
    document.getElementById("lobbyContent").innerHTML = '<div class="room-toolbar"><button class="back-button" type="button" data-action="leave-room">← TS 게임센터로 돌아가기</button><div class="room-code">ROOM <b>#TS-' + escapeHtml(room.code) + '</b></div><span class="network-pill"><i></i> LAN SYNC ACTIVE</span></div><div class="room-heading"><h1 id="lobbyTitle">' + title + "</h1><span>" + subtitle + "</span></div>" + body + footer;
    setScreen("lobby");
  }
  function inviteCard(gameText) {
    var url = inviteUrl();
    var qr = ""; try { qr = url && window.TSQRCode ? window.TSQRCode.svg(url) : ""; } catch (_) {}
    var choices = (serverInfo.networks || []).map(function (network) { return '<option value="' + escapeHtml(network.url) + '" ' + (url.indexOf(network.url) === 0 ? "selected" : "") + ">" + escapeHtml(network.name + " · " + network.address) + "</option>"; }).join("");
    var networkPicker = choices ? '<label class="network-picker">휴대폰 접속망<select id="lanAddressSelect">' + choices + "</select></label>" : '<p class="network-warning">LAN 주소를 찾지 못했습니다. 방화벽과 Wi-Fi 연결을 확인하세요.</p>';
    return '<aside class="invite-card"><div class="invite-card__label">SMARTPHONE INSTANT CONNECT</div>' + (qr ? '<div class="invite-qr">' + qr + "</div>" : '<div class="invite-code">' + escapeHtml(room.code) + "</div>") + '<h2>같은 Wi-Fi에서 접속</h2><p>QR을 스캔하거나 아래 주소를 여세요.<br>대체 입장 코드 <b>TS-' + escapeHtml(room.code) + "</b></p>" + networkPicker + '<div class="invite-link" title="' + escapeHtml(url) + '">' + escapeHtml(url || "LAN 주소를 찾지 못했습니다") + '</div><p class="invite-game">' + gameText + '</p><div class="invite-actions"><button class="button button--cyan" type="button" data-action="copy-link" ' + (url ? "" : "disabled") + '>주소 복사</button><button class="button button--ghost" type="button" data-action="copy-code">코드 복사</button></div></aside>';
  }
  function basicProfile(self, isHost) {
    return '<section class="profile-panel"><h3>내 프로필</h3><div class="profile-edit"><input id="lobbyNickname" maxlength="12" value="' + escapeHtml(self ? self.nickname : "") + '" aria-label="닉네임 변경"><button class="button button--ghost" type="button" data-action="save-nickname">변경</button></div><button class="button button--cyan ready-button" type="button" data-action="toggle-ready" ' + (isHost ? "disabled" : "") + ">" + (isHost ? "방장 준비 완료" : self && self.ready ? "준비 취소" : "준비 완료") + "</button></section>";
  }
  function lobbyFooter(rule, allReady, isHost, label) {
    return '<section class="rules-bar"><div><strong>GAME RULES</strong><p>' + rule + "</p></div>" + (isHost ? '<button class="button button--pink start-match" type="button" data-action="start-game" ' + (allReady ? "" : "disabled") + ">" + label + "</button>" : '<button class="button button--ghost start-match" type="button" disabled>방장이 시작하기를 기다리는 중</button>') + "</section>";
  }

  function renderBellLobby() {
    var self = room.players.find(function (p) { return p.id === room.selfId; }); var connected = room.players.filter(function (p) { return p.connected; });
    var allReady = connected.length >= 2 && connected.every(function (p) { return p.ready; }); var isHost = room.selfId === room.hostId; var slots = room.players.slice(); while (slots.length < 4) slots.push(null);
    var players = slots.map(function (player, index) {
      if (!player) return '<article class="player-slot is-empty"><div class="player-slot__avatar">＋</div><div><strong>' + (index + 1) + "P 빈 자리</strong><span>플레이어 대기 중...</span></div></article>";
      return '<article class="player-slot ' + (player.id === room.selfId ? "is-self" : "") + '"><div class="player-slot__avatar">' + avatarIcon(player.avatar) + "</div><div><strong>" + escapeHtml((index + 1) + "P " + player.nickname + (player.id === room.selfId ? " (나)" : "")) + "</strong><span>" + (player.host ? "방장 · " : "") + (player.connected ? (player.ready ? "준비 완료 READY" : "준비 중...") : "연결 끊김") + "</span></div></article>";
    }).join("");
    var body = '<div class="lobby-grid">' + inviteCard("같은 과일 합계가 정확히 5개면 종을 누르세요!") + '<div><section class="players-panel"><div class="players-panel__top"><span>PARTICIPANTS</span><b>' + connected.length + " / 4 PLAYERS</b></div><div class=\"player-grid\">" + players + "</div></section>" + basicProfile(self, isHost) + "</div></div>";
    lobbyFrame("과일폭풍 종치기 대기실", "FRUIT BELL BATTLE", body, lobbyFooter("같은 과일의 합이 정확히 <strong>5개</strong>면 누구보다 먼저 종을 누르세요. 오답이면 상대에게 카드를 줍니다.", allReady, isHost, "게임 시작 (START MATCH)"));
  }

  var skinNames = { pink: "핫핑크", cyan: "전기 청록", yellow: "아케이드 옐로", violet: "네온 바이올렛" };
  function dinoAvatar(skin, small) { return '<span class="pixel-dino skin-' + skin + (small ? " is-small" : "") + '"><i></i><b></b><em></em></span>'; }
  function renderDinoLobby() {
    var self = room.players.find(function (p) { return p.id === room.selfId; }); var connected = room.players.filter(function (p) { return p.connected; });
    var allReady = connected.length >= 1 && connected.every(function (p) { return p.ready; }); var isHost = room.selfId === room.hostId;
    var cards = room.players.map(function (player, index) {
      return '<article class="dino-player-card skin-border-' + player.dinoSkin + " " + (player.id === room.selfId ? "is-self" : "") + '"><small>' + (player.host ? "HOST" : (index + 1) + "P") + "</small>" + dinoAvatar(player.dinoSkin) + "<div><strong>" + escapeHtml(player.nickname + (player.id === room.selfId ? " (나)" : "")) + "</strong><span>" + skinNames[player.dinoSkin] + "</span><b>" + (player.ready ? "READY" : "WAITING") + "</b></div></article>";
    }).join("");
    while ((cards.match(/dino-player-card/g) || []).length < 4) cards += '<article class="dino-player-card is-empty"><span class="empty-dino">?</span><div><strong>빈 자리</strong><span>친구를 기다리는 중</span></div></article>';
    var used = room.players.map(function (p) { return p.dinoSkin; });
    var skins = Object.keys(skinNames).map(function (skin) { var disabled = used.indexOf(skin) >= 0 && self && self.dinoSkin !== skin; return '<button class="skin-choice skin-' + skin + ' ' + (self && self.dinoSkin === skin ? "is-selected" : "") + '" type="button" data-action="set-dino-skin" data-skin="' + skin + '" ' + (disabled ? "disabled" : "") + ' aria-label="' + skinNames[skin] + '">' + dinoAvatar(skin, true) + "</button>"; }).join("");
    var body = '<div class="lobby-grid dino-lobby-grid">' + inviteCard("점프하고 숙여서 마지막까지 살아남으세요!") + '<div><section class="players-panel dino-players"><div class="players-panel__top"><span>RACERS</span><b>' + connected.length + " / 4 PLAYERS</b></div><div class=\"dino-player-grid\">" + cards + '</div></section><section class="profile-panel dino-profile"><h3>공룡 & 프로필 설정</h3><div class="skin-choices">' + skins + '</div><div class="profile-edit"><input id="lobbyNickname" maxlength="12" value="' + escapeHtml(self ? self.nickname : "") + '" aria-label="닉네임 변경"><button class="button button--ghost" type="button" data-action="save-nickname">변경</button></div><button class="button button--cyan ready-button" type="button" data-action="toggle-ready" ' + (isHost ? "disabled" : "") + ">" + (isHost ? "방장 준비 완료" : self && self.ready ? "준비 취소" : "준비 완료") + "</button></section></div></div>";
    lobbyFrame("네온 다이노 런 대기실", "NEON DINO RUN '94 · 1P PRACTICE / 2~4P LOCAL RACE", body, lobbyFooter("혼자서는 연습 모드, 2~4명은 대전 모드입니다. 체력은 <strong>3칸</strong>. 낮은 장애물은 점프하고 공중 장애물은 숙이세요.", allReady, isHost, connected.length === 1 ? "혼자 연습 시작 (PRACTICE)" : "레이스 시작 (START RACE)"));
  }

  var fruitMeta = { strawberry: ["🍓", "딸기"], banana: ["🍌", "바나나"], lime: ["🍋", "라임"], plum: ["🍑", "자두"] };
  function renderBellGame() {
    setScreen("game"); var game = room.game; if (!game) return;
    var self = game.players.find(function (p) { return p.id === room.selfId; }); var winner = game.players.find(function (p) { return p.id === game.winnerId; }); var isHost = room.selfId === room.hostId;
    var canFlip = game.status === "playing" && game.turnId === room.selfId && self && self.cards > 0;
    var players = game.players.map(function (player) { var card = player.faceUp; return '<article class="bell-seat ' + (player.id === room.selfId ? "is-self" : "") + " " + (player.id === game.turnId ? "is-turn" : "") + " " + (!player.connected ? "is-disconnected" : "") + '"><header><strong>' + escapeHtml(player.nickname) + (player.id === room.selfId ? " (나)" : "") + "</strong><span>카드 " + player.cards + "장</span></header><div class=\"bell-card\" aria-label=\"" + (card ? fruitMeta[card.fruit][1] + " " + card.value + "개" : "공개 카드 없음") + "\">" + (card ? new Array(card.value + 1).join("<span aria-hidden=\"true\">" + fruitMeta[card.fruit][0] + "</span>") : "CARD READY") + "</div>" + (!player.connected ? '<div class="bell-seat__status">재접속 중...</div>' : "") + "</article>"; }).join("");
    var totals = Object.keys(fruitMeta).map(function (fruit) { return '<div class="fruit-total ' + (game.counts[fruit] === 5 ? "is-five" : "") + '"><span>' + fruitMeta[fruit][0] + " " + fruitMeta[fruit][1] + "</span><b>" + game.counts[fruit] + "개</b></div>"; }).join("");
    document.getElementById("gameContent").innerHTML = '<div class="game-toolbar"><button class="back-button" type="button" data-action="leave-room">← 게임센터 나가기</button><div class="game-toolbar__meta"><span>ROOM <b>#TS-' + escapeHtml(room.code) + '</b></span><span>PLAYERS <b>' + game.players.length + 'P</b></span></div><span class="game-toolbar__sync">● WI-FI SYNC</span></div><section class="arena" aria-labelledby="gameTitle"><div class="rule-strip"><span id="gameTitle"><b>RULE</b> 같은 과일이 정확히 <b>5개</b>면 종을 치세요!</span><span>오답: 상대에게 카드 1장씩</span></div><div class="bell-grid">' + players + '</div><div class="bell-controls"><button class="button button--cyan" type="button" data-action="flip-card" aria-label="내 차례 카드 뒤집기" ' + (canFlip ? "" : "disabled") + '>카드 뒤집기 <small>F</small></button><button class="bell" type="button" data-action="ring-bell" aria-label="종 치기" ' + (game.status !== "playing" || game.bellOpen === false ? "disabled" : "") + '>🔔<small>SPACE / TAP</small></button></div><div class="bell-log" role="status" aria-live="polite">' + escapeHtml(game.lastAction ? game.lastAction.message : "게임 준비") + "</div>" + (game.status === "finished" ? '<div class="result-panel" role="dialog" aria-modal="true" aria-labelledby="bellResultTitle"><div><h2 id="bellResultTitle">GAME SET!</h2><p><strong>' + escapeHtml(winner ? winner.nickname : "플레이어") + "</strong> 님이 우승했습니다.</p>" + (isHost ? '<button class="button button--pink" type="button" data-action="bell-rematch">다시 한 판</button><button class="button button--cyan" type="button" data-action="return-lobby">대기실로 돌아가기</button>' : '<button class="button button--ghost" disabled>방장을 기다리는 중</button>') + '<button class="button button--ghost" type="button" data-action="leave-room">TS 게임센터로 나가기</button></div></div>' : "") + '</section><section class="fruit-totals" aria-label="공개된 과일 합계">' + totals + "</section>";
  }

  function hearts(count) { var value = ""; for (var i = 0; i < 3; i += 1) value += '<span class="heart ' + (i >= count ? "is-empty" : "") + '">♥</span>'; return value; }

  var dinoIcons = { cabinet: "▥", cone: "▲", cable: "〰", spikes: "⩚", barrel: "🛢", zap: "⚡", drone: "◆", sign: "▰", laser: "━" };
  var dinoAnimId = null;
  var dinoMountedRound = null;
  var dinoLastServerTime = 0;
  var dinoServerDist = 0;
  var dinoCurrentSpeed = 26;
  var lastDinoStage = 0;
  var lastBlastHandledId = null;

  function stopDinoLoop() {
    if (dinoAnimId) { cancelAnimationFrame(dinoAnimId); dinoAnimId = null; }
    dinoMountedRound = null;
    lastDinoStage = 0;
    lastBlastHandledId = null;
  }

  function renderObstacleGraphic(kind, type) {
    if (kind === "spikes") {
      return '<svg viewBox="0 0 44 30" class="obs-art obs-spikes-art"><rect x="0" y="25" width="44" height="5" fill="#ff1744" rx="1"/><polygon points="3,25 10,4 17,25" fill="#ff3d71"/><polygon points="17,25 24,0 31,25" fill="#ff1744"/><polygon points="30,25 37,4 44,25" fill="#ff3d71"/><polygon points="9,25 10,5 13,25" fill="#ffffff" opacity="0.6"/><polygon points="23,25 24,2 27,25" fill="#ffffff" opacity="0.6"/><polygon points="36,25 37,5 40,25" fill="#ffffff" opacity="0.6"/></svg>';
    }
    if (kind === "barrel") {
      return '<svg viewBox="0 0 32 38" class="obs-art obs-barrel-art"><rect x="2" y="3" width="28" height="32" rx="3" fill="#08200e" stroke="#39ff14" stroke-width="2"/><line x1="2" y1="12" x2="30" y2="12" stroke="#39ff14" stroke-width="2"/><line x1="2" y1="23" x2="30" y2="23" stroke="#39ff14" stroke-width="2"/><ellipse cx="16" cy="3" rx="14" ry="3" fill="#39ff14"/><circle cx="16" cy="18" r="4.5" fill="#39ff14"/><polygon points="16,13 13,9 19,9" fill="#08200e"/><polygon points="12,19 8,15 10,21" fill="#08200e"/><polygon points="20,19 24,15 22,21" fill="#08200e"/></svg>';
    }
    if (kind === "cone") {
      return '<svg viewBox="0 0 32 38" class="obs-art obs-cone-art"><rect x="2" y="32" width="28" height="5" rx="1" fill="#ff6d00"/><polygon points="16,4 5,32 27,32" fill="#ff9100"/><polygon points="16,12 9,23 23,23" fill="#ffffff" opacity="0.95"/><circle cx="16" cy="4" r="3.5" fill="#ff1744"/><circle cx="16" cy="4" r="1.5" fill="#ffffff"/></svg>';
    }
    if (kind === "cabinet") {
      return '<svg viewBox="0 0 34 42" class="obs-art obs-cabinet-art"><path d="M4,42 L4,4 L26,4 L32,13 L28,24 L32,42 Z" fill="#151226" stroke="#00f0ff" stroke-width="2"/><rect x="7" y="6" width="17" height="6" fill="#ff007f"/><rect x="7" y="15" width="17" height="13" rx="2" fill="#002b36" stroke="#00f0ff" stroke-width="1.2"/><line x1="9" y1="19" x2="22" y2="19" stroke="#00f0ff" stroke-width="1.5"/><circle cx="12" cy="33" r="2.5" fill="#ffd600"/><circle cx="19" cy="33" r="2" fill="#ff007f"/></svg>';
    }
    if (kind === "cable") {
      return '<svg viewBox="0 0 46 26" class="obs-art obs-cable-art"><rect x="0" y="17" width="13" height="8" rx="2" fill="#222" stroke="#ffaa00" stroke-width="1"/><rect x="33" y="17" width="13" height="8" rx="2" fill="#222" stroke="#ffaa00" stroke-width="1"/><path d="M12,20 Q23,5 34,20" fill="none" stroke="#ff9100" stroke-width="3"/><polygon points="21,11 25,5 23,13 27,7 24,17" fill="#00f0ff"/></svg>';
    }
    if (kind === "drone") {
      return '<svg viewBox="0 0 46 32" class="obs-art obs-drone-art"><line x1="2" y1="6" x2="16" y2="6" stroke="#00f0ff" stroke-width="2.5"/><line x1="30" y1="6" x2="44" y2="6" stroke="#00f0ff" stroke-width="2.5"/><path d="M10,8 L16,15 L30,15 L36,8" fill="none" stroke="#666" stroke-width="2"/><rect x="15" y="12" width="16" height="12" rx="3" fill="#12121c" stroke="#ff0055" stroke-width="1.5"/><circle cx="23" cy="18" r="3.5" fill="#ff0055"/><circle cx="24" cy="17" r="1.2" fill="#ffffff"/></svg>';
    }
    if (kind === "laser") {
      return '<svg viewBox="0 0 68 22" class="obs-art obs-laser-art"><rect x="0" y="3" width="9" height="16" rx="2" fill="#1a0010" stroke="#ff0055" stroke-width="1.5"/><line x1="9" y1="11" x2="59" y2="11" stroke="#ff0055" stroke-width="4"/><line x1="9" y1="11" x2="59" y2="11" stroke="#ffffff" stroke-width="1.5"/><rect x="59" y="3" width="9" height="16" rx="2" fill="#1a0010" stroke="#ff0055" stroke-width="1.5"/><circle cx="4.5" cy="11" r="2.5" fill="#ff0055"/><circle cx="63.5" cy="11" r="2.5" fill="#ff0055"/></svg>';
    }
    if (kind === "sign") {
      return '<svg viewBox="0 0 52 30" class="obs-art obs-sign-art"><line x1="12" y1="0" x2="12" y2="8" stroke="#888" stroke-width="1.5"/><line x1="40" y1="0" x2="40" y2="8" stroke="#888" stroke-width="1.5"/><rect x="2" y="8" width="48" height="20" rx="3" fill="#1c0e2d" stroke="#ff007f" stroke-width="2"/><text x="26" y="22" font-size="9" font-weight="900" font-family="Consolas,monospace" text-anchor="middle" fill="#ffe43b" letter-spacing="1">DANGER</text></svg>';
    }
    if (kind === "zap") {
      return '<svg viewBox="0 0 36 36" class="obs-art obs-zap-art"><circle cx="18" cy="18" r="16" fill="rgba(0,240,255,0.22)" stroke="#00f0ff" stroke-width="2" stroke-dasharray="4 2"/><polygon points="21,5 11,18 18,18 15,31 26,16 19,16" fill="#ffe43b" stroke="#ffffff" stroke-width="1.2"/><circle cx="18" cy="18" r="16.5" fill="none" stroke="#ffe43b" stroke-width="1" opacity="0.6"/></svg>';
    }
    return dinoIcons[kind] || "▲";
  }

  function obstacleElement(obs) {
    var isDestroyed = obs.destroyed ? " is-destroyed" : "";
    return '<span class="dino-obstacle obstacle-' + obs.type + ' obstacle-' + obs.kind + isDestroyed + '" data-obs-id="' + obs.id + '" data-dist="' + obs.distance + '" title="' + obs.kind + '">' + renderObstacleGraphic(obs.kind, obs.type) + '</span>';
  }

  function syncObstacles(layerEl, obstacles) {
    if (!layerEl) return;
    var existing = {};
    var children = layerEl.children;
    for (var i = children.length - 1; i >= 0; i -= 1) {
      var child = children[i];
      var id = child.getAttribute("data-obs-id");
      if (id) existing[id] = child;
    }
    var activeIds = {};
    for (var j = 0; j < obstacles.length; j += 1) {
      var obs = obstacles[j];
      activeIds[obs.id] = true;
      var el = existing[obs.id];
      if (!el) {
        var temp = document.createElement("div");
        temp.innerHTML = obstacleElement(obs);
        layerEl.appendChild(temp.firstElementChild);
      } else {
        el.setAttribute("data-dist", obs.distance);
        if (obs.destroyed) {
          el.classList.add("is-destroyed");
        }
      }
    }
    for (var k in existing) {
      if (!activeIds[k]) existing[k].remove();
    }
  }

  function dinoLane(player, index, game) {
    var obsMarkup = game.obstacles.map(obstacleElement).join("");
    return '<article class="dino-lane skin-border-' + player.skin + " " + (player.id === room.selfId ? "is-self" : "") + " " + (!player.alive ? "is-out" : "") + '" data-player-id="' + player.id + '" data-dodged="' + (player.dodged || 0) + '"><div class="lane-meta"><b>' + (index + 1) + "P " + escapeHtml(player.nickname) + '</b><span class="lane-hearts" data-hp="' + player.hp + '">' + hearts(player.hp) + '</span><strong class="lane-dist">' + player.distance + 'm</strong></div><div class="race-strip"><div class="city-silhouette"></div><div class="road-lines"></div>' + dinoAvatar(player.skin) + '<span class="runner-state state-' + player.action + '">' + (player.action === "jump" ? "JUMP!" : player.action === "duck" ? "DUCK!" : "") + '</span><div class="obstacles-layer">' + obsMarkup + '</div><span class="lane-status" style="' + (!player.connected || !player.alive ? "" : "display:none") + '">' + (!player.connected ? "재접속 중..." : !player.alive ? "GAME OVER" : "") + "</span></div></article>";
  }

  function startDinoLoop() {
    if (dinoAnimId) cancelAnimationFrame(dinoAnimId);
    function tick() {
      if (!room || room.status !== "game" || room.gameType !== "dino" || !room.game) {
        dinoAnimId = null;
        return;
      }
      var now = performance.now();
      var elapsed = Math.max(0, (now - dinoLastServerTime) / 1000);
      var currentDist = dinoServerDist;
      if (room.game.status === "running") {
        currentDist = Math.min(room.game.finishDistance, dinoServerDist + dinoCurrentSpeed * elapsed);
      }
      var distEl = document.getElementById("dinoDistValue");
      if (distEl) distEl.textContent = Math.round(currentDist) + "m";

      var countdownBox = document.getElementById("dinoCountdownBox");
      if (countdownBox && room.game) {
        if (room.game.status === "countdown") {
          var remainingMs = Math.max(0, (room.game.startedAt || (Date.now() + 3000)) - Date.now());
          var sec = Math.max(1, Math.ceil(remainingMs / 1000));
          var curSec = countdownBox.getAttribute("data-sec");
          if (curSec !== String(sec)) {
            countdownBox.setAttribute("data-sec", String(sec));
            countdownBox.innerHTML = '<div class="race-countdown"><b class="count-pop" data-sec="' + sec + '">' + sec + '</b><span>GET READY</span></div>';
            tone("flip");
          }
        } else if (room.game.status === "running") {
          var runSince = Date.now() - (room.game.startedAt || Date.now());
          if (runSince < 800) {
            if (countdownBox.getAttribute("data-sec") !== "go") {
              countdownBox.setAttribute("data-sec", "go");
              countdownBox.innerHTML = '<div class="race-countdown is-go"><b class="go-pop">GO!</b><span>START RACING!</span></div>';
              tone("success");
            }
          } else if (countdownBox.getAttribute("data-sec") !== "done") {
            countdownBox.setAttribute("data-sec", "done");
            countdownBox.innerHTML = "";
          }
        } else {
          countdownBox.innerHTML = "";
        }
      }

      var roadOffset = -(currentDist * 32) % 42;
      var cityOffset = -(currentDist * 8) % 73;
      var roads = document.querySelectorAll(".road-lines");
      for (var r = 0; r < roads.length; r += 1) roads[r].style.backgroundPositionX = roadOffset + "px";
      var cities = document.querySelectorAll(".city-silhouette");
      for (var c = 0; c < cities.length; c += 1) cities[c].style.backgroundPositionX = cityOffset + "px";

      var DINO_X = 10;
      var VIEW_SPAN = 70;
      var obstacles = document.querySelectorAll(".dino-obstacle");
      for (var i = 0; i < obstacles.length; i += 1) {
        var el = obstacles[i];
        var dist = parseFloat(el.getAttribute("data-dist"));
        if (!isNaN(dist)) {
          var rel = dist - currentDist;
          var left = DINO_X + (rel / VIEW_SPAN) * 88;
          if (left < -15 || left > 105) {
            el.style.display = "none";
          } else {
            el.style.display = "block";
            el.style.left = left.toFixed(2) + "%";
          }
        }
      }
      dinoAnimId = requestAnimationFrame(tick);
    }
    dinoAnimId = requestAnimationFrame(tick);
  }

  function renderDinoGame() {
    setScreen("game"); var game = room.game; if (!game) return;
    var isHost = room.selfId === room.hostId; var self = game.players.find(function (p) { return p.id === room.selfId; });
    var leader = game.players.slice().sort(function (a, b) { return b.score - a.score; })[0];
    var latency = Math.max(0, Date.now() - (room.serverTime || Date.now()));
    var controlsLocked = !self || !self.alive || game.status !== "running";
    var midair = self && self.action === "jump";
    var isDucking = self && self.action === "duck";

    dinoCurrentSpeed = (game.speed || 1) * 26;
    dinoServerDist = game.distance;
    dinoLastServerTime = performance.now();

    if (game.stage && lastDinoStage && game.stage > lastDinoStage) {
      tone("success");
      var arenaEl = document.querySelector(".dino-arena");
      if (arenaEl) {
        var banner = document.createElement("div");
        banner.className = "stage-clear-banner";
        banner.innerHTML = "<b>★ STAGE " + lastDinoStage + " CLEAR! ★</b><span>STAGE " + game.stage + " START · SPEED UP!</span>";
        arenaEl.appendChild(banner);
        setTimeout(function () { banner.remove(); }, 2000);
      }
    }
    lastDinoStage = game.stage || 1;

    if (game.lastBlast && game.lastBlast.id !== lastBlastHandledId) {
      lastBlastHandledId = game.lastBlast.id;
      tone("blast");
      if (navigator.vibrate) navigator.vibrate([40, 30, 80]);
      var curArena = document.querySelector(".dino-arena");
      if (curArena) {
        curArena.classList.add("is-emp-blasting");
        setTimeout(function () { curArena.classList.remove("is-emp-blasting"); }, 650);
      }
      var blastPl = game.players.find(function (p) { return p.id === game.lastBlast.playerId; });
      var blastLane = blastPl ? document.querySelector('.dino-lane[data-player-id="' + blastPl.id + '"]') : null;
      if (blastLane) {
        var stripEl = blastLane.querySelector(".race-strip");
        if (stripEl) {
          var blastPop = document.createElement("span");
          blastPop.className = "dodge-pop blast-pop";
          blastPop.textContent = "⚡ EMP BLAST! -" + (game.lastBlast.count || 0) + " DESTROYED! 💥";
          stripEl.appendChild(blastPop);
          setTimeout(function () { blastPop.remove(); }, 900);
        }
      }
    }

    var existingArena = document.querySelector(".dino-arena");
    var stageThemeClass = "stage-theme-" + Math.min(5, game.stage || 1);
    if (!existingArena || dinoMountedRound !== game.roundId) {
      dinoMountedRound = game.roundId;
      var ordered = game.players.slice().sort(function (a, b) { if (a.id === room.selfId) return -1; if (b.id === room.selfId) return 1; return 0; });
      var lanes = ordered.map(function (player, index) { return dinoLane(player, game.players.indexOf(player), game); }).join("");
      var countdown = game.status === "countdown" ? '<div class="race-countdown"><b class="count-pop" data-sec="' + game.countdown + '">' + game.countdown + "</b><span>GET READY</span></div>" : "";
      var result = "";
      if (game.status === "finished") {
        var failedPractice = !game.winnerId && game.players.length === 1;
        var allCleared = game.stage >= game.maxStage && game.distance >= game.finishDistance;
        var ranking = game.ranking.map(function (id, index) { var p = game.players.find(function (item) { return item.id === id; }); return '<li class="rank-' + (index + 1) + '"><b>' + (failedPractice ? "기록" : (index + 1) + "위") + "</b>" + dinoAvatar(p.skin, true) + "<span><strong>" + escapeHtml(p.nickname) + "</strong><small>STAGE " + (game.stage || 1) + " · 거리 " + p.distance + "m · 회피 " + p.dodged + "회</small></span></li>"; }).join("");
        var champion = game.players.find(function (p) { return p.id === game.winnerId; });
        var resultTitle = allCleared ? "👑 ALL STAGES CLEAR!" : (champion ? "🏆 " + escapeHtml(champion.nickname) + " 우승!" : "연습 종료!");
        result = '<div class="dino-result" role="dialog" aria-modal="true" aria-labelledby="raceResultTitle"><div><small>' + (allCleared ? "PERFECT ALL CLEAR!" : (champion ? "RACE FINISH!" : "TRY AGAIN!")) + '</small><div class="winner-celebration">' + (champion ? dinoAvatar(champion.skin) : "") + '</div><h2 id="raceResultTitle">' + resultTitle + '</h2><ol>' + ranking + "</ol>" + (isHost ? '<button class="button button--pink" type="button" data-action="dino-rematch">' + (champion ? "다시 달리기" : "다시 도전") + '</button><button class="button button--cyan" type="button" data-action="return-lobby">대기실로 돌아가기</button>' : '<button class="button button--ghost" disabled>방장을 기다리는 중</button>') + '<button class="button button--ghost" type="button" data-action="leave-room">TS 게임센터로 나가기</button></div></div>';
      }
      var selfCombo = self ? (self.combo || 0) : 0;
      var comboDisplay = selfCombo > 1 ? "inline-flex" : "none";
      document.getElementById("gameContent").innerHTML = '<div class="game-toolbar dino-toolbar"><button class="back-button" type="button" data-action="leave-room">← TS 게임센터</button><div class="game-toolbar__meta"><span>ROOM <b>#TS-' + escapeHtml(room.code) + '</b></span><span id="dinoSpeedMeta">SPEED <b>×' + game.speed + '</b></span><span>DIST <b id="dinoDistValue">' + game.distance + 'm</b> / <small id="dinoGoalValue">' + (game.stageGoal || game.finishDistance) + 'm</small></span></div><span class="game-toolbar__sync" id="dinoSyncMeta">● SYNC ' + latency + 'ms</span></div><section class="dino-arena ' + stageThemeClass + '" aria-labelledby="gameTitle"><h1 id="gameTitle" class="sr-only">네온 다이노 런 레이스</h1><div class="dino-hud"><span class="dino-stage-pill">STAGE <b id="dinoStageMeta">' + (game.stage || 1) + '</b> / ' + (game.maxStage || 5) + '</span><span class="dino-combo-badge" id="dinoComboBadge" style="display:' + comboDisplay + '">🔥 <b id="dinoComboValue">' + selfCombo + '</b> COMBO</span><b id="dinoLeaderMeta">LEADER ♛ ' + escapeHtml(leader ? leader.nickname : "-") + '</b><span id="dinoGoalMeta">STAGE GOAL ' + (game.stageGoal || game.finishDistance) + 'm</span></div><div class="dino-lanes">' + lanes + "</div><div id=\"dinoCountdownBox\">" + countdown + '</div><div class="dino-controls"><button class="dino-control jump-control ' + (midair ? "is-active" : "") + '" type="button" data-action="dino-jump" aria-label="점프" ' + (controlsLocked || midair ? "disabled" : "") + '><span aria-hidden="true">▲</span><b>JUMP</b><small>점프 · SPACE / ↑</small></button><button class="dino-control duck-control ' + (isDucking ? "is-active" : "") + '" type="button" data-action="dino-duck" aria-label="누르고 있는 동안 숙이기" aria-pressed="' + String(Boolean(isDucking)) + '" ' + (controlsLocked || midair ? "disabled" : "") + '><span aria-hidden="true">▼</span><b>DUCK</b><small>누르고 있기 · ↓</small></button></div><div class="race-log" role="status" aria-live="polite"><span id="dinoLogText">' + escapeHtml(game.lastAction ? game.lastAction.message : "레이스 준비") + "</span><b>SERVER AUTHORITATIVE</b></div><div id=\"dinoResultBox\">" + result + "</div></section>";
      startDinoLoop();
      return;
    }

    existingArena.className = "dino-arena " + stageThemeClass;
    var speedEl = document.getElementById("dinoSpeedMeta"); if (speedEl) speedEl.innerHTML = "SPEED <b>×" + game.speed + "</b>";
    var syncEl = document.getElementById("dinoSyncMeta"); if (syncEl) syncEl.textContent = "● SYNC " + latency + "ms";
    var leaderEl = document.getElementById("dinoLeaderMeta"); if (leaderEl) leaderEl.innerHTML = "LEADER ♛ " + escapeHtml(leader ? leader.nickname : "-");
    var logEl = document.getElementById("dinoLogText"); if (logEl && game.lastAction) logEl.textContent = game.lastAction.message;
    var stageEl = document.getElementById("dinoStageMeta"); if (stageEl) stageEl.textContent = game.stage || 1;
    var goalEl = document.getElementById("dinoGoalMeta"); if (goalEl) goalEl.textContent = "STAGE GOAL " + (game.stageGoal || game.finishDistance) + "m";
    var goalVal = document.getElementById("dinoGoalValue"); if (goalVal) goalVal.textContent = (game.stageGoal || game.finishDistance) + "m";

    var comboBadge = document.getElementById("dinoComboBadge");
    var comboVal = document.getElementById("dinoComboValue");
    if (comboBadge && comboVal) {
      var currentCombo = self ? (self.combo || 0) : 0;
      comboVal.textContent = currentCombo;
      comboBadge.style.display = currentCombo > 1 ? "inline-flex" : "none";
      if (currentCombo >= 5) comboBadge.classList.add("is-fever");
      else comboBadge.classList.remove("is-fever");
    }

    var jumpBtn = document.querySelector('[data-action="dino-jump"]');
    if (jumpBtn) {
      jumpBtn.disabled = controlsLocked || midair;
      jumpBtn.classList.toggle("is-active", Boolean(midair));
    }
    var duckBtn = document.querySelector('[data-action="dino-duck"]');
    if (duckBtn) {
      duckBtn.disabled = controlsLocked || midair;
      duckBtn.classList.toggle("is-active", Boolean(isDucking));
      duckBtn.setAttribute("aria-pressed", String(Boolean(isDucking)));
    }

    var resultBox = document.getElementById("dinoResultBox");
    if (resultBox) {
      if (game.status === "finished") {
        if (!resultBox.firstElementChild) {
          var failedPractice = !game.winnerId && game.players.length === 1;
          var allCleared = game.stage >= game.maxStage && game.distance >= game.finishDistance;
          var ranking = game.ranking.map(function (id, index) { var p = game.players.find(function (item) { return item.id === id; }); return '<li class="rank-' + (index + 1) + '"><b>' + (failedPractice ? "기록" : (index + 1) + "위") + "</b>" + dinoAvatar(p.skin, true) + "<span><strong>" + escapeHtml(p.nickname) + "</strong><small>STAGE " + (game.stage || 1) + " · 거리 " + p.distance + "m · 회피 " + p.dodged + "회</small></span></li>"; }).join("");
          var champion = game.players.find(function (p) { return p.id === game.winnerId; });
          var resultTitle = allCleared ? "👑 ALL STAGES CLEAR!" : (champion ? "🏆 " + escapeHtml(champion.nickname) + " 우승!" : "연습 종료!");
          resultBox.innerHTML = '<div class="dino-result" role="dialog" aria-modal="true" aria-labelledby="raceResultTitle"><div><small>' + (allCleared ? "PERFECT ALL CLEAR!" : (champion ? "RACE FINISH!" : "TRY AGAIN!")) + '</small><div class="winner-celebration">' + (champion ? dinoAvatar(champion.skin) : "") + '</div><h2 id="raceResultTitle">' + resultTitle + '</h2><ol>' + ranking + "</ol>" + (isHost ? '<button class="button button--pink" type="button" data-action="dino-rematch">' + (champion ? "다시 달리기" : "다시 도전") + '</button><button class="button button--cyan" type="button" data-action="return-lobby">대기실로 돌아가기</button>' : '<button class="button button--ghost" disabled>방장을 기다리는 중</button>') + '<button class="button button--ghost" type="button" data-action="leave-room">TS 게임센터로 나가기</button></div></div>';
        }
      } else {
        resultBox.innerHTML = "";
      }
    }

    for (var p = 0; p < game.players.length; p += 1) {
      var pl = game.players[p];
      var lane = document.querySelector('.dino-lane[data-player-id="' + pl.id + '"]');
      if (!lane) continue;
      var heartsEl = lane.querySelector(".lane-hearts");
      if (heartsEl) {
        var prevHp = Number(heartsEl.getAttribute("data-hp"));
        if (!isNaN(prevHp) && prevHp > pl.hp) {
          var dino = lane.querySelector(".pixel-dino");
          if (dino) {
            dino.classList.add("is-hit");
            setTimeout(function () { dino.classList.remove("is-hit"); }, 450);
          }
          var strip = lane.querySelector(".race-strip");
          if (strip) {
            var pop = document.createElement("span");
            pop.className = "hit-pop";
            pop.textContent = "-1 HP!";
            strip.appendChild(pop);
            setTimeout(function () { pop.remove(); }, 700);
          }
        } else if (!isNaN(prevHp) && prevHp < pl.hp) {
          var stripHeal = lane.querySelector(".race-strip");
          if (stripHeal) {
            var heal = document.createElement("span");
            heal.className = "heal-pop";
            heal.textContent = "+1 HP!";
            stripHeal.appendChild(heal);
            setTimeout(function () { heal.remove(); }, 800);
          }
        }
        heartsEl.setAttribute("data-hp", pl.hp);
        heartsEl.innerHTML = hearts(pl.hp);
      }
      var prevDodged = Number(lane.getAttribute("data-dodged") || 0);
      if (pl.dodged > prevDodged) {
        var stripDodge = lane.querySelector(".race-strip");
        if (stripDodge) {
          var popDodge = document.createElement("span");
          var pCombo = pl.combo || 1;
          if (pCombo >= 5) {
            popDodge.className = "dodge-pop fever-pop";
            popDodge.textContent = "FEVER ×" + pCombo + "!";
            if (pl.id === room.selfId) tone("combo");
          } else if (pCombo >= 3) {
            popDodge.className = "dodge-pop combo-pop";
            popDodge.textContent = pCombo + " COMBO!";
            if (pl.id === room.selfId) tone("combo");
          } else {
            popDodge.className = "dodge-pop";
            popDodge.textContent = "DODGE! +100";
            if (pl.id === room.selfId) tone("dodge");
          }
          stripDodge.appendChild(popDodge);
          setTimeout(function () { popDodge.remove(); }, 650);
        }
      }
      lane.setAttribute("data-dodged", pl.dodged);
      var distText = lane.querySelector(".lane-dist");
      if (distText) distText.textContent = pl.distance + "m";
      lane.classList.toggle("is-out", !pl.alive);
      lane.classList.toggle("is-jumping", pl.action === "jump");
      lane.classList.toggle("is-ducking", pl.action === "duck");
      var runnerState = lane.querySelector(".runner-state");
      if (runnerState) {
        runnerState.className = "runner-state state-" + pl.action;
        runnerState.textContent = pl.action === "jump" ? "JUMP!" : pl.action === "duck" ? "DUCK!" : "";
      }
      var statusSpan = lane.querySelector(".lane-status");
      if (statusSpan) {
        if (!pl.connected) { statusSpan.style.display = "grid"; statusSpan.textContent = "재접속 중..."; }
        else if (!pl.alive) { statusSpan.style.display = "grid"; statusSpan.textContent = "GAME OVER"; }
        else { statusSpan.style.display = "none"; }
      }
      var obsLayer = lane.querySelector(".obstacles-layer");
      if (obsLayer) syncObstacles(obsLayer, game.obstacles);
    }
  }

  function selectGame(game) {
    selectedGame = game === "dino" ? "dino" : "bell";
    document.getElementById("entryIcon").textContent = selectedGame === "dino" ? "🦖" : "🔔";
    document.getElementById("quickStartTitle").textContent = selectedGame === "dino" ? "네온 다이노 런 방 만들기" : "과일폭풍 종치기 방 만들기";
    document.getElementById("quickStartDescription").textContent = selectedGame === "dino" ? "최대 4명이 각자 휴대폰으로 점프와 숙이기를 조작하는 실시간 생존 레이스입니다." : "한 명이 방을 만들고 같은 공유기에 연결된 친구가 방 코드로 들어오면 됩니다.";
    document.querySelectorAll(".cabinet--active").forEach(function (item) { item.classList.toggle("is-selected", item.classList.contains("cabinet--" + selectedGame)); });
  }
  function releaseDuck() { if (!duckHeld) return; duckHeld = false; if (duckPointerId === null) sendDinoInput("dino-duck", { active: false }); }
  function releasePointerDuck(event) {
    if (duckPointerId === null || (event && event.pointerId !== duckPointerId)) return;
    duckPointerId = null;
    if (!duckHeld) sendDinoInput("dino-duck", { active: false });
  }
  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-action]"); if (!button || button.disabled) return; var action = button.getAttribute("data-action");
    if (["ring-bell", "flip-card", "dino-jump", "dino-duck"].indexOf(action) < 0) tone("click");
    if (action === "focus-create") { selectGame(button.getAttribute("data-game")); document.getElementById("quickStart").scrollIntoView({ behavior: "smooth", block: "center" }); nicknameInput.focus(); }
    else if (action === "create-room") send("create-room", { nickname: nickname(), gameType: selectedGame });
    else if (action === "join-room") { var code = roomCodeInput.value.replace(/\D/g, "").slice(-4); if (code.length !== 4) return showToast("4자리 방 코드를 입력해주세요.", true); send("join-room", { roomCode: code, nickname: nickname(), token: sessionStorage.getItem(tokenKey(code)) }); }
    else if (action === "go-home") { document.body.classList.remove("game-locked"); document.documentElement.classList.remove("game-locked"); if (room) send("leave-room"); else setScreen("home"); }
    else if (action === "leave-room") { document.body.classList.remove("game-locked"); document.documentElement.classList.remove("game-locked"); send("leave-room"); }
    else if (action === "copy-link") copyText(inviteUrl(), "초대 주소를 복사했습니다.");
    else if (action === "copy-code") copyText(room.code, "방 코드를 복사했습니다.");
    else if (action === "toggle-ready") send("toggle-ready");
    else if (action === "save-nickname") { var name = document.getElementById("lobbyNickname").value.trim(); if (!name) return showToast("닉네임을 입력해주세요.", true); localStorage.setItem("ts-arcade-nickname", name); nicknameInput.value = name; send("set-nickname", { nickname: name }); }
    else if (action === "set-dino-skin") send("set-dino-skin", { skin: button.getAttribute("data-skin") });
    else if (action === "start-game") send("start-game");
    else if (action === "flip-card") sendBellInput("flip-card");
    else if (action === "ring-bell") { tone("bell"); if (navigator.vibrate) navigator.vibrate(35); sendBellInput("ring-bell"); }
    else if (action === "dino-jump") { tone("jump"); if (navigator.vibrate) navigator.vibrate(18); sendDinoInput("dino-jump"); }
    else if (action === "dino-rematch") send("dino-rematch");
    else if (action === "bell-rematch") send("bell-rematch");
    else if (action === "return-lobby") send("return-lobby");
    else if (action === "toggle-sound") { soundOn = !soundOn; localStorage.setItem("ts-arcade-sound", soundOn ? "on" : "off"); updateSoundButton(); if (soundOn) tone("success"); }
  });
  document.addEventListener("pointerdown", function (event) { var button = event.target.closest('[data-action="dino-duck"]'); if (!button || button.disabled || duckPointerId !== null) return; event.preventDefault(); duckPointerId = event.pointerId; sendDinoInput("dino-duck", { active: true }); });
  window.addEventListener("pointerup", releasePointerDuck);
  window.addEventListener("pointercancel", releasePointerDuck);
  window.addEventListener("blur", function () { var wasDucking = duckHeld || duckPointerId !== null; duckHeld = false; duckPointerId = null; if (wasDucking) sendDinoInput("dino-duck", { active: false }); });
  document.addEventListener("keydown", function (event) {
    if (!room || room.status !== "game" || /INPUT|TEXTAREA/.test(event.target.tagName)) return;
    var navCodes = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "PageUp", "PageDown", "Home", "End"];
    if (navCodes.indexOf(event.code) >= 0 || ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].indexOf(event.key) >= 0) {
      event.preventDefault();
    }
    if (room.gameType === "dino") {
      if ((event.code === "Space" || event.key === "ArrowUp") && !event.repeat) { sendDinoInput("dino-jump"); tone("jump"); }
      else if (event.key === "ArrowDown" && !event.repeat) { duckHeld = true; sendDinoInput("dino-duck", { active: true }); }
    } else if (event.code === "Space" && !event.repeat) { event.preventDefault(); sendBellInput("ring-bell"); tone("bell"); } else if (event.key.toLowerCase() === "f" && !event.repeat) sendBellInput("flip-card");
  });
  document.addEventListener("keyup", function (event) { if (room && room.gameType === "dino" && event.key === "ArrowDown") releaseDuck(); });
  document.addEventListener("change", function (event) {
    if (event.target.id !== "lanAddressSelect" || !room) return;
    localStorage.setItem("ts-arcade-lan-url", event.target.value);
    if (room.gameType === "dino") renderDinoLobby(); else renderBellLobby();
    showToast("휴대폰 초대 주소를 변경했습니다.");
  });
  roomCodeInput.addEventListener("keydown", function (event) { if (event.key === "Enter") document.querySelector('[data-action="join-room"]').click(); });
  nicknameInput.addEventListener("keydown", function (event) { if (event.key === "Enter") document.querySelector('[data-action="create-room"]').click(); });
  fetch("/api/info").then(function (response) { return response.json(); }).then(function (info) {
    serverInfo = info;
    if (room && room.status === "lobby") { if (room.gameType === "dino") renderDinoLobby(); else renderBellLobby(); }
  }).catch(function () {});
  var requestedRoom = new URLSearchParams(location.search).get("room");
  if (requestedRoom) { roomCodeInput.value = requestedRoom.replace(/\D/g, "").slice(-4); setTimeout(function () { document.getElementById("quickStart").scrollIntoView({ behavior: "smooth", block: "center" }); nicknameInput.focus(); showToast("닉네임을 확인하고 빠른 입장을 눌러주세요."); }, 250); }
  connect(); window.addEventListener("beforeunload", function () { intentionalClose = true; });
})();
