import type { RfZone } from '../types';
import { uid } from '../analysis';

interface ZonesPanelProps {
  zones: RfZone[];
  tolerancePct: number;
  onChange: (zones: RfZone[]) => void;
  onTolerance: (v: number) => void;
}

export default function ZonesPanel({ zones, tolerancePct, onChange, onTolerance }: ZonesPanelProps): JSX.Element {
  const update = (id: string, patch: Partial<RfZone>): void => {
    onChange(zones.map((z) => (z.id === id ? { ...z, ...patch } : z)));
  };
  const add = (): void => {
    onChange([
      ...zones,
      { id: uid('zone'), name: `组分 ${zones.length + 1}`, rfMin: 0, rfMax: 1, minPct: 0, maxPct: 100 },
    ]);
  };
  const remove = (id: string): void => onChange(zones.filter((z) => z.id !== id));

  return (
    <div className="panel">
      <h3>③ 具名 Rf 区间与放行阈值</h3>
      <p className="hint">面积百分比 = 该 Rf 区间内（扫描全程、截断扣底曲线）梯形积分 / 有效扫描区总面积。区间不可重叠。</p>
      <div className="table-scroll">
        <table className="calc zones">
          <thead>
            <tr>
              <th>组分名称</th>
              <th>Rf 下限</th>
              <th>Rf 上限</th>
              <th>占比下限%</th>
              <th>占比上限%</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {zones.map((z) => (
              <tr key={z.id}>
                <td>
                  <input value={z.name} onChange={(e) => update(z.id, { name: e.target.value })} />
                </td>
                <td>
                  <input
                    type="number"
                    step="any"
                    min={0}
                    max={1}
                    value={z.rfMin}
                    onChange={(e) => update(z.id, { rfMin: parseFloat(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="any"
                    min={0}
                    max={1}
                    value={z.rfMax}
                    onChange={(e) => update(z.id, { rfMax: parseFloat(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="any"
                    min={0}
                    max={100}
                    value={z.minPct}
                    onChange={(e) => update(z.id, { minPct: parseFloat(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="any"
                    min={0}
                    max={100}
                    value={z.maxPct}
                    onChange={(e) => update(z.id, { maxPct: parseFloat(e.target.value) })}
                  />
                </td>
                <td>
                  <button className="btn-x" onClick={() => remove(z.id)} aria-label="删除区间">
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button className="btn" onClick={add}>＋ 新增区间</button>
        <label className="tol">
          未分类面积告警阈值：
          <input
            type="number"
            step="any"
            min={0}
            max={100}
            value={tolerancePct}
            onChange={(e) => onTolerance(parseFloat(e.target.value))}
          />
          %
        </label>
      </div>
    </div>
  );
}
