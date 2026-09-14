import { useState } from 'react';
import type { AnalysisResult, TLCDataSet } from '../types';

interface PeaksPanelProps {
  data: TLCDataSet;
  result: AnalysisResult;
}

const f = (v: number): string => {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v) >= 1000) return v.toFixed(1);
  if (Math.abs(v) >= 1) return v.toFixed(3);
  return v.toFixed(4);
};

export default function PeaksPanel({ data, result }: PeaksPanelProps): JSX.Element {
  const [open, setOpen] = useState<number | null>(1);
  const dist = data.points.map((p) => p.distance);
  const { peaks } = result;

  return (
    <div className="panel">
      <h3>② 逐峰积分与分类（{peaks.length} 峰）</h3>
      <p className="hint">
        共享谷点仅作两侧梯形的共同端点；峰 Rf 取截断扣底后峰顶；峰跨越具名 Rf 区间边界时在边界距离处线性插值拆分面积。
      </p>
      {peaks.length === 0 && <div className="empty-note">至少需要 2 个峰谷边界才能界定峰。</div>}
      {peaks.map((p) => {
        const expanded = open === p.no;
        return (
          <div key={p.no} className={`peak-card ${p.baselineUncovered ? 'warn' : ''}`}>
            <div className="peak-head" onClick={() => setOpen(expanded ? null : p.no)} role="button" tabIndex={0}>
              <span className="peak-no">#{p.no}</span>
              <span>
                谷边界 #{p.leftBoundaryIndex} ↔ #{p.rightBoundaryIndex}
                <span className="muted">
                  {' '}
                  (d {f(dist[p.leftBoundaryIndex])}–{f(dist[p.rightBoundaryIndex])})
                </span>
              </span>
              <span className={`chip ${p.rf < 0 || p.rf > 1 ? 'bad' : 'ok'}`}>Rf {f(p.rf)}</span>
              <span className="chip">面积 {f(p.area)}</span>
              <span className="chip">占比 {f(p.pct)}%</span>
              <span className="caret">{expanded ? '▾' : '▸'}</span>
            </div>
            {expanded && (
              <div className="peak-body">
                <div className="calc-line">
                  峰顶：#{p.apexIndex}（d={f(p.apexDistance)}），Rf = ({f(p.apexDistance)} −{' '}
                  {f(result.originDistance ?? NaN)}) / ({f(result.frontDistance ?? NaN)} −{' '}
                  {f(result.originDistance ?? NaN)}) = <b>{f(p.rf)}</b>
                </div>
                <div className="calc-line">
                  面积 = Σ 相邻采样点梯形 = Σ (yᵢ + yᵢ₊₁)/2 × (xᵢ₊₁ − xᵢ) = <b>{f(p.area)}</b> cps·距离
                </div>
                <div className="calc-line">
                  占比 = {f(p.area)} / {f(result.totalArea)} × 100% = <b>{f(p.pct)}%</b>
                </div>
                {p.baselineUncovered && (
                  <div className="calc-err">⚠ 峰内存在基线未覆盖间隔，上述面积不完整（已列入异常）。</div>
                )}

                <details open>
                  <summary>逐间隔梯形算式（{p.traps.length} 段）</summary>
                  <div className="table-scroll">
                    <table className="calc">
                      <thead>
                        <tr>
                          <th>i</th>
                          <th>xᵢ → xᵢ₊₁</th>
                          <th>yᵢ (cps)</th>
                          <th>yᵢ₊₁ (cps)</th>
                          <th>(yᵢ+yᵢ₊₁)/2 × Δx</th>
                          <th>段面积</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.traps.map((t, k) => (
                          <tr key={k}>
                            <td>{t.iL}→{t.iR}</td>
                            <td>{f(t.xL)} → {f(t.xR)}</td>
                            <td>{f(t.yL)}</td>
                            <td>{f(t.yR)}</td>
                            <td>
                              ({f(t.yL)}+{f(t.yR)})/2 × ({f(t.xR)}−{f(t.xL)})
                            </td>
                            <td>{f(t.area)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>

                <details open>
                  <summary>按具名 Rf 区间拆分（边界处线性插值）</summary>
                  <div className="table-scroll">
                    <table className="calc">
                      <thead>
                        <tr>
                          <th>归属</th>
                          <th>片段 x 范围</th>
                          <th>yL → yR</th>
                          <th>插值端点</th>
                          <th>面积</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.splits.map((s, k) => (
                          <tr key={k} className={s.zoneId ? '' : 'unclassified'}>
                            <td>{s.zoneName ?? <b>未分类</b>}</td>
                            <td>{f(s.xL)} → {f(s.xR)}</td>
                            <td>{f(s.yL)} → {f(s.yR)}</td>
                            <td>
                              {[
                                s.interpolatedLeft ? '左插值' : '',
                                s.interpolatedRight ? '右插值' : '',
                              ]
                                .filter(Boolean)
                                .join('，') || '—'}
                            </td>
                            <td>{f(s.area)}</td>
                          </tr>
                        ))}
                        {p.splits.length === 0 && (
                          <tr>
                            <td colSpan={5} className="muted">
                              无（峰未被有效扫描区基线覆盖，或区间未配置）
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
