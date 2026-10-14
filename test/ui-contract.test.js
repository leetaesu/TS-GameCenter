"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "public");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "js", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

test("게임 화면 자산은 로컬 파일만 사용한다", () => {
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /cdn/i);
  assert.match(html, /src="(?:\.)?\/js\/qr\.js"/);
  assert.match(html, /src="(?:\.)?\/js\/app\.js"/);
  assert.match(html, /href="(?:\.)?\/styles\.css"/);
});

test("종치기 모바일·키보드·접근성 계약이 화면 코드에 있다", () => {
  assert.match(app, /aria-label="종 치기"/);
  assert.match(app, /aria-live="polite"/);
  assert.match(app, /role="dialog"/);
  assert.match(app, /event\.code === "Space"/);
  assert.match(app, /event\.key\.toLowerCase\(\) === "f"/);
  assert.match(app, /data-action="bell-rematch"/);
  assert.match(app, /window\.addEventListener\("pointerup", releasePointerDuck\)/);
  assert.match(app, /roundId: room\.game\.roundId/);
  assert.match(app, /aria-pressed=/);
  assert.match(app, /누르고 있는 동안 숙이기/);
  assert.match(css, /\.button \{ min-height: 48px/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(max-width: 360px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});
