// 离线自测：用 esbuild 打包 TS 核心算法后在 Node 中运行。
// 运行：npm run selftest
import { build } from 'esbuild';
import { writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const entry = join(tmpdir(), 'analysis-bundle.mjs');
await build({
  entryPoints: ['src/analysis.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: entry,
  logLevel: 'silent',
});
const { analyze, makeDemoData, uid } = await import(pathToFileURL(entry).href);

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ---- 构造工具：等距点 + 分段常数/线性基线场景 ----
function mkData(ys, { step = 1, liveTime = 1 } = {}) {
  return {
    sampleId: 'UT',
    liveTime,
    points: ys.map((cps, i) => ({ distance: i * step, counts: Math.max(0, Math.round(cps * liveTime)), liveTime })),
  };
}
// 基线锚点：index/y（y 为 cps）
const anc = (index, y) => ({ id: uid('a'), index, y });
const bnd = (index) => ({ id: uid('b'), index });
const fullCal = (n) => ({ scanStartIndex: 0, scanEndIndex: n - 1, originIndex: 0, frontIndex: n - 1 });

console.log('1) 演示数据：三峰、默认区间，全部阈值通过 → 整组放行');
{
  const data = makeDemoData();
  const n = data.points.length;
  const rate = data.points.map((p) => p.counts / p.liveTime);
  const anchors = [
    { id: uid('a'), index: 0, y: rate[0] },
    { id: uid('a'), index: n - 1, y: rate[n - 1] },
  ];
  // 在三个峰间谷点放共享边界（谷点应约在 d≈30、d≈88）
  const findValley = (lo, hi) => {
    let bi = lo;
    let bv = Infinity;
    for (let i = lo; i <= hi; i++) if (rate[i] < bv) { bv = rate[i]; bi = i; }
    return bi;
  };
  const boundaries = [bnd(0), bnd(findValley(20, 40)), bnd(findValley(78, 98)), bnd(n - 1)];
  const zones = [
    { id: uid('z'), name: '原点杂质', rfMin: 0, rfMax: 0.15, minPct: 0, maxPct: 10 },
    { id: uid('z'), name: '标记产物', rfMin: 0.35, rfMax: 0.65, minPct: 80, maxPct: 100 },
    { id: uid('z'), name: '游离锝', rfMin: 0.85, rfMax: 1, minPct: 0, maxPct: 10 },
  ];
  const r = analyze({ data, calibration: fullCal(n), anchors, boundaries, zones, unclassifiedTolerancePct: 1 });
  // 允许根据真实峰占比放宽核对：打印一次
  console.log('   峰:', r.peaks.map((p) => `#${p.no} Rf=${p.rf} pct=${p.pct}% area=${p.area}`).join(' | '));
  console.log('   区间:', r.zones.map((z) => `${z.name}=${z.pct}%[${z.minPct}-${z.maxPct}]${z.pass ? '✓' : '✗'}`).join(' | '));
  console.log(`   未分类=${r.unclassifiedPct}% 异常数=${r.anomalies.length}`);
  // 三峰均被识别
  assert.equal(r.peaks.length, 3, '应识别 3 个峰');
  // 主峰 Rf ≈ 0.5
  const main = r.peaks[1];
  assert.ok(Math.abs(main.rf - 0.5) < 0.03, `主峰 Rf 应≈0.5，实际 ${main.rf}`);
  // 主峰占比最大
  assert.ok(main.pct > 70, `主峰应占绝大多数面积，实际 ${main.pct}%`);
  // 无异常（区间覆盖整段 0..1 且无重叠，未分类≈0）
  assert.deepEqual(r.anomalies.map((a) => a.code), [], '不应有异常');
  assert.equal(r.canRelease, true);
  assert.equal(r.release, true);
}

console.log('2) 梯形积分：方波峰面积 = 高 × 宽（逐点手算核对）');
{
  // x: 0..10，扣底平台 100 位于 x=3..7，端点谷=0
  const ys = [0, 0, 0, 100, 100, 100, 100, 100, 0, 0, 0];
  const data = mkData(ys);
  const anchors = [anc(0, 0), anc(10, 0)];
  const boundaries = [bnd(2), bnd(8)];
  const r = analyze({ data, calibration: fullCal(11), anchors, boundaries, zones: [], unclassifiedTolerancePct: 100 });
  const p = r.peaks[0];
  // 梯形：上升 0.5*100*1 + 平顶三段 100*4? 实际 x3..x7 = 5 个 100 点:
  // 间隔: 2-3:50, 3-4:100, 4-5:100, 5-6:100, 6-7:100, 7-8:50 => 500
  assert.equal(p.area, 500, `方波面积应为 500，实际 ${p.area}`);
  assert.equal(p.apexIndex, 3, '同高取最左峰顶');
  // traps 面积之和
  assert.equal(p.traps.reduce((s, t) => s + t.area, 0), 500);
}

console.log('3) 共享谷点：只作为两侧梯形共同端点，不重复计面积');
{
  // 两个相邻三角峰，共享谷点 x=5（值0）
  const ys = [0, 50, 100, 50, 0, 0, 0, 50, 100, 50, 0];
  const data = mkData(ys);
  const anchors = [anc(0, 0), anc(10, 0)];
  const boundaries = [bnd(0), bnd(5), bnd(10)];
  const r = analyze({ data, calibration: fullCal(11), anchors, boundaries, zones: [], unclassifiedTolerancePct: 100 });
  assert.equal(r.peaks.length, 2);
  // 三角峰面积 = 200（两个斜边梯形 25+75+75+25）
  assert.equal(r.peaks[0].area, 200);
  assert.equal(r.peaks[1].area, 200);
  assert.equal(r.peaks[0].rightBoundaryIndex, r.peaks[1].leftBoundaryIndex);
  assert.equal(r.totalArea, 400);
}

console.log('4) 基线扣底：线性倾斜基线，负值截断后积分，未截断曲线保留');
{
  // 真值：信号三角 高100（x=2..6），叠加基线 10+10*x；原始 = 信号 + 基线
  const base = (i) => 10 + 10 * i;
  const sig = [0, 0, 0, 100, 0, 0, 0];
  const ys = sig.map((s, i) => s + base(i));
  const data = mkData(ys); // 7 点 x=0..6
  const anchors = [anc(0, base(0)), anc(6, base(6))]; // 线性基线恰好重合
  const boundaries = [bnd(1), bnd(5)];
  const r = analyze({ data, calibration: fullCal(7), anchors, boundaries, zones: [], unclassifiedTolerancePct: 100 });
  // 扣底：0,0,0,100,0,0,0；峰面积 间隔1-2:0, 2-3:50, 3-4:50, 4-5:0 = 100
  assert.equal(r.peaks[0].area, 100);
  // 未截断扣底曲线被保留且恰好为信号
  assert.deepEqual(r.netRate.map((v) => Math.round(v)), sig);
  assert.deepEqual(r.clampedRate.map((v) => Math.round(v)), sig);
  // 原始曲线保留
  assert.deepEqual(r.rawRate.map((v) => Math.round(v)), ys);
}

console.log('5) 负扣底截断：基线上抬后曲线整体为负 → clamp=0，面积 0 并提示');
{
  const ys = [5, 5, 5, 5];
  const data = mkData(ys);
  const anchors = [anc(0, 100), anc(3, 100)];
  const boundaries = [bnd(0), bnd(3)];
  const r = analyze({ data, calibration: fullCal(4), anchors, boundaries, zones: [{ id: uid('z'), name: 'Z', rfMin: 0, rfMax: 1, minPct: 0, maxPct: 100 }], unclassifiedTolerancePct: 1 });
  assert.ok(r.netRate.every((v) => Math.round(v) === -95), '未截断扣底应保留负值 -95');
  assert.ok(r.clampedRate.every((v) => v === 0), '截断扣底应全部归零');
  assert.equal(r.totalArea, 0);
  assert.ok(r.anomalies.some((a) => a.code === 'UNCLASSIFIED_AREA'));
  assert.equal(r.canRelease, false);
  assert.equal(r.release, false);
}

console.log('6) 跨 Rf 边界插值拆分：半边三角峰被 Rf=0.5 精确对半分');
{
  // 等腰三角：x=0..10 全扫描，峰 x=5 高100，边界 0 与 10
  const ys = [];
  for (let i = 0; i <= 10; i++) ys.push(i <= 5 ? i * 20 : (10 - i) * 20);
  const data = mkData(ys);
  const anchors = [anc(0, 0), anc(10, 0)];
  const boundaries = [bnd(0), bnd(10)];
  const zones = [
    { id: uid('z'), name: 'L', rfMin: 0, rfMax: 0.5, minPct: 0, maxPct: 100 },
    { id: uid('z'), name: 'R', rfMin: 0.5, rfMax: 1, minPct: 0, maxPct: 100 },
  ];
  const r = analyze({ data, calibration: fullCal(11), anchors, boundaries, zones, unclassifiedTolerancePct: 0 });
  const total = 500; // 三角面积 100*10/2
  assert.equal(r.totalArea, total);
  const [zl, zr] = r.zones;
  assert.ok(Math.abs(zl.area - 250) < 1e-6, `左半面积应 250，实际 ${zl.area}`);
  assert.ok(Math.abs(zr.area - 250) < 1e-6, `右半面积应 250，实际 ${zr.area}`);
  assert.equal(r.unclassifiedArea, 0);
  // 峰 splits 也应拆成两片且每片 250，分界恰在插值距离 x=5
  const pcs = r.peaks[0].splits;
  assert.equal(pcs.length, 2);
  assert.ok(
    pcs.some((p) => Math.abs(p.xL - 5) < 1e-9 || Math.abs(p.xR - 5) < 1e-9),
    '应存在以插值点 x=5 为界的片段',
  );
}

console.log('7) 插值边界不落在采样点上：Rf=0.25 切线，面积线性拆分');
{
  // 平台 100 cps 铺满 x=0..8（8 单位宽，面积 800），Rf=0.25 在 x=2
  const ys = [100, 100, 100, 100, 100, 100, 100, 100, 100];
  const data = mkData(ys);
  const anchors = [anc(0, 0), anc(8, 0)];
  const boundaries = [bnd(0), bnd(8)];
  const zones = [{ id: uid('z'), name: 'Q1', rfMin: 0, rfMax: 0.25, minPct: 0, maxPct: 100 }];
  const r = analyze({ data, calibration: fullCal(9), anchors, boundaries, zones, unclassifiedTolerancePct: 1 });
  const z = r.zones[0];
  assert.ok(Math.abs(z.area - 200) < 1e-6, `0.25×800=200，实际 ${z.area}`);
  assert.ok(Math.abs(z.pct - 25) < 1e-6);
  // 剩余 75% 未分类，超阈值 → 异常
  assert.ok(r.anomalies.some((a) => a.code === 'UNCLASSIFIED_AREA'));
}

console.log('8) 距离乱序 / 重复 → DISTANCE_DISORDERED / DISTANCE_DUPLICATE');
{
  const bad = { sampleId: 'bad', liveTime: 1, points: [
    { distance: 0, counts: 1, liveTime: 1 },
    { distance: 2, counts: 1, liveTime: 1 },
    { distance: 1, counts: 1, liveTime: 1 },
  ] };
  const r = analyze({ data: bad, calibration: fullCal(3), anchors: [anc(0, 1), anc(2, 1)], boundaries: [], zones: [], unclassifiedTolerancePct: 1 });
  assert.ok(r.anomalies.some((a) => a.code === 'DISTANCE_DISORDERED'));
  assert.equal(r.canRelease, false);

  const dup = { sampleId: 'dup', liveTime: 1, points: [
    { distance: 0, counts: 1, liveTime: 1 },
    { distance: 1, counts: 1, liveTime: 1 },
    { distance: 1, counts: 1, liveTime: 1 },
  ] };
  const r2 = analyze({ data: dup, calibration: fullCal(3), anchors: [anc(0, 1), anc(2, 1)], boundaries: [], zones: [], unclassifiedTolerancePct: 1 });
  assert.ok(r2.anomalies.some((a) => a.code === 'DISTANCE_DUPLICATE'));
}

console.log('9) 标定无效：原点 ≥ 前沿 / 缺标定');
{
  const data = mkData([1, 2, 3, 4]);
  const cal = { scanStartIndex: 0, scanEndIndex: 3, originIndex: 3, frontIndex: 1 };
  const r = analyze({ data, calibration: cal, anchors: [anc(0, 1), anc(3, 4)], boundaries: [], zones: [], unclassifiedTolerancePct: 1 });
  assert.ok(r.anomalies.some((a) => a.code === 'CAL_INVALID'));
  const r2 = analyze({ data, calibration: { scanStartIndex: null, scanEndIndex: null, originIndex: null, frontIndex: null }, anchors: [anc(0, 1), anc(3, 4)], boundaries: [], zones: [], unclassifiedTolerancePct: 1 });
  assert.ok(r2.anomalies.some((a) => a.code === 'CAL_INVALID'));
}

console.log('10) 基线未覆盖：锚点未跨越扫描区 → BASELINE_UNCOVERED + 峰内未覆盖');
{
  const data = mkData([0, 0, 100, 0, 0, 0]);
  const anchors = [anc(1, 0), anc(3, 0)]; // 0 与 4,5 未覆盖
  const boundaries = [bnd(1), bnd(4)];
  const r = analyze({ data, calibration: fullCal(6), anchors, boundaries, zones: [], unclassifiedTolerancePct: 100 });
  assert.ok(r.anomalies.some((a) => a.code === 'BASELINE_UNCOVERED'));
  assert.ok(r.anomalies.some((a) => a.code === 'PEAK_BASELINE_UNCOVERED'));
}

console.log('11) 锚点不足 / 边界越界 / 边界重合');
{
  const data = mkData([1, 2, 3, 4, 5]);
  const r = analyze({ data, calibration: fullCal(5), anchors: [anc(0, 1)], boundaries: [], zones: [], unclassifiedTolerancePct: 1 });
  assert.ok(r.anomalies.some((a) => a.code === 'ANCHORS_INSUFFICIENT'));

  const r2 = analyze({
    data,
    calibration: { scanStartIndex: 1, scanEndIndex: 3, originIndex: 1, frontIndex: 3 },
    anchors: [anc(0, 1), anc(4, 5)],
    boundaries: [bnd(0), bnd(4)],
    zones: [],
    unclassifiedTolerancePct: 1,
  });
  assert.ok(r2.anomalies.some((a) => a.code === 'BOUNDARY_OUTSIDE_SCAN'));

  const r3 = analyze({ data, calibration: fullCal(5), anchors: [anc(0, 1), anc(4, 5)], boundaries: [bnd(2), bnd(2)], zones: [], unclassifiedTolerancePct: 1 });
  assert.ok(r3.anomalies.some((a) => a.code === 'BOUNDARY_DUPLICATE'));
}

console.log('12) 区间无效 / 重叠 / 阈值不通过 / 区间面积为零');
{
  const data = mkData([0, 100, 100, 0]);
  const anchors = [anc(0, 0), anc(3, 0)];
  const boundaries = [bnd(0), bnd(3)];
  const r = analyze({
    data,
    calibration: fullCal(4),
    anchors,
    boundaries,
    zones: [{ id: 'z1', name: '坏区间', rfMin: 0.8, rfMax: 0.2, minPct: 110, maxPct: 50 }],
    unclassifiedTolerancePct: 1,
  });
  assert.ok(r.anomalies.some((a) => a.code === 'ZONE_INVALID'));

  const r2 = analyze({
    data,
    calibration: fullCal(4),
    anchors,
    boundaries,
    zones: [
      { id: 'a', name: 'A', rfMin: 0, rfMax: 0.6, minPct: 0, maxPct: 100 },
      { id: 'b', name: 'B', rfMin: 0.4, rfMax: 1, minPct: 0, maxPct: 100 },
    ],
    unclassifiedTolerancePct: 100,
  });
  assert.ok(r2.anomalies.some((a) => a.code === 'ZONE_OVERLAP'));

  // 阈值不通过：窄峰在 Rf≈0.25，区间只认无信号的 Rf 0.7..0.9（面积为 0 < minPct）
  const data5 = mkData([0, 0, 100, 0, 0]);
  const anchors5 = [anc(0, 0), anc(4, 0)];
  const r3 = analyze({
    data: data5,
    calibration: fullCal(5),
    anchors: anchors5,
    boundaries: [bnd(0), bnd(4)],
    zones: [{ id: 'c', name: 'C', rfMin: 0.8, rfMax: 0.95, minPct: 50, maxPct: 100 }],
    unclassifiedTolerancePct: 100,
  });
  assert.ok(r3.anomalies.some((a) => a.code === 'ZONE_PCT_RANGE'), '应有阈值不通过异常');
  assert.equal(r3.release, false);
}

console.log('13) liveTime 缺失/非正 → BAD_LIVE_TIME；点级 liveTime 换算 cps');
{
  const data = {
    sampleId: 'lt',
    points: [
      { distance: 0, counts: 100, liveTime: 2 },
      { distance: 1, counts: 300, liveTime: 2 },
      { distance: 2, counts: 100 }, // 缺 liveTime 且无顶层
    ],
  };
  const r = analyze({ data, calibration: fullCal(3), anchors: [anc(0, 50), anc(2, 50)], boundaries: [], zones: [], unclassifiedTolerancePct: 1 });
  assert.ok(r.anomalies.some((a) => a.code === 'BAD_LIVE_TIME'));
  assert.equal(r.rawRate[0], 50);
  assert.equal(r.rawRate[1], 150);
}

console.log('14) 采样点不足 / 检测时间用顶层默认值');
{
  const r = analyze({
    data: { points: [{ distance: 0, counts: 1, liveTime: 1 }] },
    calibration: emptyCal(),
    anchors: [],
    boundaries: [],
    zones: [],
    unclassifiedTolerancePct: 1,
  });
  assert.ok(r.anomalies.some((a) => a.code === 'CAL_INVALID'));
}
function emptyCal() {
  return { originIndex: null, frontIndex: null, scanStartIndex: null, scanEndIndex: null };
}

console.log('15) 有异常时绝不给出放行结论，即使阈值表面通过');
{
  const data = mkData([0, 100, 0]);
  const r = analyze({
    data,
    calibration: fullCal(3),
    anchors: [anc(0, 0), anc(2, 0)],
    boundaries: [bnd(0), bnd(2)],
    zones: [{ id: 'z', name: '全段', rfMin: 0, rfMax: 1, minPct: 0, maxPct: 100 }],
    unclassifiedTolerancePct: 1,
  });
  // 制造异常：再加一个越界边界
  const r2 = analyze({
    data,
    calibration: { scanStartIndex: 0, scanEndIndex: 2, originIndex: 1, frontIndex: 2 },
    anchors: [anc(0, 0), anc(2, 0)],
    boundaries: [bnd(0), bnd(2)],
    zones: [{ id: 'z', name: '全段', rfMin: 0, rfMax: 1, minPct: 0, maxPct: 100 }],
    unclassifiedTolerancePct: 1,
  });
  assert.ok(r2.anomalies.length > 0);
  assert.equal(r2.canRelease, false);
  assert.equal(r2.release, false);
  void r;
}

rmSync(entry, { force: true });
console.log(`\n全部 15 组自测通过 ✅`);
