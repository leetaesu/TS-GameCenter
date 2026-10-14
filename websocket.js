"use strict";

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 64 * 1024;

function encodeFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  const header = Buffer.alloc(4);
  header[0] = 0x80 | opcode;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

class WebSocketPeer extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0)) {
    super();
    this.socket = socket;
    this.buffer = head;
    this.closed = false;
    this.alive = true;
    socket.on("data", (chunk) => this.consume(chunk));
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
    if (head.length) this.parse();
  }

  consume(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parse();
  }

  parse() {
    while (this.buffer.length >= 2 && !this.closed) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (!final || !masked) return this.close(1002, "Invalid frame");
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        return this.close(1009, "Frame too large");
      }
      if (length > MAX_PAYLOAD) return this.close(1009, "Frame too large");
      if (this.buffer.length < offset + 4 + length) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      this.buffer = this.buffer.subarray(offset + 4 + length);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

      if (opcode === 0x8) return this.close(1000, "Bye");
      if (opcode === 0x9) { this.socket.write(encodeFrame(payload, 0xA)); continue; }
      if (opcode === 0xA) { this.alive = true; continue; }
      if (opcode !== 0x1) return this.close(1003, "Text only");
      this.emit("message", payload.toString("utf8"));
    }
  }

  send(value) {
    if (!this.closed && this.socket.writable) this.socket.write(encodeFrame(value));
  }

  sendJSON(value) {
    this.send(JSON.stringify(value));
  }

  ping() {
    if (!this.closed && this.socket.writable) {
      this.alive = false;
      this.socket.write(encodeFrame("ts", 0x9));
    }
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(reason).subarray(0, 120);
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    if (this.socket.writable) this.socket.write(encodeFrame(payload, 0x8));
    this.socket.end();
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

function acceptUpgrade(request, socket, head = Buffer.alloc(0)) {
  const key = request.headers["sec-websocket-key"];
  if (!key || request.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return null;
  }
  const accept = crypto.createHash("sha1").update(key + MAGIC).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + accept,
    "\r\n",
  ].join("\r\n"));
  return new WebSocketPeer(socket, head);
}

module.exports = { WebSocketPeer, acceptUpgrade, encodeFrame };
