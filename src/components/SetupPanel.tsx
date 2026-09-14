import type { Anchor, Boundary, Calibration, DragKind, TLCDataSet } from '../types';

interface SetupPanelProps {
  data: TLCDataSet;
  calibration: Calibration;
  anchors: Anchor[];
  boundaries: Boundary[];
  selected: { kind: DragKind; id: string } | null;
  originDistance: number | null;
  frontDistance: number | null;
  onSelect: (sel: { kind: DragKind; id: string } | null) => void;
  onAnchorY: (id: string, y: number) => void;
  onRemoveAnchor: (id: string) => void;
  onAddAnchor: () => void;
  onRemoveBoundary: (id: string) => void;
  onAddBoundary: () => void;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(3);
}

export default function SetupPanel(props: SetupPanelProps): JSX.Element {
  const { data, calibration, anchors, boundaries, originDistance, frontDistance } = props;
  const dist = data.points.map((p) => p.distance);
  const rfOf = (i: number): string => {
    if (originDistance === null || frontDistance === null || frontDistance <= originDistance) return '—';
    const rf = (dist[i] - originDistance) / (frontDistance - originDistance);
    return rf.toFixed(3);
  };
  const markerRows: { key: Exclude<DragKind, 'anchor' | 'boundary'>; label: string; idx: number | null }[] = [
    { key: 'scanStart', label: '有效扫描区起点', idx: calibration.scanStartIndex },
    { key: 'origin', label: '点样原点 (Rf = 0)', idx: calibration.originIndex },
    { key: 'front', label: '溶剂前沿 (Rf = 1)', idx: calibration.frontIndex },
    { key: 'scanEnd', label: '有效扫描区终点', idx: calibration.scanEndIndex },
  ];
  const sortedAnchors = [...anchors].sort((a, b) => a.index - b.index);
  const sortedBoundaries = [...boundaries].sort((a, b) => a.index - b.index);

  return (
    <div className="panel">
      <h3>① 标定 · 基线 · 峰谷</h3>
      <p className="hint">图中横向拖动标记点；基线锚点还可纵向拖动改变扣底水平。Delete 键删除选中的锚点/边界。</p>

      <div className="subhead">曲线上标定点</div>
      <table className="mini">
        <tbody>
          {markerRows.map((r) => (
            <tr
              key={r.key}
              className={props.selected?.kind === r.key ? 'sel' : ''}
              onClick={() => props.onSelect({ kind: r.key, id: r.key })}
            >
              <td className="lbl">{r.label}</td>
              <td className="val">
                {r.idx === null ? '未标定' : `#${r.idx} · d=${fmt(dist[r.idx])}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="subhead">
        基线锚点（{anchors.length}）
        <button className="btn-mini" onClick={props.onAddAnchor}>
          ＋ 在最大空隙插入
        </button>
      </div>
      <table className="mini">
        <thead>
          <tr>
            <th>采样点</th>
            <th>距离</th>
            <th>基线水平 (cps)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sortedAnchors.map((a) => (
            <tr key={a.id} className={props.selected?.kind === 'anchor' && props.selected.id === a.id ? 'sel' : ''}>
              <td onClick={() => props.onSelect({ kind: 'anchor', id: a.id })}>#{a.index}</td>
              <td onClick={() => props.onSelect({ kind: 'anchor', id: a.id })}>{fmt(dist[a.index])}</td>
              <td>
                <input
                  type="number"
                  step="any"
                  value={Number(a.y.toFixed(3))}
                  onChange={(e) => props.onAnchorY(a.id, parseFloat(e.target.value))}
                />
              </td>
              <td>
                <button className="btn-x" onClick={() => props.onRemoveAnchor(a.id)} aria-label="删除锚点">
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">锚点之间按分段线性插值逐点扣底；覆盖范围外的采样点不参与积分并报“基线未覆盖”。</p>

      <div className="subhead">
        峰谷共享边界（{boundaries.length}，相邻边界夹一个峰）
        <button className="btn-mini" onClick={props.onAddBoundary}>
          ＋ 在最大空隙插入
        </button>
      </div>
      <table className="mini">
        <thead>
          <tr>
            <th>谷点</th>
            <th>距离</th>
            <th>Rf</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sortedBoundaries.map((b) => (
            <tr
              key={b.id}
              className={props.selected?.kind === 'boundary' && props.selected.id === b.id ? 'sel' : ''}
              onClick={() => props.onSelect({ kind: 'boundary', id: b.id })}
            >
              <td>#{b.index}</td>
              <td>{fmt(dist[b.index])}</td>
              <td>{rfOf(b.index)}</td>
              <td>
                <button
                  className="btn-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onRemoveBoundary(b.id);
                  }}
                  aria-label="删除边界"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
