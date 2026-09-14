// 放射性薄层色谱归算台 — 核心类型定义

/** 单个扫描采样点（本地 JSON 导入） */
export interface InputPoint {
  /** 距点样原点的迁移距离（任意长度单位，须与标定一致，通常为 mm） */
  distance: number;
  /** 该点采集到的总计数（counts） */
  counts: number;
  /** 该点检测（活时间 live time），单位秒；缺省时使用数据集顶层 liveTime */
  liveTime?: number;
}

/** 导入的扫描数据集 */
export interface TLCDataSet {
  /** 样品/薄层板编号 */
  sampleId?: string;
  /** 核素名称（如 Tc-99m、F-18） */
  nuclide?: string;
  /** 检测日期时间（ISO 字符串，仅用于快照） */
  measuredAt?: string;
  /** 全局检测活时间（秒），点级 liveTime 优先 */
  liveTime?: number;
  /** 扫描点 */
  points: InputPoint[];
}

/** 基线段状线性锚点（锚定到采样点索引） */
export interface Anchor {
  id: string;
  /** 采样点索引 */
  index: number;
  /** 该锚点基线水平（计数率 cps），可纵向拖动 */
  y: number;
}

/** 峰谷共享边界（锚定到采样点索引） */
export interface Boundary {
  id: string;
  /** 采样点索引（谷点） */
  index: number;
}

/** 曲线上的标定点 */
export type MarkerKind = 'origin' | 'front' | 'scanStart' | 'scanEnd';

export interface Calibration {
  /** 点样原点所在采样点索引（Rf = 0） */
  originIndex: number | null;
  /** 溶剂前沿所在采样点索引（Rf = 1） */
  frontIndex: number | null;
  /** 有效扫描区起点采样点索引 */
  scanStartIndex: number | null;
  /** 有效扫描区终点采样点索引 */
  scanEndIndex: number | null;
}

/** 具名 Rf 区间及面积百分比阈值 */
export interface RfZone {
  id: string;
  /** 组分名称（如 标记产物、游离高锝酸盐、水解还原锝） */
  name: string;
  /** Rf 下限 */
  rfMin: number;
  /** Rf 上限 */
  rfMax: number;
  /** 面积百分比下限（%） */
  minPct: number;
  /** 面积百分比上限（%） */
  maxPct: number;
}

export type Severity = 'error';

/** 计算过程中发现的异常（任一异常存在即不出具放行结论） */
export interface Anomaly {
  code:
    | 'DISTANCE_DISORDERED'
    | 'DISTANCE_DUPLICATE'
    | 'BAD_LIVE_TIME'
    | 'CAL_INVALID'
    | 'ANCHORS_INSUFFICIENT'
    | 'BASELINE_UNCOVERED'
    | 'BOUNDARY_UNORDERED'
    | 'BOUNDARY_OUTSIDE_SCAN'
    | 'BOUNDARY_DUPLICATE'
    | 'PEAK_BASELINE_UNCOVERED'
    | 'PEAK_RF_OUT_OF_RANGE'
    | 'ZONE_INVALID'
    | 'ZONE_OVERLAP'
    | 'UNCLASSIFIED_AREA'
    | 'ZONE_PCT_RANGE';
  /** 面向技师的中文说明 */
  message: string;
  /** 关联采样点索引（便于图上定位） */
  atIndex?: number;
  /** 关联区间 id */
  zoneId?: string;
  /** 关联峰序号（自 0 起） */
  peakIndex?: number;
  /** 实际值/阈值等数值细节 */
  detail?: Record<string, number | string>;
  severity: Severity;
}

/** 一段梯形积分（相邻采样点之间，或边界插值切分后的片段） */
export interface Trap {
  iL: number;
  iR: number;
  xL: number;
  xR: number;
  yL: number;
  yR: number;
  area: number;
}

/** 峰面积按 Rf 区间边界线性插值拆分后的片段 */
export interface SplitPiece {
  zoneId: string | null;
  zoneName: string | null;
  /** 片段左右端点距离；若由插值产生，端点可能落在采样点之间 */
  xL: number;
  xR: number;
  yL: number;
  yR: number;
  area: number;
  /** 插值点说明（左/右端是否为 Rf 区间边界插值得出） */
  interpolatedLeft?: boolean;
  interpolatedRight?: boolean;
}

/** 单个已识别峰的完整计算结果 */
export interface PeakResult {
  /** 峰自 1 起的显示序号 */
  no: number;
  /** 左/右谷边界采样点索引（共享谷点即同一索引） */
  leftBoundaryIndex: number;
  rightBoundaryIndex: number;
  /** Rf（取扣底截断后峰顶位置） */
  apexIndex: number;
  apexDistance: number;
  rf: number;
  /** 峰总面积（截断扣底曲线在两谷之间的梯形积分） */
  area: number;
  /** 占有效扫描区总面积的百分比 */
  pct: number;
  /** 峰内是否存在基线锚点未覆盖的采样点 */
  baselineUncovered: boolean;
  /** 逐采样间隔的梯形积分算式 */
  traps: Trap[];
  /** 按具名 Rf 区间拆分（边界处线性插值） */
  splits: SplitPiece[];
}

/** 具名区间的汇总 */
export interface ZoneSummary {
  zoneId: string;
  name: string;
  rfMin: number;
  rfMax: number;
  /** 对应的距离边界 */
  xMin: number;
  xMax: number;
  area: number;
  pct: number;
  minPct: number;
  maxPct: number;
  pass: boolean;
}

/** 完整分析结果（驱动图、侧栏与导出） */
export interface AnalysisResult {
  /** 是否具备最低可绘条件（>=2 点且距离单调），仅用于决定能否绘图 */
  plottable: boolean;
  anomalies: Anomaly[];
  /** 每点：计数率（原始，cps） */
  rawRate: number[];
  /** 每点：分段线性基线（cps）；锚点覆盖范围外为 null */
  baseline: (number | null)[];
  /** 每点：未截断扣底曲线 = rawRate - baseline；覆盖范围外为 null */
  netRate: (number | null)[];
  /** 每点：参与计算的扣底曲线 = max(0, netRate)；覆盖范围外为 null */
  clampedRate: (number | null)[];
  peaks: PeakResult[];
  zones: ZoneSummary[];
  /** 有效扫描区总面积（截断扣底曲线梯形积分） */
  totalArea: number;
  /** 未落入任何具名 Rf 区间的面积（含跨区拆分后的未分类片段） */
  unclassifiedArea: number;
  unclassifiedPct: number;
  /** 未分类面积容差（%） */
  unclassifiedTolerancePct: number;
  /** Rf 换算 */
  originDistance: number | null;
  frontDistance: number | null;
  scanStartIndex: number | null;
  scanEndIndex: number | null;
  /** true = 无任何异常，可出具结论 */
  canRelease: boolean;
  /** 仅当 canRelease 时有效：所有阈值均通过才整组放行 */
  release: boolean;
  /** 每条阈值的逐条判定依据 */
  thresholdChecks: { zoneId: string; name: string; pass: boolean; pct: number; minPct: number; maxPct: number }[];
  computedAt: string;
}

/** 可被拖动的图元 */
export type DragKind = MarkerKind | 'anchor' | 'boundary';

export interface Selection {
  kind: DragKind;
  id: string;
  /** 锚点/标定 marker 用；boundary 无纵向拖动 */
}

/** 导出的 JSON 结构 */
export interface ExportBundle {
  format: 'radio-tlc-cosign';
  formatVersion: 1;
  exportedAt: string;
  software: string;
  inputSnapshot: TLCDataSet;
  calibration: Calibration;
  anchors: Anchor[];
  boundaries: Boundary[];
  rfZones: RfZone[];
  unclassifiedTolerancePct: number;
  result: AnalysisResult;
}
