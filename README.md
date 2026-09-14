# 放射性薄层色谱归算台（radio-TLC Co-sign Console）

面向医院核医学科技师的**药品放行前** radio-TLC 面积归算工具。
TypeScript + React + Vite + 手写 SVG，**纯前端、完全离线**：不启动后端、不引用任何 CDN，
导入的扫描数据只存在于本机浏览器内存/localStorage，导出 JSON 留档。

> 本工具仅用于放行前归算辅助，最终放行须由授权技师/药师核对。

## 启动 / 构建

```bash
npm install
npm run dev        # 本地开发
npm run build      # 类型检查 + 产物到 dist/（相对路径，可直接 file:// 打开或拷入内网静态盘）
npm run preview    # 预览构建产物
npm run selftest   # 核心算法离线自测（15 组，含手算梯形、插值拆分、全部异常分支）
```

离线部署：把 `dist/` 整个目录拷到受控内网机器，双击 `index.html` 即可（无网络依赖）。

## 输入 JSON 格式

```json
{
  "sampleId": "薄层板编号（可选）",
  "nuclide": "Tc-99m（可选）",
  "measuredAt": "2026-09-14T08:30:00Z（可选）",
  "liveTime": 2,
  "points": [
    { "distance": 0, "counts": 245, "liveTime": 2 },
    { "distance": 1, "counts": 251 }
  ]
}
```

- `distance`：距点样原点的迁移距离（任意长度单位，通常 mm），**必须严格单调递增**；
- `counts`：该点总计数；`liveTime` 为检测活时间（秒），点级缺省时取顶层值；
- 计数率按 `rate = counts / liveTime`（cps）归算；界面内全部积分均以 cps×距离 为面积单位。

界面右上角可“下载输入样例”获取含三峰的合成数据。

## 操作流程

1. **导入 JSON**（或“载入演示数据”）。载入后自动放置：扫描起点/终点、点样原点/溶剂前沿四个标定点、
   两个端部基线锚点，以及按显著峰自动给出的内部峰谷边界——全部可拖动调整。
2. 在曲线上：
   - 横向拖动 **点样原点（Rf=0）、溶剂前沿（Rf=1）、有效扫描区起点/终点**；
   - 拖动橙色**基线锚点**（可横、纵两个方向）；**双击绘图区**可在最近采样点加锚点；
   - 拖动红色虚线**峰谷边界**（共享谷点，相邻两条边界夹一个峰）；选中后按 Delete 可删除锚点/边界。
3. 右侧面板配置**具名 Rf 区间与面积百分比上下限**（如 标记产物 90–100%、原点杂质/前沿游离 ≤ 限值）。
4. 查看逐峰的边界、Rf、逐间隔梯形算式与跨区插值拆分；查看异常清单与放行结论。
5. **导出归算 JSON**：含输入快照、标定点、锚点、边界、逐峰算式、区间汇总与逐条判定依据。

工作状态自动写入浏览器 localStorage，刷新不丢失（清除浏览器数据或换机器请用导出文件交接）。

## 计算口径（与界面算式一致）

1. 计数率：`rate_i = counts_i / liveTime_i`。
2. 基线：锚点之间**分段线性插值**，在锚点覆盖范围内逐点扣底：
   `net_i = rate_i − baseline_i`（未截断扣底曲线，紫色虚线保留显示）；
   参与计算的曲线 `y_i = max(0, net_i)`（负值归零，青色曲线）。
   覆盖范围之外不参与积分，并报“基线未覆盖”。
3. Rf：`Rf_i = (d_i − d_origin) / (d_front − d_origin)`；峰 Rf 取**截断扣底后峰顶**。
4. 峰面积：相邻采样点**梯形积分**
   `A = Σ (y_i + y_{i+1}) / 2 × (d_{i+1} − d_i)`，积分区间为两谷边界之间；
   共享谷点只作为两侧梯形的**共同端点**，不重复计面积。
5. 跨区拆分：峰跨越具名 Rf 区间边界时，在边界距离 `x = d_origin + Rf·(d_front − d_origin)` 处
   对截断扣底曲线**线性插值**取高，沿切分点把梯形片段拆开归类。
6. 分类占比：按整个有效扫描区逐间隔积分（不依赖峰谷，避免峰外平台漏算），
   `pct = 区间面积 / 有效扫描区总面积 × 100%`。

## 异常 → 不出结论

只要存在以下任一异常，**不生成放行结论**（红条）；无异常且每条阈值通过才判整组放行（绿条）：

| 代码 | 含义 |
| --- | --- |
| `DISTANCE_DISORDERED` / `DISTANCE_DUPLICATE` | 距离乱序 / 重复（梯形积分要求严格单调） |
| `BAD_LIVE_TIME` | 活时间缺失/非正或计数非法，无法换算 cps |
| `CAL_INVALID` | 标定点缺失/越界，或不满足 扫描起点 ≤ 原点 < 前沿 ≤ 扫描终点 |
| `ANCHORS_INSUFFICIENT` / `BASELINE_UNCOVERED` / `PEAK_BASELINE_UNCOVERED` | 锚点不足、扫描区或峰内存在基线未覆盖点 |
| `BOUNDARY_UNORDERED` / `BOUNDARY_OUTSIDE_SCAN` / `BOUNDARY_DUPLICATE` | 边界交叉、越出扫描区、重合 |
| `PEAK_RF_OUT_OF_RANGE` | 峰顶 Rf 超出 [0,1] |
| `ZONE_INVALID` / `ZONE_OVERLAP` | 区间参数非法（含未配置任何阈值） / 区间重叠 |
| `UNCLASSIFIED_AREA` | 未落入任何具名区间的面积占比超过设定阈值 |
| `ZONE_PCT_RANGE` | 某区间实测占比不在 [下限%, 上限%] |

## 目录

```
src/
  types.ts            全部数据/结果/导出结构
  analysis.ts         纯函数核心：校验、基线、积分、拆分、判定（可被 Node 自测直接调用）
  components/
    Chart.tsx         SVG 曲线、标定点/锚点/边界拖拽、Rf 副轴、十字光标、区间底色
    SetupPanel.tsx    标定/锚点/边界的表格化精调
    PeaksPanel.tsx    逐峰边界、Rf、梯形算式、跨区插值拆分
    ZonesPanel.tsx    具名 Rf 区间与阈值编辑
    VerdictPanel.tsx  异常清单、逐条阈值依据、放行结论
  App.tsx             状态、JSON 导入校验、localStorage、导出留档
scripts/selftest.mjs  15 组算法自测
```

## 导出 JSON

`format: "radio-tlc-cosign", formatVersion: 1`，包含：
`inputSnapshot`（原始输入快照）、`calibration`、`anchors`、`boundaries`、`rfZones`、
`result`（逐点 rawRate/baseline/netRate/clampedRate、逐峰 traps 与 splits、区间汇总、
`anomalies`、`thresholdChecks`、`canRelease/release` 及计算时间）。
