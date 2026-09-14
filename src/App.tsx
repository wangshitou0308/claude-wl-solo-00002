import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Chart from './components/Chart';
import SetupPanel from './components/SetupPanel';
import PeaksPanel from './components/PeaksPanel';
import ZonesPanel from './components/ZonesPanel';
import VerdictPanel from './components/VerdictPanel';
import { analyze, defaultAnchors, makeDemoData, suggestValleys, uid } from './analysis';
import type {
  Anchor,
  Boundary,
  Calibration,
  DragKind,
  ExportBundle,
  RfZone,
  TLCDataSet,
} from './types';

const LS_KEY = 'radio-tlc-cosign-state-v1';

interface PersistState {
  data: TLCDataSet | null;
  calibration: Calibration;
  anchors: Anchor[];
  boundaries: Boundary[];
  zones: RfZone[];
  tolerancePct: number;
}

const DEFAULT_ZONES: RfZone[] = [
  { id: 'zone-demo-1', name: '水解还原锝（原点杂质）', rfMin: 0, rfMax: 0.15, minPct: 0, maxPct: 10 },
  { id: 'zone-demo-2', name: '标记产物', rfMin: 0.35, rfMax: 0.65, minPct: 80, maxPct: 100 },
  { id: 'zone-demo-3', name: '游离高锝酸盐（前沿）', rfMin: 0.85, rfMax: 1, minPct: 0, maxPct: 10 },
];

const emptyCalibration: Calibration = {
  originIndex: null,
  frontIndex: null,
  scanStartIndex: null,
  scanEndIndex: null,
};

function loadPersisted(): PersistState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as PersistState;
    if (!obj || !obj.data || !Array.isArray(obj.data.points)) return null;
    return obj;
  } catch {
    return null;
  }
}

/** 导入文件结构校验，返回错误信息或 null */
function validateImport(raw: unknown): { data: TLCDataSet; error: null } | { data: null; error: string } {
  if (typeof raw !== 'object' || raw === null) return { data: null, error: 'JSON 顶层须为对象。' };
  const obj = raw as Record<string, unknown>;
  let points: unknown = obj.points;
  // 兼容 { scan: [...] } 或直接为数组
  if (!points && typeof obj.scan === 'object') points = (obj.scan as Record<string, unknown>).points;
  if (!Array.isArray(points)) return { data: null, error: '缺少 points 数组（每项须含 distance、counts，可选 liveTime）。' };
  if (points.length < 2) return { data: null, error: 'points 少于 2 个采样点。' };
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Record<string, unknown>;
    if (typeof p !== 'object' || p === null) return { data: null, error: `第 ${i} 点不是对象。` };
    if (typeof p.distance !== 'number') return { data: null, error: `第 ${i} 点缺少数值型 distance。` };
    if (typeof p.counts !== 'number') return { data: null, error: `第 ${i} 点缺少数值型 counts。` };
    if (p.liveTime !== undefined && typeof p.liveTime !== 'number')
      return { data: null, error: `第 ${i} 点 liveTime 须为数值（秒）。` };
  }
  const data: TLCDataSet = {
    sampleId: typeof obj.sampleId === 'string' ? obj.sampleId : undefined,
    nuclide: typeof obj.nuclide === 'string' ? obj.nuclide : undefined,
    measuredAt: typeof obj.measuredAt === 'string' ? obj.measuredAt : undefined,
    liveTime: typeof obj.liveTime === 'number' ? obj.liveTime : undefined,
    points: points as TLCDataSet['points'],
  };
  return { data, error: null };
}

export default function App(): JSX.Element {
  const persisted = useRef<PersistState | null>(loadPersisted());
  const [data, setData] = useState<TLCDataSet | null>(persisted.current?.data ?? null);
  const [calibration, setCalibration] = useState<Calibration>(persisted.current?.calibration ?? emptyCalibration);
  const [anchors, setAnchors] = useState<Anchor[]>(persisted.current?.anchors ?? []);
  const [boundaries, setBoundaries] = useState<Boundary[]>(persisted.current?.boundaries ?? []);
  const [zones, setZones] = useState<RfZone[]>(persisted.current?.zones ?? DEFAULT_ZONES);
  const [tolerancePct, setTolerancePct] = useState<number>(persisted.current?.tolerancePct ?? 1);
  const [selected, setSelected] = useState<{ kind: DragKind; id: string } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 新数据初始化：标定 + 两个端锚（贴合端部最小计数率）+ 自动谷点
  const initForData = useCallback((d: TLCDataSet): { anchors: Anchor[]; calibration: Calibration; boundaries: Boundary[] } => {
    const n = d.points.length;
    const rate = d.points.map((p) => {
      const lt = p.liveTime ?? d.liveTime ?? 1;
      return lt > 0 ? p.counts / lt : p.counts;
    });
    const anchors = defaultAnchors(d, rate);
    const valleys = suggestValleys(d, rate);
    const boundaries: Boundary[] = [0, ...valleys, n - 1]
      .filter((v, k, arr) => arr.indexOf(v) === k)
      .map((index) => ({ id: uid('bnd'), index }));
    const cal: Calibration = {
      scanStartIndex: 0,
      scanEndIndex: n - 1,
      originIndex: 0,
      frontIndex: n - 1,
    };
    return { anchors, calibration: cal, boundaries };
  }, []);

  const loadData = useCallback(
    (d: TLCDataSet) => {
      const init = initForData(d);
      setData(d);
      setAnchors(init.anchors);
      setCalibration(init.calibration);
      setBoundaries(init.boundaries);
      setSelected(null);
      setImportError(null);
    },
    [initForData],
  );

  // 首次若有持久数据则直接使用；无数据时加载内置演示数据便于离线试用
  useEffect(() => {
    if (!data) loadData(makeDemoData());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 持久化
  useEffect(() => {
    if (!data) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ data, calibration, anchors, boundaries, zones, tolerancePct }));
    } catch {
      /* localStorage 不可用时静默（file:// 部分环境） */
    }
  }, [data, calibration, anchors, boundaries, zones, tolerancePct]);

  const result = useMemo(() => {
    if (!data) return null;
    return analyze({ data, calibration, anchors, boundaries, zones, unclassifiedTolerancePct: tolerancePct });
  }, [data, calibration, anchors, boundaries, zones, tolerancePct]);

  // ---- 标定拖动 ----
  const clampIndex = (i: number, n: number): number => Math.min(n - 1, Math.max(0, i));
  const onMoveMarker = useCallback(
    (kind: Exclude<DragKind, 'anchor' | 'boundary'>, index: number) => {
      if (!data) return;
      const n = data.points.length;
      setCalibration((c) => {
        const next: Calibration = { ...c, [kind === 'scanStart' ? 'scanStartIndex' : kind === 'scanEnd' ? 'scanEndIndex' : kind === 'origin' ? 'originIndex' : 'frontIndex']: clampIndex(index, n) };
        // 软约束：保持 scanStart ≤ origin < front ≤ scanEnd；越界即放行（由异常提示），仅保证索引合法
        return next;
      });
    },
    [data],
  );

  // ---- 锚点拖动 ----
  const onMoveAnchor = useCallback((id: string, index: number, y: number) => {
    setAnchors((list) => {
      // 不允许与其他锚点同索引（横向避让）
      const occupied = new Set(list.filter((a) => a.id !== id).map((a) => a.index));
      if (occupied.has(index)) return list;
      return list.map((a) => (a.id === id ? { ...a, index, y: Math.max(0, y) } : a));
    });
  }, []);
  const onAnchorY = useCallback((id: string, y: number) => {
    if (!Number.isFinite(y)) return;
    setAnchors((list) => list.map((a) => (a.id === id ? { ...a, y: Math.max(0, y) } : a)));
  }, []);
  const onAddAnchorAt = useCallback(
    (index?: number) => {
      if (!data || !result) return;
      const n = data.points.length;
      const sorted = [...anchors].sort((a, b) => a.index - b.index);
      const covered = new Set(sorted.map((a) => a.index));
      let target: number;
      if (index !== undefined) {
        if (covered.has(index)) return;
        target = index;
      } else {
        // 最大空隙中点
        if (sorted.length === 0) {
          target = Math.floor(n / 2);
        } else {
          let bestGap = -1;
          target = sorted[0].index;
          const bounds = [0, ...sorted.map((a) => a.index), n - 1];
          for (let k = 0; k + 1 < bounds.length; k++) {
            const gap = bounds[k + 1] - bounds[k];
            if (gap > bestGap) {
              bestGap = gap;
              target = Math.round((bounds[k] + bounds[k + 1]) / 2);
            }
          }
        }
        if (covered.has(target)) return;
      }
      const raw = result.rawRate[target];
      const base = result.baseline[target];
      setAnchors((list) => [...list, { id: uid('anc'), index: target, y: base ?? raw ?? 0 }]);
    },
    [anchors, data, result],
  );
  const onRemoveAnchor = useCallback((id: string) => {
    setAnchors((list) => list.filter((a) => a.id !== id));
    setSelected(null);
  }, []);

  // ---- 边界拖动 ----
  const onMoveBoundary = useCallback(
    (id: string, index: number) => {
      if (!data) return;
      const n = data.points.length;
      const lo = calibration.scanStartIndex ?? 0;
      const hi = calibration.scanEndIndex ?? n - 1;
      const ni = Math.min(hi, Math.max(lo, index));
      setBoundaries((list) => {
        const occupied = new Set(list.filter((b) => b.id !== id).map((b) => b.index));
        if (occupied.has(ni)) return list; // 不允许重合
        return list.map((b) => (b.id === id ? { ...b, index: ni } : b));
      });
    },
    [calibration, data],
  );
  const onAddBoundary = useCallback(() => {
    if (!data) return;
    const n = data.points.length;
    const lo = calibration.scanStartIndex ?? 0;
    const hi = calibration.scanEndIndex ?? n - 1;
    const occupied = new Set(boundaries.map((b) => b.index));
    // 在最大空隙中取扣底曲线最低点（谷点）
    const sorted = [...boundaries.map((b) => b.index), lo, hi].sort((a, b) => a - b);
    let bestGap = -1;
    let segL = lo;
    let segR = hi;
    for (let k = 0; k + 1 < sorted.length; k++) {
      if (occupied.has(sorted[k]) && occupied.has(sorted[k + 1]) && sorted[k + 1] - sorted[k] < 3) continue;
      const gap = sorted[k + 1] - sorted[k];
      if (gap > bestGap) {
        bestGap = gap;
        segL = sorted[k];
        segR = sorted[k + 1];
      }
    }
    if (segR - segL < 2) return;
    let pick = segL + 1;
    let pickVal = Infinity;
    for (let i = segL + 1; i < segR; i++) {
      if (occupied.has(i)) continue;
      const v = result?.clampedRate[i];
      if (v !== null && v !== undefined && v < pickVal) {
        pickVal = v;
        pick = i;
      }
    }
    if (occupied.has(pick)) return;
    setBoundaries((list) => [...list, { id: uid('bnd'), index: pick }]);
  }, [anchors, boundaries, calibration, data, result]);
  const onRemoveBoundary = useCallback((id: string) => {
    setBoundaries((list) => list.filter((b) => b.id !== id));
    setSelected(null);
  }, []);

  // ---- Delete 键删除 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!selected) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selected.kind === 'anchor') onRemoveAnchor(selected.id);
        if (selected.kind === 'boundary') onRemoveBoundary(selected.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, onRemoveAnchor, onRemoveBoundary]);

  // ---- 文件导入 ----
  const onFile = async (file: File): Promise<void> => {
    try {
      const text = await file.text();
      const raw = JSON.parse(text);
      const v = validateImport(raw);
      if (v.error || v.data === null) {
        setImportError(v.error ?? '导入数据无效。');
        return;
      }
      loadData(v.data);
    } catch (err) {
      setImportError(`JSON 解析失败：${(err as Error).message}`);
    }
  };

  // ---- 导出 ----
  const onExport = (): void => {
    if (!data || !result) return;
    const bundle: ExportBundle = {
      format: 'radio-tlc-cosign',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      software: 'radio-TLC 归算台 v1.0（纯前端离线）',
      inputSnapshot: data,
      calibration,
      anchors: [...anchors].sort((a, b) => a.index - b.index),
      boundaries: [...boundaries].sort((a, b) => a.index - b.index),
      rfZones: zones,
      unclassifiedTolerancePct: tolerancePct,
      result,
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tlc-cosign-${data.sampleId || 'sample'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadSample = (): void => {
    const sample = makeDemoData();
    const blob = new Blob([JSON.stringify(sample, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tlc-sample-input.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const anomalyCount = result?.anomalies.length ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">☢</span>
          <div>
            <h1>放射性薄层色谱归算台</h1>
            <div className="sub">radio-TLC 放行前面积归算 · 纯前端离线 · 数据不出本机</div>
          </div>
        </div>
        <div className="actions">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
              e.target.value = '';
            }}
          />
          <button className="btn" onClick={() => fileRef.current?.click()}>导入 JSON</button>
          <button className="btn ghost" onClick={downloadSample}>下载输入样例</button>
          <button className="btn ghost" onClick={() => loadData(makeDemoData())}>载入演示数据</button>
          <button className="btn primary" disabled={!data || !result} onClick={onExport}>
            导出归算 JSON
          </button>
        </div>
      </header>

      {data && (
        <div className="meta-bar">
          <span><b>样品：</b>{data.sampleId || '（未命名）'}</span>
          <span><b>核素：</b>{data.nuclide || '—'}</span>
          <span><b>检测时间：</b>{data.measuredAt || '—'}</span>
          <span><b>活时间：</b>{data.liveTime ?? '点级'} s</span>
          <span><b>采样点：</b>{data.points.length}</span>
          <span className={anomalyCount > 0 ? 'bad' : 'good'}>
            <b>异常：</b>{anomalyCount}
          </span>
        </div>
      )}
      {importError && (
        <div className="import-err">
          导入失败：{importError}
          <button className="btn-x" onClick={() => setImportError(null)}>✕</button>
        </div>
      )}

      {data && result ? (
        <main className="layout">
          <section className="col chart-col">
            <Chart
              data={data}
              result={result}
              calibration={calibration}
              anchors={anchors}
              boundaries={boundaries}
              zones={zones}
              selected={selected}
              onSelect={setSelected}
              onMoveMarker={onMoveMarker}
              onMoveAnchor={onMoveAnchor}
              onMoveBoundary={onMoveBoundary}
              onAddAnchor={(i) => onAddAnchorAt(i)}
            />
            <ZonesPanel zones={zones} tolerancePct={tolerancePct} onChange={setZones} onTolerance={(v) => setTolerancePct(Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 1)} />
            <VerdictPanel result={result} />
          </section>
          <aside className="col side-col">
            <SetupPanel
              data={data}
              calibration={calibration}
              anchors={anchors}
              boundaries={boundaries}
              selected={selected}
              originDistance={result.originDistance}
              frontDistance={result.frontDistance}
              onSelect={setSelected}
              onAnchorY={onAnchorY}
              onRemoveAnchor={onRemoveAnchor}
              onAddAnchor={() => onAddAnchorAt()}
              onRemoveBoundary={onRemoveBoundary}
              onAddBoundary={onAddBoundary}
            />
            <PeaksPanel data={data} result={result} />
          </aside>
        </main>
      ) : (
        <div className="boot-note">
          <p>请导入本地 JSON 扫描文件，或点击右上角“载入演示数据”。</p>
          <pre className="schema">{`{
  "sampleId": "板编号（可选）",
  "nuclide": "Tc-99m（可选）",
  "measuredAt": "2026-09-14T08:30:00Z（可选）",
  "liveTime": 2,
  "points": [
    { "distance": 0, "counts": 245, "liveTime": 2 },
    { "distance": 1, "counts": 251 }
  ]
}`}</pre>
          <p className="hint">distance 必须严格单调递增；liveTime 可点级给出，缺省取顶层值，计数率按 counts / liveTime (cps) 归算。</p>
        </div>
      )}
      <footer className="foot">
        本工具仅用于放行前归算辅助，所有计算与数据均在本机浏览器内完成；最终放行须由授权技师/药师核对。
      </footer>
    </div>
  );
}
