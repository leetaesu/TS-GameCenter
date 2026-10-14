"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { make, svg } = require("../public/js/qr");

test("초대 주소를 오프라인 QR 버전 4 행렬로 만든다", () => {
  const matrix = make("http://192.168.0.79:5007/?room=7721");
  assert.equal(matrix.length, 33); assert.ok(matrix.every((row) => row.length === 33));
  assert.equal(matrix[0][0], true); assert.equal(matrix[6][6], true); assert.equal(matrix[1][1], false); assert.equal(matrix[3][3], true);
  assert.ok(matrix.flat().every((cell) => typeof cell === "boolean"));
});
test("QR SVG에는 흰 여백과 접근성 이름이 포함된다", () => {
  const markup = svg("http://192.168.0.79:5007/?room=7721");
  assert.match(markup, /viewBox="0 0 41 41"/); assert.match(markup, /초대 주소 QR 코드/); assert.match(markup, /<path/);
});
