import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnalysisResult,
  Anchor,
  Boundary,
  Calibration,
  DragKind,
  RfZone,
  TLCDataSet,
} from '../types';

interface ChartProps {
  data: TLCDataSet;
  result: AnalysisResult;
  calibration: Calibration;
  anchors: Anchor[];
  boundaries: Boundary[];
  zones: RfZone[];
  selected: { kind: DragKind; id: string } | null;
  onSelect: (sel: { kind: DragKind; id: string } | null) => void;
  onMoveMarker: (kind: Exclude<DragKind, 'anchor' | 'boundary'>, index: number) => void;
  onMoveAnchor: (id: string, index: number, y: number) => void;
  onMoveBoundary: (id: string, index: number) => void;
  onAddAnchor: (index: number) => void;
}

const ZONE_COLORS = ['#2563eb', '#059669', '#7c3aed', '#d97706', '#e11d48', '#0891b2', '#65a30d'];

export default function Chart(props: ChartProps): JSX.Element {
  const { data, result, calibration, anchors, boundaries, zones, selected } = props;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(980);
  const [hover, setHover] = useState<number | null>(null);
  const dragRef = useRef<{ kind: DragKind; id: string } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      setWidth(Math.max(720, w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 500;
  const margin = { l: 66, r: 28, t: 46, b: 78 };
  const W = Math.round(width);
  const x0 = margin.l;
  const x1 = W - margin.r;
  const y0 = margin.t;
  const y1 = H - margin.b;
  const pw = x1 - x0;
  const ph = y1 - y0;

  const n = data.points.length;
  const dist = useMemo(() => data.points.map((p) => p.distance), [data]);
  const dMin = dist[0];
  const dMax = dist[n - 1];
  const dSpan = dMax - dMin || 1;

  const yLo = useMemo(() => {
    let lo = 0;
    for (const v of result.netRate) if (v !== null && v < lo) lo = v;
    return lo * 1.05;
  }, [result.netRate]);
  const yHi = useMemo(() => {
    let hi = 1;
    for (const v of result.rawRate) if (Number.isFinite(v) && v > hi) hi = v;
    for (const a of anchors) if (Number.isFinite(a.y) && a.y > hi) hi = a.y;
    return hi * 1.08;
  }, [result.rawRate, anchors]);

  const X = (d: number): number => x0 + ((d - dMin) / dSpan) * pw;
  const Y = (v: number): number => y1 - ((v - yLo) / (yHi - yLo)) * ph;
  const Xi = (i: number): number => X(dist[i]);
  const distFromPx = (px: number): number => dMin + ((px - x0) / pw) * dSpan;
  const nearestIndex = (px: number): number => {
    const d = distFromPx(Math.min(x1, Math.max(x0, px)));
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dist[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(dist[lo - 1] - d) <= Math.abs(dist[lo] - d)) return lo - 1;
    return Math.min(n - 1, Math.max(0, lo));
  };
  const cpsFromPy = (py: number): number => {
    const v = yLo + ((y1 - py) / ph) * (yHi - yLo);
    return Math.max(0, Math.min(yHi * 1.5, v));
  };

  const pxFromEvent = (e: React.PointerEvent): { px: number; py: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { px: ((e.clientX - rect.left) / rect.width) * W, py: ((e.clientY - rect.top) / rect.height) * H };
  };

  const onHandleDown = (kind: DragKind, id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { kind, id };
    props.onSelect({ kind, id });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { px, py } = pxFromEvent(e);
    if (px >= x0 && px <= x1 && py >= y0 && py <= y1) setHover(nearestIndex(px));
    else setHover(null);
    const drag = dragRef.current;
    if (!drag) return;
    const idx = nearestIndex(px);
    if (drag.kind === 'anchor') props.onMoveAnchor(drag.id, idx, cpsFromPy(py));
    else if (drag.kind === 'boundary') props.onMoveBoundary(drag.id, idx);
    else props.onMoveMarker(drag.kind, idx);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };
  const onPlotDoubleClick = (e: React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (px < x0 || px > x1) return;
    props.onAddAnchor(nearestIndex(px));
  };

  const linePath = (vals: (number | null)[]): string => {
    let d = '';
    let pen = false;
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${Xi(i).toFixed(2)},${Y(v).toFixed(2)} `;
      pen = true;
    }
    return d;
  };

  const clampedFillPath = useMemo(() => {
    let d = '';
    let segStart: number | null = null;
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const v = result.clampedRate[i];
      if (v === null || !Number.isFinite(v)) {
        if (segStart !== null) {
          pts.push(d + `L${Xi(i - 1).toFixed(2)},${Y(0)} L${Xi(segStart).toFixed(2)},${Y(0)} Z`);
          d = '';
          segStart = null;
        }
        continue;
      }
      if (segStart === null) segStart = i;
      d += `${d ? 'L' : 'M'}${Xi(i).toFixed(2)},${Y(v).toFixed(2)} `;
    }
    if (segStart !== null) pts.push(d + `L${Xi(n - 1).toFixed(2)},${Y(0)} L${Xi(segStart).toFixed(2)},${Y(0)} Z`);
    return pts.join(' ');
  }, [result.clampedRate, n]); // eslint-disable-line react-hooks/exhaustive-deps

  const originD = result.originDistance;
  const frontD = result.frontDistance;
  const calReady = originD !== null && frontD !== null && frontD > originD;
  const Xrf = (rf: number): number => X(originD! + rf * (frontD! - originD!));
  const scanLoI = calibration.scanStartIndex ?? 0;
  const scanHiI = calibration.scanEndIndex ?? n - 1;

  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    const steps = 5;
    for (let k = 0; k <= steps; k++) ticks.push(yLo + ((yHi - yLo) * k) / steps);
    return ticks;
  }, [yLo, yHi]);
  const xTicks = useMemo(() => {
    const raw = Math.abs(dSpan) / 10;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = (raw / mag >= 5 ? 5 : raw / mag >= 2 ? 2 : 1) * mag;
    const ticks: number[] = [];
    for (let d = Math.ceil(dMin / step) * step; d <= dMax + step * 1e-6; d += step) ticks.push(d);
    return ticks;
  }, [dMin, dMax, dSpan]);

  const markerSpec = (): { kind: Exclude<DragKind, 'anchor' | 'boundary'>; idx: number | null; color: string; label: string; shape: 'circle' | 'diamond' }[] => [
    { kind: 'scanStart', idx: calibration.scanStartIndex, color: '#64748b', label: '扫描起点', shape: 'diamond' },
    { kind: 'scanEnd', idx: calibration.scanEndIndex, color: '#64748b', label: '扫描终点', shape: 'diamond' },
    { kind: 'origin', idx: calibration.originIndex, color: '#16a34a', label: '点样原点 Rf0', shape: 'circle' },
    { kind: 'front', idx: calibration.frontIndex, color: '#2563eb', label: '溶剂前沿 Rf1', shape: 'circle' },
  ];

  const hoverRow = hover !== null ? data.points[hover] : null;
  const hoverRf = hover !== null && calReady ? (dist[hover] - originD!) / (frontD! - originD!) : null;

  return (
    <div ref={wrapRef} className="chart-wrap">
      <svg
        ref={svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onPlotDoubleClick}
        role="img"
        aria-label="放射性薄层色谱曲线，可拖动标定、基线锚点与峰谷边界"
      >
        {/* 具名 Rf 区间底色 */}
        {calReady &&
          zones.map((z, zi) => {
            const xa = Xrf(Math.max(0, z.rfMin));
            const xb = Xrf(Math.min(1, z.rfMax));
            const color = ZONE_COLORS[zi % ZONE_COLORS.length];
            return (
              <g key={`zone-${z.id}`}>
                <rect x={xa} y={y0} width={Math.max(0, xb - xa)} height={ph} fill={color} opacity={0.08} />
                <line x1={xa} x2={xa} y1={y0} y2={y1} stroke={color} strokeWidth={1} strokeDasharray="2 3" opacity={0.7} />
                <line x1={xb} x2={xb} y1={y0} y2={y1} stroke={color} strokeWidth={1} strokeDasharray="2 3" opacity={0.7} />
                <text x={(xa + xb) / 2} y={y0 + 14} textAnchor="middle" fontSize={11} fill={color} fontWeight={600}>
                  {z.name}
                </text>
              </g>
            );
          })}

        {/* 有效扫描区外压暗 */}
        <rect x={x0} y={y0} width={Math.max(0, Xi(scanLoI) - x0)} height={ph} fill="#0f172a" opacity={0.07} />
        <rect x={Xi(scanHiI)} y={y0} width={Math.max(0, x1 - Xi(scanHiI))} height={ph} fill="#0f172a" opacity={0.07} />
        <line x1={Xi(scanLoI)} x2={Xi(scanLoI)} y1={y0} y2={y1} stroke="#94a3b8" strokeDasharray="4 4" />
        <line x1={Xi(scanHiI)} x2={Xi(scanHiI)} y1={y0} y2={y1} stroke="#94a3b8" strokeDasharray="4 4" />

        {/* 网格与坐标轴 */}
        {yTicks.map((t, k) => (
          <g key={`yt-${k}`}>
            <line x1={x0} x2={x1} y1={Y(t)} y2={Y(t)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={x0 - 8} y={Y(t) + 4} textAnchor="end" fontSize={11} fill="#64748b">
              {t >= 100 ? Math.round(t) : t.toFixed(1)}
            </text>
          </g>
        ))}
        <line x1={x0} x2={x1} y1={Y(0)} y2={Y(0)} stroke="#94a3b8" strokeWidth={1.2} />
        <line x1={x0} x2={x0} y1={y0} y2={y1} stroke="#475569" />
        <line x1={x0} x2={x1} y1={y1} y2={y1} stroke="#475569" />
        {xTicks.map((d, k) => (
          <g key={`xt-${k}`}>
            <line x1={X(d)} x2={X(d)} y1={y1} y2={y1 + 5} stroke="#475569" />
            <text x={X(d)} y={y1 + 18} textAnchor="middle" fontSize={11} fill="#475569">
              {d.toPrecision(4).replace(/\.?0+$/, '')}
            </text>
          </g>
        ))}
        <text x={x0 + pw / 2} y={H - 14} textAnchor="middle" fontSize={12} fill="#334155">
          迁移距离（输入文件单位） · 双击绘图区可在最近采样点添加基线锚点
        </text>
        <text transform={`translate(16,${y0 + ph / 2}) rotate(-90)`} textAnchor="middle" fontSize={12} fill="#334155">
          计数率 (cps)
        </text>

        {/* Rf 副轴（原点—前沿） */}
        {calReady && (
          <g>
            <line x1={Xrf(0)} x2={Xrf(1)} y1={y1 + 34} y2={y1 + 34} stroke="#16a34a" strokeWidth={1.4} />
            {[0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((rf) => (
              <g key={`rf-${rf}`}>
                <line x1={Xrf(rf)} x2={Xrf(rf)} y1={y1 + 30} y2={y1 + 38} stroke="#16a34a" />
                <text x={Xrf(rf)} y={y1 + 52} textAnchor="middle" fontSize={10} fill="#15803d">
                  {rf.toFixed(1)}
                </text>
              </g>
            ))}
            <text x={(Xrf(0) + Xrf(1)) / 2} y={y1 + 68} textAnchor="middle" fontSize={11} fill="#15803d">
              Rf（点样原点 0 → 溶剂前沿 1）
            </text>
          </g>
        )}

        {/* 原始曲线 */}
        <path d={linePath(result.rawRate)} fill="none" stroke="#94a3b8" strokeWidth={1.4} />
        {/* 未截断扣底曲线 */}
        <path d={linePath(result.netRate)} fill="none" stroke="#a855f7" strokeWidth={1.1} strokeDasharray="5 3" opacity={0.85} />
        {/* 截断扣底曲线及其填充 */}
        <path d={clampedFillPath} fill="rgba(13,148,136,0.16)" stroke="none" />
        <path d={linePath(result.clampedRate)} fill="none" stroke="#0f766e" strokeWidth={1.8} />

        {/* 基线段（仅锚点覆盖范围） */}
        <path d={linePath(result.baseline)} fill="none" stroke="#f97316" strokeWidth={2} />

        {/* 峰谷边界 */}
        {boundaries.map((b) =>
          b.index < 0 || b.index >= n ? null : (
            <g
              key={b.id}
              onPointerDown={onHandleDown('boundary', b.id)}
              style={{ cursor: 'ew-resize' }}
            >
              <line
                x1={Xi(b.index)}
                x2={Xi(b.index)}
                y1={y0}
                y2={y1}
                stroke={selected?.kind === 'boundary' && selected.id === b.id ? '#b91c1c' : '#dc2626'}
                strokeWidth={selected?.kind === 'boundary' && selected.id === b.id ? 2.4 : 1.6}
                strokeDasharray="7 4"
                pointerEvents="stroke"
              />
              <rect x={Xi(b.index) - 7} y={y0 - 2} width={14} height={12} rx={2} fill="#dc2626" />
              <line x1={Xi(b.index) - 4} x2={Xi(b.index) + 4} y1={y0 + 4} y2={y0 + 4} stroke="#fff" strokeWidth={2} />
              <rect x={Xi(b.index) - 9} y={y0 - 4} width={18} height={ph + 8} fill="transparent" />
            </g>
          ),
        )}

        {/* 峰顶标记 */}
        {result.peaks.map((p) => {
          const v = result.clampedRate[p.apexIndex];
          if (v === null) return null;
          return (
            <g key={`apex-${p.no}`} pointerEvents="none">
              <path
                d={`M${Xi(p.apexIndex)},${Y(v) - 12} l5,9 -10,0 z`}
                fill="#0f172a"
                transform={`rotate(180 ${Xi(p.apexIndex)} ${Y(v) - 6})`}
              />
              <text x={Xi(p.apexIndex)} y={Y(v) - 16} textAnchor="middle" fontSize={11} fontWeight={700} fill="#0f172a">
                #{p.no} Rf {p.rf.toFixed(3)}
              </text>
            </g>
          );
        })}

        {/* 基线锚点（横纵双向拖动） */}
        {anchors.map((a) => {
          if (a.index < 0 || a.index >= n) return null;
          const isSel = selected?.kind === 'anchor' && selected.id === a.id;
          const cx = Xi(a.index);
          const cy = Y(a.y);
          return (
            <g key={a.id} onPointerDown={onHandleDown('anchor', a.id)} style={{ cursor: 'grab' }}>
              <rect x={cx - 9} y={cy - 9} width={18} height={18} fill="transparent" />
              <rect
                x={cx - 6}
                y={cy - 6}
                width={12}
                height={12}
                rx={2}
                fill="#fff7ed"
                stroke="#f97316"
                strokeWidth={isSel ? 3 : 2}
              />
              <line x1={cx - 3} x2={cx + 3} y1={cy} y2={cy} stroke="#f97316" strokeWidth={1.4} />
              <line x1={cx} x2={cx} y1={cy - 3} y2={cy + 3} stroke="#f97316" strokeWidth={1.4} />
            </g>
          );
        })}

        {/* 标定 marker */}
        {markerSpec().map((m) =>
          m.idx === null || m.idx < 0 || m.idx >= n ? null : (
            <g
              key={m.kind}
              onPointerDown={onHandleDown(m.kind, m.kind)}
              style={{ cursor: 'ew-resize' }}
            >
              {m.shape === 'circle' ? (
                <circle cx={Xi(m.idx)} cy={y1 + 6} r={7} fill="#fff" stroke={m.color} strokeWidth={2.4} />
              ) : (
                <rect
                  x={Xi(m.idx) - 6}
                  y={y1}
                  width={12}
                  height={12}
                  rx={2}
                  fill="#fff"
                  stroke={m.color}
                  strokeWidth={2.2}
                  transform={`rotate(45 ${Xi(m.idx)} ${y1 + 6})`}
                />
              )}
              <rect x={Xi(m.idx) - 10} y={y1 - 6} width={20} height={24} fill="transparent" />
              <text
                x={Xi(m.idx)}
                y={
                  m.kind === 'origin'
                    ? y0 - 14
                    : m.kind === 'front'
                      ? y0 - 14
                      : y0 - 14
                }
                textAnchor="middle"
                fontSize={11}
                fontWeight={700}
                fill={m.color}
              >
                {m.label}
              </text>
            </g>
          ),
        )}

        {/* 十字光标读数 */}
        {hover !== null && hoverRow && (
          <g pointerEvents="none">
            <line x1={Xi(hover)} x2={Xi(hover)} y1={y0} y2={y1} stroke="#0ea5e9" strokeWidth={1} strokeDasharray="3 3" opacity={0.8} />
            <g transform={`translate(${Math.min(Xi(hover) + 8, x1 - 208)},${y0 + 6})`}>
              <rect width={212} height={92} rx={5} fill="#0f172a" opacity={0.9} />
              <text x={9} y={19} fontSize={11} fill="#e2e8f0" fontFamily="monospace">
                #{hover}  d={String(hoverRow.distance)}
                {hoverRf !== null && Number.isFinite(hoverRf) ? `  Rf=${hoverRf.toFixed(3)}` : ''}
              </text>
              <text x={9} y={37} fontSize={11} fill="#cbd5e1" fontFamily="monospace">
                原始 {fmtTick(result.rawRate[hover])} cps
              </text>
              <text x={9} y={55} fontSize={11} fill="#fdba74" fontFamily="monospace">
                基线 {result.baseline[hover] === null ? '未覆盖' : `${fmtTick(result.baseline[hover]!)} cps`}
              </text>
              <text x={9} y={73} fontSize={11} fill="#99f6e4" fontFamily="monospace">
                扣底 {result.netRate[hover] === null ? '—' : `${fmtTick(result.netRate[hover]!)} → 截断 ${result.clampedRate[hover] === null ? '—' : fmtTick(result.clampedRate[hover]!)}`}
              </text>
            </g>
          </g>
        )}

        {/* 图例 */}
        <g fontSize={11} fill="#475569">
          <line x1={x1 - 330} x2={x1 - 308} y1={y0 + 4} y2={y0 + 4} stroke="#94a3b8" strokeWidth={1.6} />
          <text x={x1 - 304} y={y0 + 8}>原始曲线</text>
          <line x1={x1 - 246} x2={x1 - 224} y1={y0 + 4} y2={y0 + 4} stroke="#a855f7" strokeWidth={1.6} strokeDasharray="5 3" />
          <text x={x1 - 220} y={y0 + 8}>未截断扣底</text>
          <line x1={x1 - 148} x2={x1 - 126} y1={y0 + 4} y2={y0 + 4} stroke="#0f766e" strokeWidth={2} />
          <text x={x1 - 122} y={y0 + 8}>截断扣底(积分)</text>
          <line x1={x1 - 38} x2={x1 - 16} y1={y0 + 4} y2={y0 + 4} stroke="#f97316" strokeWidth={2.4} />
          <text x={x1 - 12} y={y0 + 8}>基线</text>
        </g>
      </svg>
    </div>
  );
}

function fmtTick(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export type { ChartProps };
export type { Anchor, Boundary, Calibration, RfZone, TLCDataSet, AnalysisResult, DragKind };
