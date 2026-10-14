(function (global) {
  "use strict";

  // 서버 없이 GitHub Pages만으로 하는 멀티플레이.
  // 방장 브라우저가 room-engine(서버와 같은 판정 코드)을 직접 돌리고, 참가자는 WebRTC(PeerJS)로 방장에 붙는다.
  // PeerJS 공개 중개 서버는 연결을 맺을 때만 쓰이고, 게임 데이터는 브라우저끼리 직접 오간다.
  var PREFIX = "tsgc-";
  var HEARTBEAT_MS = 3000;   // 주기적으로 신호를 주고받아 한쪽이 사라진 것을 빨리 알아챈다.
  var DEAD_AFTER_MS = 12000; // 이 시간 동안 아무 신호도 없으면 끊긴 것으로 본다.
  var PEER_OPTIONS = {
    debug: 0,
    config: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:global.stun.twilio.com:3478" }] },
  };

  // app.js가 WebSocket처럼 다룰 수 있는 최소 인터페이스.
  function FakeSocket() {
    this.readyState = 0;
    this.listeners = { open: [], message: [], close: [], error: [] };
  }
  FakeSocket.prototype.addEventListener = function (type, fn) { if (this.listeners[type]) this.listeners[type].push(fn); };
  FakeSocket.prototype.emit = function (type, event) {
    var list = this.listeners[type].slice();
    for (var i = 0; i < list.length; i += 1) { try { list[i](event || {}); } catch (error) { if (global.console) console.error(error); } }
  };
  FakeSocket.prototype.setOpen = function () { if (this.readyState !== 0) return; this.readyState = 1; this.emit("open"); };
  FakeSocket.prototype.fail = function (message) { this.emit("error", { message: message }); this.finish(); };
  FakeSocket.prototype.finish = function () {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.cleanup) { try { this.cleanup(); } catch (_) {} }
    this.emit("close");
  };
  FakeSocket.prototype.close = function () { this.finish(); };

  function ensurePeerJs() {
    if (!global.Peer) throw new Error("PeerJS를 불러오지 못했습니다.");
    if (!global.TSRoomEngine) throw new Error("방 엔진을 불러오지 못했습니다.");
  }

  function randomCode() { return String(1000 + Math.floor(Math.random() * 9000)); }

  function createHost() {
    var socket = new FakeSocket();
    socket.isP2P = true; socket.role = "host";
    try { ensurePeerJs(); } catch (error) { setTimeout(function () { socket.fail(error.message); }, 0); return socket; }
    var engine = global.TSRoomEngine.createRoomEngine({ allowChosenCode: true });
    var stopTimers = engine.startTimers();
    var attempts = 0;
    var peer = null;
    var conns = [];
    var beat = setInterval(function () {
      var now = Date.now();
      conns.slice().forEach(function (entry) {
        if (now - entry.lastSeen > DEAD_AFTER_MS) { try { entry.conn.close(); } catch (_) {} entry.drop(); return; }
        if (entry.conn.open) { try { entry.conn.send('{"type":"hb"}'); } catch (_) {} }
      });
    }, HEARTBEAT_MS);
    var local = {
      roomCode: null, playerId: null,
      sendJSON: function (data) { var text = JSON.stringify(data); setTimeout(function () { if (socket.readyState === 1) socket.emit("message", { data: text }); }, 0); },
      close: function () {},
    };

    function openPeer() {
      attempts += 1;
      var code = randomCode();
      peer = new global.Peer(PREFIX + code, PEER_OPTIONS);
      peer.on("open", function () { socket.hostCode = code; socket.setOpen(); });
      peer.on("error", function (error) {
        if (socket.readyState === 0 && error.type === "unavailable-id" && attempts < 8) { try { peer.destroy(); } catch (_) {} return openPeer(); }
        if (socket.readyState === 0) return socket.fail("방을 만들지 못했습니다. 인터넷 연결을 확인해주세요. (" + error.type + ")");
      });
      peer.on("disconnected", function () { if (socket.readyState === 1 && !peer.destroyed) { try { peer.reconnect(); } catch (_) {} } });
      peer.on("connection", function (conn) {
        var remote = {
          roomCode: null, playerId: null,
          sendJSON: function (data) { if (conn.open) { try { conn.send(JSON.stringify(data)); } catch (_) {} } },
          close: function () { try { conn.close(); } catch (_) {} },
        };
        var entry = { conn: conn, lastSeen: Date.now(), drop: function () { conns = conns.filter(function (item) { return item !== entry; }); engine.detachPeer(remote); } };
        conns.push(entry);
        conn.on("open", function () { entry.lastSeen = Date.now(); remote.sendJSON({ type: "connected" }); });
        conn.on("data", function (raw) {
          entry.lastSeen = Date.now();
          var text = typeof raw === "string" ? raw : JSON.stringify(raw);
          if (text.indexOf('"hb"') >= 0 && text.length < 40) return;
          engine.handleMessage(remote, text);
        });
        conn.on("close", entry.drop);
        conn.on("error", entry.drop);
      });
    }

    socket.send = function (raw) { if (socket.readyState === 1) engine.handleMessage(local, raw); };
    socket.cleanup = function () {
      clearInterval(beat);
      stopTimers();
      engine.detachPeer(local);
      if (peer) { try { peer.destroy(); } catch (_) {} }
    };
    openPeer();
    return socket;
  }

  function createGuest(code) {
    var socket = new FakeSocket();
    socket.isP2P = true; socket.role = "guest";
    try { ensurePeerJs(); } catch (error) { setTimeout(function () { socket.fail(error.message); }, 0); return socket; }
    var peer = new global.Peer(undefined, PEER_OPTIONS);
    var conn = null;
    var lastSeen = Date.now();
    var beat = null;
    var timer = setTimeout(function () { if (socket.readyState === 0) socket.fail("방장에게 연결하지 못했습니다. 방 코드를 확인하거나 방장이 접속 중인지 확인해주세요."); }, 20000);
    peer.on("open", function () {
      conn = peer.connect(PREFIX + code, { reliable: true, serialization: "json" });
      conn.on("open", function () {
        clearTimeout(timer); lastSeen = Date.now(); socket.setOpen();
        beat = setInterval(function () {
          if (Date.now() - lastSeen > DEAD_AFTER_MS) return socket.finish();
          try { conn.send('{"type":"hb"}'); } catch (_) {}
        }, HEARTBEAT_MS);
      });
      conn.on("data", function (raw) { lastSeen = Date.now(); if (typeof raw === "string" && raw.indexOf('"hb"') >= 0 && raw.length < 40) return; socket.emit("message", { data: typeof raw === "string" ? raw : JSON.stringify(raw) }); });
      conn.on("close", function () { socket.finish(); });
      conn.on("error", function () { socket.finish(); });
    });
    peer.on("error", function (error) {
      if (socket.readyState !== 0) return;
      socket.fail(error.type === "peer-unavailable" ? "방을 찾을 수 없습니다. 코드를 다시 확인하거나 방장이 열어둔 상태인지 확인해주세요." : "연결하지 못했습니다. (" + error.type + ")");
    });
    socket.send = function (raw) { if (socket.readyState === 1 && conn && conn.open) conn.send(raw); };
    socket.cleanup = function () { clearTimeout(timer); clearInterval(beat); try { peer.destroy(); } catch (_) {} };
    return socket;
  }

  global.TSP2P = { createHost: createHost, createGuest: createGuest };
})(typeof globalThis !== "undefined" ? globalThis : window);
