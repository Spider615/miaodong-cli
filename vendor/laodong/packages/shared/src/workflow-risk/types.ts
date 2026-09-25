// 逐节点 workflow 风险分析——对外输出类型。
//
// 检测器是纯确定性的：读 workflow JSON → 逐节点/逐边/逐引用做字段级判定 → 产出按节点分组的 findings。
// 输出形状刻意镜像 chat-agent 的 NodeChange（change-summary.ts），方便前端复用「改动清单」的 per-node 卡片。

/** 三档严重度：error=平台导入 400 / 节点抛异常；warn=运行期静默错（取值恒空/分支永不命中）；info=卫生/低置信告警。 */
export type RiskSeverity = 'error' | 'warn' | 'info';

/** 风险大类（对应分类法 A–H）。 */
export type RiskCategory =
  | 'llm-json' // A：LLM 输出 JSON、下游不解析/不守卫
  | 'broken-ref' // B：悬空引用（referenceNodeId / dataPath / 模板变量）
  | 'session' // C：session/槽位读写不匹配
  | 'reachability' // D：可达性（死节点 / 触发器未接 / 输出无人消费）
  | 'broken-seam' // D：接缝断裂（LLM-json→消费者中间缺 JS 解析）
  | 'rule-center' // E：rule-center 专项
  | 'compliance' // F：结构合规（多数导入 400）
  | 'js-runtime' // G：JS 节点运行期隐患
  | 'content' // H：内容占位（空 prompt / 缺模型）
  | 'external-dep' // H：外部依赖占位（KB/插件/素材 id 为空）
  | 'hygiene'; // 卫生类（未用输入等）

/** 修复建议。before/after 供前端渲染「当前值→建议值」两栏 diff（复用 FieldDiffsDetails）。 */
export interface RiskFix {
  /** 一句话中文修复说明。 */
  summary: string;
  /** 关联字段路径（如 data.nodePayload.inputs[0].dataPath）。 */
  path?: string;
  /** 当前值（供 diff 左栏）。 */
  before?: string;
  /** 建议值（供 diff 右栏）。 */
  after?: string;
}

export interface RiskFinding {
  /** 规则编号，如 'A1'、'B2'、'G3'。 */
  code: string;
  /** 机器可读 slug，如 'llm-json-consumed-without-parse'。 */
  rule: string;
  category: RiskCategory;
  severity: RiskSeverity;
  /** 中文风险描述（面向运营/用户）。 */
  message: string;
  /** 命中的节点 id；结构/事件级问题可空（归入 globalFindings）。 */
  nodeId?: string;
  /** 命中的边 id（接缝/连线类）。 */
  edgeId?: string;
  /** 命中的 JSON 字段路径，供前端定位。 */
  path?: string;
  /** 修复建议。 */
  fix?: RiskFix;
  /** 关联的其它节点 id（如引用的上游、缺失的解析节点位置），供前端连线高亮。 */
  relatedNodeIds?: string[];
}

/** 按节点分组的风险（镜像 change-summary.ts 的 NodeChange 结构）。 */
export interface NodeRiskGroup {
  nodeId: string;
  /** id 前 8 位，供卡片标题。 */
  shortId: string;
  name: string;
  shape: string;
  /** 该节点内最严重等级。 */
  severity: RiskSeverity;
  findings: RiskFinding[];
}

export interface RiskSummary {
  total: number;
  error: number;
  warn: number;
  info: number;
  /** 有至少一条 finding 的节点数。 */
  affectedNodes: number;
}

export interface RiskReport {
  /** JSON 是否可解析（合法 JSON 且含 canvas 数组）。false 时只填 parseError。 */
  ok: boolean;
  /** ok=false 时的原因。 */
  parseError?: string;
  /** 按节点分组的 findings（severity 降序，节点内 findings 也降序）。 */
  nodeGroups: NodeRiskGroup[];
  /** 不归属具体节点的全局 findings（events/canvas 级）。 */
  globalFindings: RiskFinding[];
  summary: RiskSummary;
  meta: {
    nodeCount: number;
    edgeCount: number;
  };
}

/** 严重度排序权重（越大越严重）。 */
export const SEVERITY_WEIGHT: Record<RiskSeverity, number> = {
  error: 3,
  warn: 2,
  info: 1,
};
