(function () {
  "use strict";
  var SIZE = 33;
  var DATA_CODEWORDS = 80;
  var ECC_CODEWORDS = 20;
  var EXP = new Array(512);
  var LOG = new Array(256);
  var value = 1;
  for (var i = 0; i < 255; i += 1) { EXP[i] = value; LOG[value] = i; value <<= 1; if (value & 256) value ^= 0x11d; }
  for (i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
  function multiply(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }
  function polynomialMultiply(a, b) {
    var result = new Array(a.length + b.length - 1).fill(0);
    for (var x = 0; x < a.length; x += 1) for (var y = 0; y < b.length; y += 1) result[x + y] ^= multiply(a[x], b[y]);
    return result;
  }
  function errorCorrection(data) {
    var generator = [1];
    for (var i = 0; i < ECC_CODEWORDS; i += 1) generator = polynomialMultiply(generator, [1, EXP[i]]);
    var message = data.concat(new Array(ECC_CODEWORDS).fill(0));
    for (i = 0; i < data.length; i += 1) {
      var factor = message[i];
      if (!factor) continue;
      for (var j = 0; j < generator.length; j += 1) message[i + j] ^= multiply(generator[j], factor);
    }
    return message.slice(data.length);
  }
  function pushBits(target, number, length) { for (var bit = length - 1; bit >= 0; bit -= 1) target.push((number >>> bit) & 1); }
  function encode(text) {
    var bytes = Array.from(new TextEncoder().encode(text));
    if (bytes.length > 78) throw new Error("초대 주소가 QR 코드 용량을 초과했습니다.");
    var bits = []; pushBits(bits, 4, 4); pushBits(bits, bytes.length, 8);
    bytes.forEach(function (byte) { pushBits(bits, byte, 8); });
    for (i = 0; i < 4 && bits.length < DATA_CODEWORDS * 8; i += 1) bits.push(0);
    while (bits.length % 8) bits.push(0);
    var data = [];
    for (i = 0; i < bits.length; i += 8) { var byte = 0; for (var b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i + b]; data.push(byte); }
    var pad = true; while (data.length < DATA_CODEWORDS) { data.push(pad ? 0xec : 0x11); pad = !pad; }
    return data.concat(errorCorrection(data));
  }
  function finder(matrix, row, col) {
    for (var r = -1; r <= 7; r += 1) for (var c = -1; c <= 7; c += 1) {
      var y = row + r; var x = col + c; if (y < 0 || x < 0 || y >= SIZE || x >= SIZE) continue;
      matrix[y][x] = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
    }
  }
  function alignment(matrix, row, col) {
    if (matrix[row][col] !== null) return;
    for (var r = -2; r <= 2; r += 1) for (var c = -2; c <= 2; c += 1) matrix[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
  }
  function bchFormat(mask) {
    var data = (1 << 3) | mask; var bits = data << 10; var generator = 0x537;
    function degree(number) { var result = -1; while (number) { result += 1; number >>>= 1; } return result; }
    while (degree(bits) >= degree(generator)) bits ^= generator << (degree(bits) - degree(generator));
    return ((data << 10) | bits) ^ 0x5412;
  }
  function format(matrix, mask) {
    var bits = bchFormat(mask);
    for (var i = 0; i < 15; i += 1) {
      var dark = ((bits >> i) & 1) === 1;
      if (i < 6) matrix[i][8] = dark; else if (i < 8) matrix[i + 1][8] = dark; else matrix[SIZE - 15 + i][8] = dark;
      if (i < 8) matrix[8][SIZE - i - 1] = dark; else if (i < 9) matrix[8][15 - i] = dark; else matrix[8][15 - i - 1] = dark;
    }
    matrix[SIZE - 8][8] = true;
  }
  function make(text) {
    var matrix = Array.from({ length: SIZE }, function () { return new Array(SIZE).fill(null); });
    finder(matrix, 0, 0); finder(matrix, SIZE - 7, 0); finder(matrix, 0, SIZE - 7);
    alignment(matrix, 26, 26);
    for (var i = 8; i < SIZE - 8; i += 1) { if (matrix[6][i] === null) matrix[6][i] = i % 2 === 0; if (matrix[i][6] === null) matrix[i][6] = i % 2 === 0; }
    format(matrix, 0);
    var codewords = encode(text); var bits = []; codewords.forEach(function (byte) { pushBits(bits, byte, 8); });
    var bitIndex = 0; var upward = true;
    for (var col = SIZE - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;
      for (var offset = 0; offset < SIZE; offset += 1) {
        var row = upward ? SIZE - 1 - offset : offset;
        for (var pair = 0; pair < 2; pair += 1) {
          var x = col - pair; if (matrix[row][x] !== null) continue;
          var dark = bits[bitIndex] === 1; bitIndex += 1;
          if ((row + x) % 2 === 0) dark = !dark;
          matrix[row][x] = dark;
        }
      }
      upward = !upward;
    }
    return matrix;
  }
  function svg(text) {
    var matrix = make(text); var quiet = 4; var size = SIZE + quiet * 2; var path = [];
    matrix.forEach(function (row, y) { row.forEach(function (dark, x) { if (dark) path.push("M" + (x + quiet) + " " + (y + quiet) + "h1v1h-1z"); }); });
    return '<svg class="invite-qr-svg" viewBox="0 0 ' + size + " " + size + '" role="img" aria-label="초대 주소 QR 코드" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="' + path.join("") + '" fill="#05050b"/></svg>';
  }
  var api = { svg: svg, make: make };
  if (typeof window !== "undefined") window.TSQRCode = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
