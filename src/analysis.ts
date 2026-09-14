// radio-TLC 归算核心：输入校验、基线插值、扣底、峰识别、
// 梯形积分、跨区插值拆分、阈值判定与异常归集。
// 纯函数，无 DOM 依赖，可被 React 界面与 Node 自测脚本共同调用。

import type {
  AnalysisResult,
  Anchor,
  Anomaly,
  Boundary,
  Calibration,
  PeakResult,
  RfZone,
  SplitPiece,
  Trap,
  TLCDataSet,
  ZoneSummary,
} from './types';

let uidCounter = 0;
export const uid = (p: string): string => `${p}_${Date.now().toString(36)}_${(uidCounter++).toString(36)}`;

const pushAnom = (
  list: Anomaly[],
  code: Anomaly['code'],
  message: string,
  extra: Partial<Anomaly> = {},
): void => {
  list.push({ code, message, severity: 'error', ...extra });
};

export interface AnalysisInput {
  data: TLCDataSet;
  calibration: Calibration;
  anchors: Anchor[];
  boundaries: Boundary[];
  zones: RfZone[];
  unclassifiedTolerancePct: number;
}

/** 由数据本身推断合理默认值（载入数据后调用一次） */
export function defaultAnchors(data: TLCDataSet, rate: number[]): Anchor[] {
  const n = data.points.length;
  if (n < 2) return [];
  // 端锚取端部邻域最低计数率，避免把端点噪声当成基线
  const win = Math.max(1, Math.floor(n * 0.03));
  const edgeLevel = (center: number, dir: -1 | 1): number => {
    let lo = Infinity;
    for (let k = 0; k <= win; k++) {
      const i = center + dir * k;
      if (i >= 0 && i < n) lo = Math.min(lo, rate[i]);
    }
    return Number.isFinite(lo) ? lo : rate[center];
  };
  return [
    { id: uid('anc'), index: 0, y: edgeLevel(0, 1) },
    { id: uid('anc'), index: n - 1, y: edgeLevel(n - 1, -1) },
  ];
}

/**
 * 简易峰谷自动检测（用于载入时给出可拖动的初始边界，不参与正式判定）。
 * 在“减去滑动最小值”后的信号上找局部极大，峰间取最低采样点为共享谷；
 * 返回去重升序的内部谷点索引，调用方自行补两端。
 */
export function suggestValleys(data: TLCDataSet, rate: number[]): number[] {
  const n = data.points.length;
  if (n < 8) return [];
  // 滑动最小（窗口约为扫描长度的 6%）近似基线
  const w = Math.max(2, Math.round(n * 0.06));
  const detrend = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let lo = Infinity;
    for (let k = -w; k <= w; k++) {
      const j = i + k;
      if (j >= 0 && j < n) lo = Math.min(lo, rate[j]);
    }
    detrend[i] = rate[i] - lo;
  }
  const maxV = Math.max(...detrend);
  if (!(maxV > 0)) return [];
  const prom = maxV * 0.08; // 显著性阈值
  // 局部极大
  const apexes: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (detrend[i] >= prom && detrend[i] >= detrend[i - 1] && detrend[i] >= detrend[i + 1]) {
      if (apexes.length === 0 || i - apexes[apexes.length - 1] > w) apexes.push(i);
      else if (detrend[i] > detrend[apexes[apexes.length - 1]]) apexes[apexes.length - 1] = i;
    }
  }
  if (apexes.length < 2) return [];
  const valleys = new Set<number>();
  for (let k = 0; k + 1 < apexes.length; k++) {
    let vi = apexes[k] + 1;
    let vv = Infinity;
    for (let i = apexes[k] + 1; i < apexes[k + 1]; i++) {
      if (detrend[i] < vv) {
        vv = detrend[i];
        vi = i;
      }
    }
    if (vi > 0 && vi < n - 1) valleys.add(vi);
  }
  return [...valleys].sort((a, b) => a - b);
}

/** 分段线性插值基线；锚点覆盖范围之外返回 null（=未覆盖） */
export function piecewiseBaseline(n: number, anchors: Anchor[]): (number | null)[] {
  const out: (number | null)[] = new Array(n).fill(null);
  const sorted = [...anchors].filter((a) => a.index >= 0 && a.index < n).sort((a, b) => a.index - b.index);
  if (sorted.length === 0) return out;
  // 同一索引上的多锚点取均值（正常不应出现）
  const byIndex = new Map<number, number[]>();
  for (const a of sorted) {
    const arr = byIndex.get(a.index) ?? [];
    arr.push(a.y);
    byIndex.set(a.index, arr);
  }
  const pts = [...byIndex.entries()]
    .map(([index, ys]) => ({ index, y: ys.reduce((s, v) => s + v, 0) / ys.length }))
    .sort((a, b) => a.index - b.index);

  const first = pts[0];
  const last = pts[pts.length - 1];
  for (let i = first.index; i <= last.index; i++) {
    // 找包围 i 的锚点段
    let segR = pts.findIndex((p) => p.index >= i);
    if (segR < 0) segR = pts.length - 1;
    if (pts[segR].index === i || segR === 0) {
      out[i] = pts[segR].index === i ? pts[segR].y : pts[0].y;
    } else {
      const pL = pts[segR - 1];
      const pR = pts[segR];
      const t = (i - pL.index) / (pR.index - pL.index);
      out[i] = pL.y + t * (pR.y - pL.y);
    }
  }
  return out;
}

/** 线性插值求任意距离处的截断扣底值（用于 Rf 边界拆峰）；越界或未覆盖返回 null */
function interpClamped(x: number, dist: number[], clamped: (number | null)[]): number | null {
  const n = dist.length;
  if (x < dist[0] || x > dist[n - 1]) return null;
  // 定位区间
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= x) lo = mid;
    else hi = mid;
  }
  const yL = clamped[lo];
  const yR = clamped[hi];
  if (yL === null || yR === null) return null;
  if (dist[hi] === dist[lo]) return yL;
  const t = (x - dist[lo]) / (dist[hi] - dist[lo]);
  return Math.max(0, yL + t * (yR - yL));
}

/** 两采样点间的梯形片段，可能被若干切分距离（Rf 边界）再切分，按区间归类 */
function splitInterval(
  iL: number,
  iR: number,
  dist: number[],
  clamped: (number | null)[],
  cuts: { x: number; zoneId: string | null }[],
  zoneOf: (x: number) => { zoneId: string | null; zoneName: string | null },
): SplitPiece[] {
  const xL = dist[iL];
  const xR = dist[iR];
  const yL = clamped[iL];
  const yR = clamped[iR];
  if (yL === null || yR === null) return [];
  // 区间内的切分点（不含端点）
  const inner = cuts.filter((c) => c.x > xL + 1e-9 && c.x < xR - 1e-9).sort((a, b) => a.x - b.x);
  const boundaries = [xL, ...inner.map((c) => c.x), xR];
  const pieces: SplitPiece[] = [];
  for (let k = 0; k < boundaries.length - 1; k++) {
    const a = boundaries[k];
    const b = boundaries[k + 1];
    const ya = a === xL ? yL : (interpClamped(a, dist, clamped) ?? 0);
    const yb = b === xR ? yR : (interpClamped(b, dist, clamped) ?? 0);
    const area = ((ya + yb) / 2) * (b - a);
    const mid = (a + b) / 2;
    const z = zoneOf(mid);
    pieces.push({
      zoneId: z.zoneId,
      zoneName: z.zoneName,
      xL: a,
      xR: b,
      yL: ya,
      yR: yb,
      area,
      interpolatedLeft: a !== xL,
      interpolatedRight: b !== xR,
    });
  }
  return pieces;
}

function fmt(n: number, digits = 4): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function analyze(input: AnalysisInput): AnalysisResult {
  const { data, calibration, anchors, boundaries, zones, unclassifiedTolerancePct } = input;
  const anomalies: Anomaly[] = [];
  const n = data.points.length;
  const computedAt = new Date().toISOString();

  const empty: AnalysisResult = {
    plottable: false,
    anomalies,
    rawRate: [],
    baseline: new Array(n).fill(null),
    netRate: new Array(n).fill(null),
    clampedRate: new Array(n).fill(null),
    peaks: [],
    zones: [],
    totalArea: 0,
    unclassifiedArea: 0,
    unclassifiedPct: 0,
    unclassifiedTolerancePct,
    originDistance: null,
    frontDistance: null,
    scanStartIndex: null,
    scanEndIndex: null,
    canRelease: false,
    release: false,
    thresholdChecks: [],
    computedAt,
  };

  if (n < 2) {
    pushAnom(anomalies, 'CAL_INVALID', '采样点不足 2 个，无法构成色谱曲线。');
    return empty;
  }

  // ---- 1. 距离校验：严格单调递增 ----
  let disordered = false;
  let duplicate = false;
  const dupIndices: number[] = [];
  const dropIndices: number[] = [];
  for (let i = 1; i < n; i++) {
    const dPrev = data.points[i - 1].distance;
    const d = data.points[i].distance;
    if (!Number.isFinite(dPrev) || !Number.isFinite(d)) {
      disordered = true;
      dropIndices.push(i);
    } else if (d < dPrev) {
      disordered = true;
      dropIndices.push(i);
    } else if (d === dPrev) {
      duplicate = true;
      dupIndices.push(i);
    }
  }
  if (disordered) {
    pushAnom(anomalies, 'DISTANCE_DISORDERED', '检测到距离乱序（或存在非数值距离）。请核对扫描方向与数据列后重新导入。', {
      atIndex: dropIndices[0],
      detail: { firstBadIndex: dropIndices[0] ?? -1, badPointCount: dropIndices.length },
    });
  }
  if (duplicate) {
    pushAnom(anomalies, 'DISTANCE_DUPLICATE', '检测到重复距离采样点，梯形积分要求距离严格单调递增。', {
      atIndex: dupIndices[0],
      detail: { firstDupIndex: dupIndices[0] ?? -1, dupPointCount: dupIndices.length },
    });
  }

  // ---- 2. 计数率（cps）与检测时间校验 ----
  const globalLive = data.liveTime;
  const rawRate: number[] = new Array(n);
  let badLive = false;
  for (let i = 0; i < n; i++) {
    const p = data.points[i];
    const lt = p.liveTime ?? globalLive;
    if (
      lt === undefined ||
      lt === null ||
      !Number.isFinite(lt) ||
      lt <= 0 ||
      !Number.isFinite(p.counts) ||
      p.counts < 0
    ) {
      badLive = true;
      rawRate[i] = Number.isFinite(p.counts) ? p.counts : 0;
    } else {
      rawRate[i] = p.counts / lt;
    }
  }
  if (badLive) {
    pushAnom(
      anomalies,
      'BAD_LIVE_TIME',
      '存在检测活时间缺失/非正或计数非法的采样点，无法换算计数率（cps）。请补全点级 liveTime 或顶层 liveTime。',
    );
  }

  const dist = data.points.map((p) => p.distance);
  const plottable = !disordered && !duplicate && n >= 2;

  // ---- 3. 基线：分段线性插值，逐点扣底 ----
  const validAnchors = anchors.filter((a) => a.index >= 0 && a.index < n);
  if (validAnchors.length < 2) {
    pushAnom(anomalies, 'ANCHORS_INSUFFICIENT', '基线锚点少于 2 个，无法进行分段线性插值。请至少在曲线两端各放置一个锚点。');
  }
  const baseline = piecewiseBaseline(n, anchors);
  const netRate: (number | null)[] = new Array(n).fill(null);
  const clampedRate: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (baseline[i] !== null) {
      const net = rawRate[i] - (baseline[i] as number);
      netRate[i] = net;
      clampedRate[i] = Math.max(0, net);
    }
  }

  // ---- 4. 标定校验 ----
  const { originIndex, frontIndex, scanStartIndex, scanEndIndex } = calibration;
  const calEntries: { key: keyof Calibration; label: string; value: number | null }[] = [
    { key: 'originIndex', label: '点样原点', value: originIndex },
    { key: 'frontIndex', label: '溶剂前沿', value: frontIndex },
    { key: 'scanStartIndex', label: '有效扫描区起点', value: scanStartIndex },
    { key: 'scanEndIndex', label: '有效扫描区终点', value: scanEndIndex },
  ];
  const nullCal = calEntries.some((e) => e.value === null);
  const oobCal = calEntries.some((e) => e.value !== null && (e.value! < 0 || e.value! >= n));
  const orderOk =
    originIndex !== null &&
    frontIndex !== null &&
    scanStartIndex !== null &&
    scanEndIndex !== null &&
    scanStartIndex <= originIndex &&
    originIndex < frontIndex &&
    frontIndex <= scanEndIndex;
  if (nullCal || oobCal || !(plottable && orderOk)) {
    const missing = calEntries.filter((e) => e.value === null).map((e) => e.label).join('、');
    pushAnom(
      anomalies,
      'CAL_INVALID',
      `标定无效：${missing ? `缺少 ${missing}；` : ''}需满足 扫描起点 ≤ 点样原点 < 溶剂前沿 ≤ 扫描终点。`,
    );
  }

  const originDistance = originIndex !== null ? dist[originIndex] : null;
  const frontDistance = frontIndex !== null ? dist[frontIndex] : null;
  const rfOfIndex = (i: number): number => {
    if (originDistance === null || frontDistance === null) return NaN;
    const denom = frontDistance - originDistance;
    if (denom <= 0) return NaN;
    return (dist[i] - originDistance) / denom;
  };
  const xOfRf = (rf: number): number | null => {
    if (originDistance === null || frontDistance === null) return null;
    return originDistance + rf * (frontDistance - originDistance);
  };

  // ---- 5. 边界校验 ----
  const bIdx = boundaries.map((b) => b.index);
  const bOutside = bIdx.filter((i) => scanStartIndex === null || scanEndIndex === null || i < scanStartIndex || i > scanEndIndex);
  if (bOutside.length > 0) {
    pushAnom(anomalies, 'BOUNDARY_OUTSIDE_SCAN', '存在落在有效扫描区之外的峰谷边界。', {
      atIndex: bOutside[0],
      detail: { count: bOutside.length },
    });
  }
  const bDup = bIdx.filter((i, k) => bIdx.indexOf(i) !== k);
  if (bDup.length > 0) {
    pushAnom(anomalies, 'BOUNDARY_DUPLICATE', '存在重合的峰谷边界（同一谷点只应放置一个边界，由相邻两峰共享）。', {
      atIndex: bDup[0],
    });
  }
  const sortedB = [...bIdx].sort((a, b) => a - b);
  // 边界交叉：用户拖动后边界原始顺序可能逆序（共享谷点模型下同点已按重合处理）
  const crossed = bIdx.some((v, k) => k > 0 && v < bIdx[k - 1]);
  if (crossed) {
    pushAnom(anomalies, 'BOUNDARY_UNORDERED', '峰谷边界出现交叉/逆序，请自左向右整理边界。');
  }

  // ---- 6. 有效扫描区内基线覆盖检查 ----
  const scanLo = scanStartIndex ?? 0;
  const scanHi = scanEndIndex ?? n - 1;
  const uncoveredScan: number[] = [];
  for (let i = scanLo; i <= scanHi; i++) {
    if (baseline[i] === null) uncoveredScan.push(i);
  }
  if (uncoveredScan.length > 0) {
    pushAnom(
      anomalies,
      'BASELINE_UNCOVERED',
      `有效扫描区内有 ${uncoveredScan.length} 个采样点未被基线锚点覆盖（最左/最右锚点须跨越整个扫描区）。`,
      { atIndex: uncoveredScan[0], detail: { firstUncoveredIndex: uncoveredScan[0], count: uncoveredScan.length } },
    );
  }

  // ---- 7. 峰识别：边界两两夹一个峰 ----
  const peaks: PeakResult[] = [];
  const usableBounds = sortedB.filter(
    (i) => i >= 0 && i < n && i >= scanLo && i <= scanHi,
  );
  // 去重后构造峰
  const uniqBounds = [...new Set(usableBounds)].sort((a, b) => a - b);
  for (let k = 0; k + 1 < uniqBounds.length; k++) {
    const lBi = uniqBounds[k];
    const rBi = uniqBounds[k + 1];
    if (rBi <= lBi) continue;

    // 峰内逐间隔梯形积分（截断扣底曲线），共享谷点只作为共同端点
    const traps: Trap[] = [];
    let area = 0;
    let peakUncovered = false;
    for (let i = lBi; i < rBi; i++) {
      const yL = clampedRate[i];
      const yR = clampedRate[i + 1];
      if (yL === null || yR === null) {
        peakUncovered = true;
        continue;
      }
      const xL = dist[i];
      const xR = dist[i + 1];
      const ta = ((yL + yR) / 2) * (xR - xL);
      traps.push({
        iL: i,
        iR: i + 1,
        xL: fmt(xL),
        xR: fmt(xR),
        yL: fmt(yL),
        yR: fmt(yR),
        area: fmt(ta),
      });
      area += ta;
    }
    if (peakUncovered) {
      pushAnom(
        anomalies,
        'PEAK_BASELINE_UNCOVERED',
        `第 ${k + 1} 号峰内部存在基线未覆盖的采样间隔，面积积分不完整。`,
        { peakIndex: k },
      );
    }

    // 峰顶：截断扣底后最高点（同高取最左）
    let apexIndex = lBi;
    let apexVal = -Infinity;
    for (let i = lBi; i <= rBi; i++) {
      const v = clampedRate[i] ?? -Infinity;
      if (v > apexVal) {
        apexVal = v;
        apexIndex = i;
      }
    }
    const rf = rfOfIndex(apexIndex);
    if (Number.isNaN(rf) || rf < 0 || rf > 1) {
      pushAnom(
        anomalies,
        'PEAK_RF_OUT_OF_RANGE',
        `第 ${k + 1} 号峰峰顶 Rf 超出 [0,1]，标定与峰顶位置异常。`,
        { peakIndex: k, atIndex: apexIndex, detail: { rf: fmt(rf) } },
      );
    }

    peaks.push({
      no: k + 1,
      leftBoundaryIndex: lBi,
      rightBoundaryIndex: rBi,
      apexIndex,
      apexDistance: fmt(dist[apexIndex]),
      rf: fmt(rf),
      area: fmt(area),
      pct: 0,
      baselineUncovered: peakUncovered,
      traps,
      splits: [],
    });
  }

  // ---- 8. 有效扫描区总面积（截断扣底曲线逐间隔梯形积分） ----
  let totalArea = 0;
  for (let i = scanLo; i < scanHi; i++) {
    const yL = clampedRate[i];
    const yR = clampedRate[i + 1];
    if (yL === null || yR === null) continue;
    totalArea += ((yL + yR) / 2) * (dist[i + 1] - dist[i]);
  }
  totalArea = fmt(totalArea, 6);

  // ---- 9. 具名 Rf 区间校验与拆分 ----
  const zoneAnomalySeen = new Set<string>();
  for (const z of zones) {
    const bad =
      !Number.isFinite(z.rfMin) ||
      !Number.isFinite(z.rfMax) ||
      z.rfMin < 0 ||
      z.rfMax > 1 ||
      z.rfMin >= z.rfMax ||
      !Number.isFinite(z.minPct) ||
      !Number.isFinite(z.maxPct) ||
      z.minPct < 0 ||
      z.maxPct > 100 ||
      z.minPct > z.maxPct;
    if (bad && !zoneAnomalySeen.has(z.id)) {
      zoneAnomalySeen.add(z.id);
      pushAnom(anomalies, 'ZONE_INVALID', `区间「${z.name}」配置无效：须满足 0 ≤ Rf下限 < Rf上限 ≤ 1，0 ≤ 下限% ≤ 上限% ≤ 100。`, {
        zoneId: z.id,
      });
    }
  }
  // 区间重叠检测（闭区间重叠共享边界允许；严格重叠才算）
  const validZones = zones.filter(
    (z) => Number.isFinite(z.rfMin) && Number.isFinite(z.rfMax) && z.rfMin >= 0 && z.rfMax <= 1 && z.rfMin < z.rfMax,
  );
  for (let a = 0; a < validZones.length; a++) {
    for (let b = a + 1; b < validZones.length; b++) {
      const za = validZones[a];
      const zb = validZones[b];
      if (za.rfMin < zb.rfMax && zb.rfMin < za.rfMax) {
        pushAnom(anomalies, 'ZONE_OVERLAP', `具名 Rf 区间「${za.name}」与「${zb.name}」重叠，面积分类会产生歧义。`, {
          zoneId: za.id,
        });
      }
    }
  }

  // Rf 切分线（所有区间边界投影到距离轴）
  const cutXs: { x: number; rf: number }[] = [];
  for (const z of validZones) {
    for (const rf of [z.rfMin, z.rfMax]) {
      const x = xOfRf(rf);
      if (x !== null && Number.isFinite(x)) cutXs.push({ x, rf });
    }
  }
  // 距离中点归属区间
  const zoneOf = (x: number): { zoneId: string | null; zoneName: string | null } => {
    if (originDistance === null || frontDistance === null) return { zoneId: null, zoneName: null };
    const rf = (x - originDistance) / (frontDistance - originDistance);
    // 边界点归属：[rfMin, rfMax) 归本区间，rfMax 归下一个；用中点归类天然避开等值
    for (const z of validZones) {
      if (rf >= z.rfMin && rf <= z.rfMax) return { zoneId: z.id, zoneName: z.name };
    }
    return { zoneId: null, zoneName: null };
  };

  // 逐峰拆分
  for (const peak of peaks) {
    const pieces: SplitPiece[] = [];
    for (const trap of peak.traps) {
      const iL = trap.iL;
      const iR = trap.iR;
      const piecesIn = splitInterval(
        iL,
        iR,
        dist,
        clampedRate,
        cutXs.map((c) => ({ x: c.x, zoneId: null })),
        zoneOf,
      );
      // 合并同区间相邻片段以便展示（保留整体两端的插值标记）
      for (const pc of piecesIn) {
        const last = pieces[pieces.length - 1];
        if (last && last.zoneId === pc.zoneId && Math.abs(last.xR - pc.xL) < 1e-9) {
          last.xR = pc.xR;
          last.yR = pc.yR;
          last.area += pc.area;
          last.interpolatedRight = pc.interpolatedRight;
        } else {
          pieces.push({ ...pc, area: pc.area });
        }
      }
    }
    for (const pc of pieces) pc.area = fmt(pc.area);
    peak.splits = pieces;
  }

  // ---- 10. 区间汇总、占比与未分类面积 ----
  // 分类口径：在整个有效扫描区上逐间隔积分、按 Rf 切分线拆分（不依赖峰谷边界），
  // 保证峰外平台/肩峰不漏算；峰内 splits 仅用于逐峰算式展示。
  const zoneAreaFull = new Map<string, number>();
  let fullUnclassified = 0;
  for (let i = scanLo; i < scanHi; i++) {
    const yL = clampedRate[i];
    const yR = clampedRate[i + 1];
    if (yL === null || yR === null) continue;
    const pcs = splitInterval(
      i,
      i + 1,
      dist,
      clampedRate,
      cutXs.map((c) => ({ x: c.x, zoneId: null })),
      zoneOf,
    );
    for (const pc of pcs) {
      if (pc.zoneId) zoneAreaFull.set(pc.zoneId, (zoneAreaFull.get(pc.zoneId) ?? 0) + pc.area);
      else fullUnclassified += pc.area;
    }
  }
  const zoneSummaries: ZoneSummary[] = validZones.map((z) => {
    const area = fmt(zoneAreaFull.get(z.id) ?? 0, 6);
    const pct = totalArea > 0 ? fmt((100 * area) / totalArea) : 0;
    return {
      zoneId: z.id,
      name: z.name,
      rfMin: z.rfMin,
      rfMax: z.rfMax,
      xMin: fmt(xOfRf(z.rfMin) ?? NaN),
      xMax: fmt(xOfRf(z.rfMax) ?? NaN),
      area,
      pct,
      minPct: z.minPct,
      maxPct: z.maxPct,
      pass: pct >= z.minPct && pct <= z.maxPct,
    };
  });
  const finalUnclassified = fmt(fullUnclassified, 6);
  const finalUnclassifiedPct = totalArea > 0 ? fmt((100 * fullUnclassified) / totalArea) : 0;

  // 峰占比（以总面积为分母）
  for (const p of peaks) p.pct = totalArea > 0 ? fmt((100 * p.area) / totalArea) : 0;

  if (totalArea <= 0) {
    pushAnom(anomalies, 'UNCLASSIFIED_AREA', '有效扫描区扣底后总面积为 0，无法计算面积百分比。');
  } else if (finalUnclassifiedPct > unclassifiedTolerancePct) {
    pushAnom(
      anomalies,
      'UNCLASSIFIED_AREA',
      `存在 ${finalUnclassifiedPct}% 的面积未落入任何具名 Rf 区间（容差 ${unclassifiedTolerancePct}%）。请补全区间定义或检查峰谷边界。`,
      { detail: { unclassifiedPct: finalUnclassifiedPct, tolerancePct: unclassifiedTolerancePct } },
    );
  }

  // ---- 11. 阈值逐条判定 ----
  const thresholdChecks = zoneSummaries.map((z) => ({
    zoneId: z.zoneId,
    name: z.name,
    pass: z.pass,
    pct: z.pct,
    minPct: z.minPct,
    maxPct: z.maxPct,
  }));
  for (const z of zoneSummaries) {
    // 注：区间面积为 0 且 minPct=0 属合法（无该杂质）；仅当不满足阈值时记异常
    if (!z.pass) {
      pushAnom(
        anomalies,
        'ZONE_PCT_RANGE',
        `区间「${z.name}」面积占比 ${z.pct}% 不在阈值 [${z.minPct}%, ${z.maxPct}%] 内。`,
        { zoneId: z.zoneId, detail: { pct: z.pct, minPct: z.minPct, maxPct: z.maxPct } },
      );
    }
  }

  // 未配置任何阈值时无法出具结论（记为异常）
  if (anomalies.length === 0 && thresholdChecks.length === 0) {
    pushAnom(anomalies, 'ZONE_INVALID', '未配置任何具名 Rf 区间阈值，无法出具放行结论。');
  }

  // 判定规则：存在任意异常即不生成放行结论；无异常时每条阈值均通过才整组放行
  const canRelease = anomalies.length === 0;
  const release = canRelease && thresholdChecks.every((c) => c.pass);

  return {
    plottable,
    anomalies,
    rawRate: rawRate.map((v) => fmt(v, 6)),
    baseline: baseline.map((v) => (v === null ? null : fmt(v, 6))),
    netRate: netRate.map((v) => (v === null ? null : fmt(v, 6))),
    clampedRate: clampedRate.map((v) => (v === null ? null : fmt(v, 6))),
    peaks,
    zones: zoneSummaries,
    totalArea,
    unclassifiedArea: finalUnclassified,
    unclassifiedPct: finalUnclassifiedPct,
    unclassifiedTolerancePct,
    originDistance: originDistance === null ? null : fmt(originDistance),
    frontDistance: frontDistance === null ? null : fmt(frontDistance),
    scanStartIndex,
    scanEndIndex,
    canRelease,
    release,
    thresholdChecks,
    computedAt,
  };
}

/** 生成一份内置演示/自检用数据（三峰：原点杂质、主峰、前沿游离） */
export function makeDemoData(): TLCDataSet {
  const points = [];
  const n = 121; // 0..120 mm
  const gauss = (x: number, mu: number, sigma: number, amp: number): number =>
    amp * Math.exp(-((x - mu) ** 2) / (2 * sigma ** 2));
  for (let i = 0; i < n; i++) {
    const x = i; // 1 mm 步长
    const cps =
      120 +
      0.4 * x +
      gauss(x, 8, 2.6, 900) +   // 原点附近水解还原锝 ~ Rf 0.067
      gauss(x, 60, 3.2, 8200) + // 标记产物主峰 ~ Rf 0.5
      gauss(x, 108, 2.4, 760) + // 游离高锝酸盐（前沿）~ Rf 0.9
      (Math.sin(i * 1.7) * 18 + Math.cos(i * 0.6) * 10); // 噪声
    const liveTime = 2;
    points.push({ distance: x, counts: Math.max(0, Math.round(cps * liveTime)), liveTime });
  }
  return {
    sampleId: 'DEMO-TLC-001',
    nuclide: 'Tc-99m',
    measuredAt: '2026-09-14T08:30:00.000Z',
    liveTime: 2,
    points,
  };
}
