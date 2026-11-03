// 手势识别回归测试：在桩环境中运行 content/gesture.js 的真实识别函数
// 运行：node .dev-test/gesture-test.js
//
// 方向记法（指针在 5）：
//   7 8 9
//   4 5 6
//   1 2 3

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 在 IIFE 收尾前把内部函数挂到 sandbox 的 globalThis 上，正常文件不受影响
const SOURCE = fs
  .readFileSync(path.join(__dirname, '..', 'content', 'gesture.js'), 'utf8')
  .replace(/\}\)\(\);\s*$/, `globalThis.__test = { digitOf, extractPattern };\n})();\n`);

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  document: null,
  chrome: null,
  window: null
};

sandbox.window = {
  top: null,
  innerWidth: 1280,
  innerHeight: 720,
  addEventListener() {}
};
sandbox.window.top = sandbox.window;

sandbox.document = {
  documentElement: { appendChild() {} },
  body: null,
  querySelectorAll: () => [],
  addEventListener() {}
};

sandbox.chrome = {
  storage: {
    sync: {
      get(defaults, callback) {
        callback(defaults);
      }
    },
    onChanged: { addListener() {} }
  },
  runtime: {
    lastError: undefined,
    onMessage: { addListener() {} },
    sendMessage: async () => ({ ok: true })
  }
};

vm.runInNewContext(SOURCE, sandbox, { filename: 'content/gesture.js' });

const { digitOf, extractPattern } = sandbox.__test;

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${
      ok ? '' : `  <- 期望 ${JSON.stringify(expected)}`
    }`
  );
  if (ok) pass += 1;
  else fail += 1;
}

/** 折线顶点（RDP 只保留偏离超过 SIMPLIFY_TOLERANCE 的拐点） */
function trace(...vertices) {
  return vertices.map(([x, y]) => ({ x, y }));
}

/** 按方位角取方向向量：0° 向右、90° 向下（屏幕坐标 y 轴向下） */
function vectorOf(degrees) {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians) * 100, Math.sin(radians) * 100];
}

console.log('— 方向扇形（8/2/4/6 各 40°，7/9/1/3 各 50°）—');

const SECTOR_CASES = [
  [0, 6],
  [19.9, 6],
  [20.1, 3],
  [45, 3],
  [69.9, 3],
  [70.1, 2],
  [90, 2],
  [109.9, 2],
  [110.1, 1],
  [135, 1],
  [159.9, 1],
  [160.1, 4],
  [180, 4],
  [199.9, 4],
  [200.1, 7],
  [225, 7],
  [249.9, 7],
  [250.1, 8],
  [270, 8],
  [289.9, 8],
  [290.1, 9],
  [315, 9],
  [339.9, 9],
  [340.1, 6],
  [359.9, 6]
];

for (const [degrees, expected] of SECTOR_CASES) {
  const [dx, dy] = vectorOf(degrees);
  check(`${degrees}° → ${expected}`, digitOf(dx, dy), expected);
}

console.log('\n— 手势序列 —');

const PATTERN_CASES = [
  ['右（单段）', trace([0, 0], [100, 0]), '6'],
  ['左（单段）', trace([0, 0], [-100, 0]), '4'],
  ['上（单段）', trace([0, 0], [0, -100]), '8'],
  ['下（单段）', trace([0, 0], [0, 100]), '2'],
  ['只有斜方向 → 无效', trace([0, 0], [100, -100]), ''],
  ['起手斜方向 → 无效', trace([0, 0], [50, -50], [150, -50]), ''],
  ['下 → 右', trace([0, 0], [0, 100], [100, 100]), '26'],
  ['下 → 右下 → 右', trace([0, 0], [0, 100], [30, 130], [130, 130]), '26'],
  ['下 → 左下 → 右 → 无效', trace([0, 0], [0, 100], [-30, 130], [70, 130]), ''],
  ['左 → 右上 → 上 → 无效', trace([0, 0], [-100, 0], [-70, -30], [-70, -130]), ''],
  ['左 → 右（掉头）', trace([0, 0], [-100, 0], [0, 0]), '46'],
  ['左 → 左下 → 右（掉头 + 斜方向）', trace([0, 0], [-100, 0], [-130, 30], [-30, 30]), '46'],
  ['上 → 下（掉头）', trace([0, 0], [0, -100], [0, 0]), '82'],
  ['上 → 左上 → 下', trace([0, 0], [0, -100], [-30, -130], [-30, -30]), '82'],
  ['上 → 右上 → 下', trace([0, 0], [0, -100], [30, -130], [30, -30]), '82'],
  ['左 → 上', trace([0, 0], [-100, 0], [-100, -100]), '48'],
  ['左 → 左上 → 上', trace([0, 0], [-100, 0], [-130, -30], [-130, -130]), '48'],
  ['下 → 右 → 下（没有对应动作）', trace([0, 0], [0, 100], [100, 100], [100, 200]), '262'],
  ['短段 → 无效', trace([0, 0], [15, 0], [15, 100]), ''],
  ['中间段只有 15px（下→右→上）→ 无效', trace([0, 0], [0, 100], [15, 100], [15, 0]), ''],
  ['10px 手抖被 RDP 吸收', trace([0, 0], [10, 0], [10, 100]), '2'],
  ['连续同方向只记一次', trace([0, 0], [95, 33], [190, 0]), '6']
];

for (const [label, points, expected] of PATTERN_CASES) {
  check(label, extractPattern(points), expected);
}

console.log(`\n${pass} 项通过，${fail} 项失败`);
if (fail > 0) process.exitCode = 1;
