import type { AnalysisResult, Anomaly } from '../types';

interface VerdictPanelProps {
  result: AnalysisResult;
}

const ANOM_LABEL: Record<Anomaly['code'], string> = {
  DISTANCE_DISORDERED: '距离乱序',
  DISTANCE_DUPLICATE: '距离重复',
  BAD_LIVE_TIME: '检测时间/计数非法',
  CAL_INVALID: '标定无效',
  ANCHORS_INSUFFICIENT: '基线锚点不足',
  BASELINE_UNCOVERED: '基线未覆盖',
  BOUNDARY_UNORDERED: '边界交叉',
  BOUNDARY_OUTSIDE_SCAN: '边界越界',
  BOUNDARY_DUPLICATE: '边界重合',
  PEAK_BASELINE_UNCOVERED: '峰内基线未覆盖',
  PEAK_RF_OUT_OF_RANGE: '峰 Rf 越界',
  ZONE_INVALID: '区间配置无效',
  ZONE_OVERLAP: '区间重叠',
  UNCLASSIFIED_AREA: '存在未分类面积',
  ZONE_PCT_RANGE: '阈值不通过',
};

export default function VerdictPanel({ result }: VerdictPanelProps): JSX.Element {
  const { anomalies, canRelease, release, thresholdChecks, totalArea, unclassifiedPct, unclassifiedArea } = result;

  return (
    <div className="panel">
      <h3>④ 异常定位与放行结论</h3>

      <div className={`verdict ${anomalies.length > 0 ? 'blocked' : release ? 'pass' : 'blocked'}`}>
        {anomalies.length > 0 ? (
          <>
            <div className="v-big">⛔ 不出具放行结论</div>
            <div>检测到 {anomalies.length} 项异常，须全部排除后方可判定。以下为异常清单。</div>
          </>
        ) : release ? (
          <>
            <div className="v-big">✅ 整组放行（PASS）</div>
            <div>无异常，且每条具名 Rf 区间面积百分比阈值均通过。</div>
          </>
        ) : (
          <>
            <div className="v-big">⛔ 不出具放行结论</div>
            <div>存在未通过的阈值或缺少阈值配置。</div>
          </>
        )}
      </div>

      <div className="subhead">逐条阈值判定依据</div>
      <div className="table-scroll">
        <table className="calc">
          <thead>
            <tr>
              <th>区间</th>
              <th>实测占比</th>
              <th>允许范围</th>
              <th>判定</th>
            </tr>
          </thead>
          <tbody>
            {thresholdChecks.map((c) => (
              <tr key={c.zoneId}>
                <td>{c.name}</td>
                <td>{c.pct}%</td>
                <td>[{c.minPct}%, {c.maxPct}%]</td>
                <td className={c.pass ? 'pass-txt' : 'fail-txt'}>{c.pass ? '通过 ✓' : '不通过 ✗'}</td>
              </tr>
            ))}
            {thresholdChecks.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">尚未配置任何区间阈值。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="calc-line">
        有效扫描区总面积 = <b>{totalArea}</b> cps·距离；未分类面积 = <b>{unclassifiedArea}</b>（{unclassifiedPct}%，阈值 {result.unclassifiedTolerancePct}%）
      </div>

      <div className="subhead">异常清单（{anomalies.length}）</div>
      {anomalies.length === 0 && <div className="empty-note good">未发现异常。</div>}
      <ul className="anom-list">
        {anomalies.map((a, k) => (
          <li key={k}>
            <span className="anom-tag">{ANOM_LABEL[a.code] ?? a.code}</span>
            <span>{a.message}</span>
            {(a.atIndex !== undefined || a.peakIndex !== undefined || a.zoneId) && (
              <span className="muted">
                {' '}
                [
                {a.atIndex !== undefined ? `采样点 #${a.atIndex}` : ''}
                {a.peakIndex !== undefined ? `峰 #${a.peakIndex + 1}` : ''}
                {a.zoneId ? `区间 ${a.zoneId}` : ''}
                ]
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="hint">判定规则：存在任意异常（距离乱序/重复、标定无效、基线未覆盖、边界交叉/越界、未分类面积超阈值、区间重叠等）即不生成放行结论；无异常时，每条阈值均通过才判整组放行。</p>
      {canRelease === false && anomalies.length === 0 && null}
    </div>
  );
}
