/**
 * 秒懂工作流试运行核心能力。
 *
 * 设计边界：
 * - 纯函数负责画布副作用预检和执行结果归一化；
 * - HTTP 只通过调用方注入的 requester 发起，模块本身不读取账号、DB 或环境变量；
 * - 每次 getTrialRun 只查询一次，不在这里做轮询或 sleep；
 * - preflight 扫描整张画布（包括当前输入可能不可达的分支），并对未知节点 fail closed。
 *
 * 已验证的秒懂契约：
 * - POST /api/canvas/exec?orgId=  body={canvasId,sessionId,triggerType,receiveTextMessage}
 * - GET  /api/canvas/exec?canvasExecId=&orgId=
 * - POST /api/canvas/node/exec?orgId= body={canvasId,nodeId,inputs:{inputData}}
 * - GET  /api/canvas/node/exec?nodeExecId=&orgId=
 */

export type MiaodongRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
};

/** 与 miaodongFetch 的 path/options 形状一致，但不把其 DB 依赖带进本模块。 */
export type MiaodongRequester = (
  path: string,
  options?: MiaodongRequestOptions,
) => Promise<unknown>;

export type TrialNodeRisk = 'safe' | 'dangerous';

export type TrialPreflightNode = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  nodeCategory: string;
  risk: TrialNodeRisk;
  reasons: string[];
};

export type TrialPreflight = {
  /** 没有发现业务副作用节点；不代表试运行免费或不会创建执行记录。 */
  safe: boolean;
  requiresApproval: boolean;
  scannedNodeCount: number;
  safeNodes: TrialPreflightNode[];
  dangerousNodes: TrialPreflightNode[];
  reasons: string[];
};

export type StartTrialRunInput = {
  orgId: string;
  canvasId: string;
  sessionId: string;
  text: string;
};

export type StartTrialRunResult = {
  execId: string;
  sessionId: string;
};

export type GetTrialRunInput = {
  orgId: string;
  canvasExecId: string;
};

export type StartNodeTrialRunInput = {
  orgId: string;
  canvasId: string;
  nodeId: string;
  nodeInputs: Record<string, unknown>;
};

export type StartNodeTrialRunResult = {
  execId: string;
};

export type GetNodeTrialRunInput = {
  orgId: string;
  nodeExecId: string;
  canvasId: string;
  nodeId: string;
  nodeName?: string;
  nodeType?: string;
  nodeCategory?: string;
  nodeInputs?: Record<string, unknown>;
};

type NormalizeNodeTrialRunInput = Omit<GetNodeTrialRunInput, 'orgId'>;

export type NormalizedTokenUsage = {
  total: number;
  prompt: number | null;
  completion: number | null;
  reasoning: number | null;
  promptCache: number | null;
  calls: number | null;
  raw: unknown;
};

export type NormalizedCost = {
  cny: number | null;
  usd: number | null;
};

export type NormalizedTrialNodeResult = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  nodeCategory: string;
  status: string;
  input: unknown;
  output: unknown;
  error: unknown;
  duration: number;
  outputBranchId: string | null;
  actions: unknown[];
  metadata: {
    prompt: unknown;
    reasoning: unknown;
    token: NormalizedTokenUsage;
    cost: NormalizedCost;
    requestIds: unknown;
    toolCallResults: unknown;
    /** 保留平台未来新增的 metadata 字段，避免归一化时静默丢证据。 */
    raw: Record<string, unknown> | null;
  };
};

export type NormalizedTrialRun = {
  execId: string;
  sessionId: string;
  canvasId: string;
  status: string;
  isTerminal: boolean;
  canvasVersion: string | null;
  isCanary: boolean | null;
  testRun: boolean | null;
  token: NormalizedTokenUsage;
  cost: NormalizedCost;
  duration: number;
  outputActions: unknown[];
  error: unknown;
  sessionMemorySnapshot: unknown;
  nodeResults: NormalizedTrialNodeResult[];
};

type UnknownRecord = Record<string, unknown>;

const TERMINAL_STATUSES = new Set([
  'success',
  'cancelled',
  'canceled',
  'error',
  'failed',
  'merged_skipped',
  'interrupted',
]);

const SAFE_NODE_REASONS: Record<string, string> = {
  'llm-completion': '仅执行模型推理，不直接修改联系人或外部业务数据',
  'rule-center': '仅进行条件判断和流程分支',
  'javascript-code': '仅执行画布内计算；未识别为外部动作节点',
  'speech-to-text': '仅进行媒体内容识别',
  'query-knowledge-base': '仅读取知识库内容',
  'query-sql-db': '仅读取数据知识库',
};

const DANGEROUS_NODE_REASONS: Record<string, string> = {
  'send-text-message': '可能向真实联系人发送文本消息',
  'send-image-message': '可能向真实联系人发送图片消息',
  'send-audio-message': '可能向真实联系人发送语音消息',
  'send-combination-message': '可能向真实联系人发送组合消息',
  'send-material': '可能向真实联系人发送素材',
  'tag-user': '会新增或移除真实联系人的标签',
  'invite-room': '可能向真实联系人发起入群邀请',
  'canvas-event-action': '会立即触发事件，或创建延时/定时事件',
  'action-event': '会立即触发事件，或创建延时/定时事件',
  'update-data': '会修改本次会话的 Session 变量和状态',
  'update-custom-attr': '会修改真实联系人的自定义属性',
  handover: '会触发转人工并改变真实会话路由',
  'plugin-action': '插件动作可能调用外部系统并产生业务副作用',
  'plugin-calculation': '插件计算的外部调用语义未知，不能证明为只读',
};

const GENERIC_DANGEROUS_TYPE = /(?:^|[-_])(send|write|insert|update|delete|remove|create|publish|push|tag|handover|transfer|invite|schedule|webhook)(?:$|[-_])/i;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function firstNumber(record: UnknownRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstString(record: UnknownRecord, keys: string[]): string {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return '';
}

function parseJsonObject(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function canvasCellsFrom(value: unknown): UnknownRecord[] {
  const parsed = parseJsonObject(value);
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord);
  }
  if (!isRecord(parsed)) return [];

  if (Array.isArray(parsed.rawCanvas)) {
    return parsed.rawCanvas.filter(isRecord);
  }
  if (Array.isArray(parsed.canvas)) {
    return parsed.canvas.filter(isRecord);
  }
  if (Array.isArray(parsed.nodes)) {
    const edges = Array.isArray(parsed.edges) ? parsed.edges.filter(isRecord) : [];
    return [...parsed.nodes.filter(isRecord), ...edges];
  }

  // 兼容 {canvas:{rawCanvas}}, {canvas:{nodes,edges}} 和 API 信封 {data:{...}}。
  for (const child of [parsed.canvas, parsed.workflow, parsed.data]) {
    const cells = canvasCellsFrom(child);
    if (cells.length > 0) return cells;
  }
  return [];
}

function isEdge(cell: UnknownRecord): boolean {
  if (cell.shape === 'edge' || cell.shape === 'custom-curve-edge') return true;
  const source = isRecord(cell.source) ? cell.source : null;
  const target = isRecord(cell.target) ? cell.target : null;
  return Boolean(source?.cell && target?.cell);
}

function isVisualOnly(cell: UnknownRecord): boolean {
  const shape = asString(cell.shape);
  const data = isRecord(cell.data) ? cell.data : {};
  const category = asString(data.category || cell.category);
  return shape.startsWith('canvas-tool-') || category === 'comment';
}

function describeNode(cell: UnknownRecord): Omit<TrialPreflightNode, 'risk' | 'reasons'> {
  const data = isRecord(cell.data) ? cell.data : {};
  return {
    nodeId: firstString(cell, ['id', 'nodeId']),
    nodeName: firstString(data, ['name']) || firstString(cell, ['name']),
    nodeType:
      firstString(data, ['type']) ||
      firstString(cell, ['type']) ||
      firstString(cell, ['shape']),
    nodeCategory: firstString(data, ['category']) || firstString(cell, ['category']),
  };
}

function classifyNode(
  node: Omit<TrialPreflightNode, 'risk' | 'reasons'>,
): Pick<TrialPreflightNode, 'risk' | 'reasons'> {
  const type = node.nodeType;
  const category = node.nodeCategory;

  if (DANGEROUS_NODE_REASONS[type]) {
    return { risk: 'dangerous', reasons: [DANGEROUS_NODE_REASONS[type]] };
  }

  if (SAFE_NODE_REASONS[type]) {
    return { risk: 'safe', reasons: [SAFE_NODE_REASONS[type]] };
  }

  // 触发器本身只定义入口，不是被试运行调用后产生业务副作用的动作。
  if (category === 'trigger' || type.startsWith('receive-') || type === 'new-friend' || type === 'tag-event' || type === 'canvas-event-trigger') {
    return { risk: 'safe', reasons: ['仅定义工作流触发入口'] };
  }

  if (category === 'action') {
    return {
      risk: 'dangerous',
      reasons: ['未识别的动作节点，无法证明不会修改真实业务状态'],
    };
  }

  if (GENERIC_DANGEROUS_TYPE.test(type)) {
    return {
      risk: 'dangerous',
      reasons: ['节点类型包含写入、发送或外部动作语义，无法证明为只读'],
    };
  }

  // 对未知节点 fail closed，避免平台新增动作/插件类型后被旧白名单当成安全节点。
  return {
    risk: 'dangerous',
    reasons: ['节点类型或分类未知，无法确认试运行是否有业务副作用'],
  };
}

/**
 * 扫描整张 workflow/canvas，生成试运行前的副作用清单。
 *
 * `safe=true` 只表示未发现会发送消息、写联系人/会话状态、调度事件等业务副作用。
 * 试运行本身仍会创建执行记录，LLM/插件节点也可能产生模型或 API 费用。
 */
function executableCells(workflowOrCanvas: unknown): UnknownRecord[] {
  return canvasCellsFrom(workflowOrCanvas)
    .filter((cell) => !isEdge(cell) && !isVisualOnly(cell));
}

function buildPreflightFromCells(cells: UnknownRecord[]): TrialPreflight {
  const nodes = cells.map((cell) => {
    const node = describeNode(cell);
    return { ...node, ...classifyNode(node) };
  });

  const safeNodes = nodes.filter((node) => node.risk === 'safe');
  const dangerousNodes = nodes.filter((node) => node.risk === 'dangerous');
  const reasons = [
    ...new Set(dangerousNodes.flatMap((node) => node.reasons)),
  ];

  if (nodes.length === 0) {
    reasons.push('没有识别到可执行节点，无法证明画布可以安全试运行');
  }
  if (dangerousNodes.length === 0 && nodes.length > 0) {
    reasons.push('未发现业务副作用节点；试运行仍会创建执行记录并可能产生模型或 API 费用');
  }

  const safe = nodes.length > 0 && dangerousNodes.length === 0;
  return {
    safe,
    requiresApproval: !safe,
    scannedNodeCount: nodes.length,
    safeNodes,
    dangerousNodes,
    reasons,
  };
}

export function buildTrialPreflight(workflowOrCanvas: unknown): TrialPreflight {
  return buildPreflightFromCells(executableCells(workflowOrCanvas));
}

function requireUniqueNodeCell(workflowOrCanvas: unknown, nodeIdValue: string): UnknownRecord {
  const nodeId = requireNonEmpty(nodeIdValue, 'nodeId');
  const matches = executableCells(workflowOrCanvas)
    .filter((cell) => describeNode(cell).nodeId === nodeId);
  if (matches.length === 0) {
    throw new Error(`单节点试运行目标不存在于当前秒懂画布：${nodeId}`);
  }
  if (matches.length > 1) {
    throw new Error(`当前秒懂画布中 nodeId 不唯一，已阻止单节点试运行：${nodeId}`);
  }
  return matches[0] as UnknownRecord;
}

/** 单节点试运行只扫描目标节点，但对未知/动作节点仍 fail closed。 */
export function buildNodeTrialPreflight(workflowOrCanvas: unknown, nodeId: string): TrialPreflight {
  return buildPreflightFromCells([requireUniqueNodeCell(workflowOrCanvas, nodeId)]);
}

function configuredNodeInputs(cell: UnknownRecord): UnknownRecord[] {
  const data = isRecord(cell.data) ? cell.data : {};
  const payload = isRecord(data.nodePayload) ? data.nodePayload : {};
  const configured: UnknownRecord[] = Array.isArray(payload.inputs)
    ? payload.inputs.filter(isRecord)
    : [];
  for (const candidate of [payload.query, payload.count]) {
    if (isRecord(candidate)) configured.push(candidate);
  }
  return configured;
}

function isMissingInputValue(value: unknown): boolean {
  return value === undefined || value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0);
}

/**
 * 根据秒懂节点 nodePayload 检查必填的运行时输入。
 * 只校验画布明确标记的 isRequired 字段，不猜测平台未声明的隐式上下文。
 */
export function validateNodeTrialInputs(
  workflowOrCanvas: unknown,
  nodeId: string,
  nodeInputs: unknown,
): asserts nodeInputs is Record<string, unknown> {
  const cell = requireUniqueNodeCell(workflowOrCanvas, nodeId);
  if (!isRecord(nodeInputs)) {
    throw new Error('单节点试运行 nodeInputs 必须是 JSON 对象');
  }

  const requiredNames = new Set<string>();
  for (const configured of configuredNodeInputs(cell)) {
    const name = asString(configured.name).trim();
    const type = isRecord(configured.type) ? configured.type : {};
    if (name && (type.isRequired === true || configured.isRequired === true)) {
      requiredNames.add(name);
    }
  }

  // 语音转文字的测试面板会把 mediaUrl 类型翻译成 audioUrl/videoUrl。
  const data = isRecord(cell.data) ? cell.data : {};
  const payload = isRecord(data.nodePayload) ? data.nodePayload : {};
  const mediaUrl = isRecord(payload.mediaUrl) ? payload.mediaUrl : {};
  const mediaType = isRecord(mediaUrl.type) ? asString(mediaUrl.type.type) : '';
  if (mediaType === 'audio') requiredNames.add('audioUrl');
  if (mediaType === 'video') requiredNames.add('videoUrl');

  const missing = [...requiredNames]
    .filter((name) => !Object.prototype.hasOwnProperty.call(nodeInputs, name) || isMissingInputValue(nodeInputs[name]));
  if (missing.length > 0) {
    throw new Error(`单节点试运行缺少必填输入：${missing.join('、')}`);
  }
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`试运行参数缺少 ${field}`);
  return trimmed;
}

function unwrapData(payload: unknown): unknown {
  if (isRecord(payload) && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data;
  }
  return payload;
}

/** 启动一次文本触发试运行。只负责发起，不等待执行结束。 */
export async function startTrialRun(
  requester: MiaodongRequester,
  input: StartTrialRunInput,
): Promise<StartTrialRunResult> {
  const orgId = requireNonEmpty(input.orgId, 'orgId');
  const canvasId = requireNonEmpty(input.canvasId, 'canvasId');
  const sessionId = requireNonEmpty(input.sessionId, 'sessionId');
  const text = requireNonEmpty(input.text, 'text');

  const payload = unwrapData(await requester('/api/canvas/exec', {
    method: 'POST',
    query: { orgId },
    body: {
      canvasId,
      sessionId,
      triggerType: 'receive-text-message',
      receiveTextMessage: { text },
    },
  }));

  const record = isRecord(payload) ? payload : {};
  const execId = firstString(record, ['execId', 'canvasExecId']);
  if (!execId) {
    throw new Error('秒懂试运行启动失败：上游未返回 execId');
  }
  return { execId, sessionId };
}

/** 启动一次单节点试运行。调用方必须先完成节点 id 映射、存在性和副作用预检。 */
export async function startNodeTrialRun(
  requester: MiaodongRequester,
  input: StartNodeTrialRunInput,
): Promise<StartNodeTrialRunResult> {
  const orgId = requireNonEmpty(input.orgId, 'orgId');
  const canvasId = requireNonEmpty(input.canvasId, 'canvasId');
  const nodeId = requireNonEmpty(input.nodeId, 'nodeId');
  if (!isRecord(input.nodeInputs)) {
    throw new Error('单节点试运行 nodeInputs 必须是 JSON 对象');
  }

  const payload = unwrapData(await requester('/api/canvas/node/exec', {
    method: 'POST',
    query: { orgId },
    body: {
      canvasId,
      nodeId,
      inputs: { inputData: input.nodeInputs },
    },
  }));
  const record = isRecord(payload) ? payload : {};
  const execId = firstString(record, ['execId', 'nodeExecId']);
  if (!execId) {
    throw new Error('秒懂单节点试运行启动失败：上游未返回 execId');
  }
  return { execId };
}

function normalizeTokenUsage(value: unknown): NormalizedTokenUsage {
  const record = isRecord(value) ? value : {};
  const directPrompt = firstNumber(record, ['prompt', 'promptTokens', 'input', 'inputTokens']);
  const directCompletion = firstNumber(record, ['completion', 'completionTokens', 'output', 'outputTokens']);
  const directReasoning = firstNumber(record, ['reasoning', 'reasoningTokens']);
  const directPromptCache = firstNumber(record, ['promptCache', 'cached', 'cachedTokens']);
  const directCalls = firstNumber(record, ['calls', 'callCount']);
  const explicitTotal = firstNumber(record, ['total', 'totalTokens', 'tokenCount']);

  // canvasExec.tokenCount 实测还有 {modelId:{prompt,completion,...}} 形态；节点 metadata.tokenUsage
  // 则通常是单层对象。只在当前层没有直接 token 字段时聚合子对象，避免重复计算。
  const hasDirectUsage = [
    directPrompt,
    directCompletion,
    directReasoning,
    directPromptCache,
    directCalls,
    explicitTotal,
  ].some((part) => part !== null);
  const nested = hasDirectUsage
    ? []
    : Object.values(record).filter(isRecord).map((part) => normalizeTokenUsage(part));
  const sumNested = (pick: (usage: NormalizedTokenUsage) => number | null): number | null => {
    const values = nested.map(pick).filter((part): part is number => part !== null);
    return values.length > 0 ? values.reduce((sum, part) => sum + part, 0) : null;
  };

  const prompt = directPrompt ?? sumNested((usage) => usage.prompt);
  const completion = directCompletion ?? sumNested((usage) => usage.completion);
  const reasoning = directReasoning ?? sumNested((usage) => usage.reasoning);
  const promptCache = directPromptCache ?? sumNested((usage) => usage.promptCache);
  const calls = directCalls ?? sumNested((usage) => usage.calls);

  let total = explicitTotal;
  if (total === null && typeof value === 'number' && Number.isFinite(value)) total = value;
  if (total === null && nested.length > 0) total = nested.reduce((sum, usage) => sum + usage.total, 0);
  if (total === null) total = (prompt ?? 0) + (completion ?? 0) + (reasoning ?? 0);

  return {
    total,
    prompt,
    completion,
    reasoning,
    // promptCache 通常是 prompt 的子集，不重复计入 total。
    promptCache,
    calls,
    raw: value ?? null,
  };
}

function normalizeCost(
  record: UnknownRecord,
  cnyKeys: string[],
  usdKeys: string[],
): NormalizedCost {
  return {
    cny: firstNumber(record, cnyKeys),
    usd: firstNumber(record, usdKeys),
  };
}

function normalizeTokenCost(value: unknown): NormalizedCost {
  if (!isRecord(value)) return { cny: null, usd: null };
  const direct = normalizeCost(
    value,
    ['costInCny', 'totalCostInCny', 'cny'],
    ['costInUsd', 'totalCostInUsd', 'usd'],
  );
  if (direct.cny !== null || direct.usd !== null) return direct;

  const nestedCosts = Object.values(value).filter(isRecord).map(normalizeTokenCost);
  const sum = (currency: keyof NormalizedCost): number | null => {
    const values = nestedCosts
      .map((cost) => cost[currency])
      .filter((part): part is number => part !== null);
    return values.length > 0 ? values.reduce((total, part) => total + part, 0) : null;
  };
  return { cny: sum('cny'), usd: sum('usd') };
}

type NodeMeta = { name: string; type: string; category: string };

function buildNodeMetaIndex(data: UnknownRecord): Map<string, NodeMeta> {
  const snapshotCandidates = [
    isRecord(data.canvas) ? data.canvas.rawCanvas : null,
    isRecord(data.canvasExec) ? data.canvasExec.rawCanvas : null,
    data.rawCanvas,
  ];
  const rawCanvas = snapshotCandidates.find(Array.isArray);
  const index = new Map<string, NodeMeta>();
  if (!Array.isArray(rawCanvas)) return index;

  for (const cell of rawCanvas) {
    if (!isRecord(cell) || isEdge(cell) || isVisualOnly(cell)) continue;
    const node = describeNode(cell);
    if (!node.nodeId) continue;
    index.set(node.nodeId, {
      name: node.nodeName,
      type: node.nodeType,
      category: node.nodeCategory,
    });
  }
  return index;
}

function normalizeTrialNodeResult(
  result: UnknownRecord,
  fallback: Partial<NodeMeta> & { nodeId?: string; input?: unknown } = {},
): NormalizedTrialNodeResult {
  const nodeId = firstString(result, ['nodeId', 'id']) || fallback.nodeId || '';
  const metadata = isRecord(result.metadata) ? result.metadata : null;
  const tokenUsage = metadata?.tokenUsage ?? result.tokenUsage ?? null;
  const tokenRecord = isRecord(tokenUsage) ? tokenUsage : {};

  return {
    nodeId,
    nodeName: fallback.name || firstString(result, ['nodeName', 'name']),
    nodeType: fallback.type || firstString(result, ['nodeType', 'type']),
    nodeCategory: fallback.category || firstString(result, ['nodeCategory', 'category']),
    status: firstString(result, ['status']) || 'unknown',
    input: result.inputs ?? result.input ?? fallback.input ?? null,
    output: result.output ?? null,
    error: result.errorMessage ?? result.error ?? null,
    duration: firstNumber(result, ['processDuration', 'duration']) ?? 0,
    outputBranchId: firstString(result, ['outputBranchId']) || null,
    actions: Array.isArray(result.actions) ? result.actions : [],
    metadata: {
      prompt: metadata?.prompt ?? null,
      reasoning: metadata?.reasoningMessage ?? metadata?.reasoning ?? null,
      token: normalizeTokenUsage(tokenUsage),
      cost: normalizeCost(
        tokenRecord,
        ['costInCny', 'totalCostInCny', 'cny'],
        ['costInUsd', 'totalCostInUsd', 'usd'],
      ),
      requestIds: metadata?.requestIds ?? null,
      toolCallResults: metadata?.toolCallResults ?? null,
      raw: metadata,
    },
  };
}

/** 归一化 GET /api/canvas/exec 的完整响应；可直接用于缓存样本的脱网重放。 */
export function normalizeTrialRun(payload: unknown): NormalizedTrialRun {
  const unwrapped = unwrapData(payload);
  if (!isRecord(unwrapped)) {
    throw new Error('秒懂试运行结果无效：上游没有返回执行详情');
  }

  const canvasExec = isRecord(unwrapped.canvasExec) ? unwrapped.canvasExec : null;
  if (!canvasExec) {
    throw new Error('秒懂试运行结果无效：缺少 canvasExec');
  }
  const canvas = isRecord(unwrapped.canvas) ? unwrapped.canvas : {};
  const nodeMetaById = buildNodeMetaIndex(unwrapped);
  const rawNodeResults = Array.isArray(unwrapped.nodeResults)
    ? unwrapped.nodeResults.filter(isRecord)
    : [];

  const nodeResults = rawNodeResults.map((result): NormalizedTrialNodeResult => {
    const nodeId = firstString(result, ['nodeId', 'id']);
    const snapshotMeta = nodeMetaById.get(nodeId);
    return normalizeTrialNodeResult(result, { nodeId, ...snapshotMeta });
  });

  const status = firstString(canvasExec, ['status']) || 'unknown';
  const reportedCost = normalizeCost(
    canvasExec,
    ['totalCostInCny', 'costInCny'],
    ['totalCostInUsd', 'costInUsd'],
  );
  const tokenCost = normalizeTokenCost(canvasExec.tokenCount ?? canvasExec.tokenUsage ?? null);
  return {
    execId: firstString(canvasExec, ['execId', 'canvasExecId']),
    sessionId: firstString(canvasExec, ['sessionId']),
    canvasId: firstString(canvasExec, ['canvasId']) || firstString(canvas, ['canvasId']),
    status,
    isTerminal: TERMINAL_STATUSES.has(status.toLowerCase()),
    canvasVersion:
      firstString(canvasExec, ['canvasVersion']) ||
      firstString(canvas, ['version', 'canvasVersion']) ||
      null,
    isCanary: asBoolean(canvasExec.isCanary),
    testRun: asBoolean(canvasExec.testRun),
    token: normalizeTokenUsage(canvasExec.tokenCount ?? canvasExec.tokenUsage ?? null),
    cost: {
      cny: reportedCost.cny ?? tokenCost.cny,
      usd: reportedCost.usd ?? tokenCost.usd,
    },
    duration: firstNumber(canvasExec, ['processDuration', 'duration']) ?? 0,
    outputActions: Array.isArray(canvasExec.outputActions) ? canvasExec.outputActions : [],
    error: canvasExec.errorMessage ?? canvasExec.error ?? null,
    sessionMemorySnapshot: canvasExec.sessionMemorySnapshot ?? null,
    nodeResults,
  };
}

/** 将 GET /api/canvas/node/exec 的单节点结果归一化到与全链路相同的结果结构。 */
export function normalizeNodeTrialRun(
  payload: unknown,
  input: NormalizeNodeTrialRunInput,
): NormalizedTrialRun {
  const expectedExecId = requireNonEmpty(input.nodeExecId, 'nodeExecId');
  const expectedCanvasId = typeof input.canvasId === 'string' ? input.canvasId.trim() : '';
  const expectedNodeId = requireNonEmpty(input.nodeId, 'nodeId');
  const unwrapped = unwrapData(payload);
  if (!isRecord(unwrapped)) {
    throw new Error('秒懂单节点试运行结果无效：上游没有返回执行详情');
  }
  const nodeExec = isRecord(unwrapped.nodeExec) ? unwrapped.nodeExec : unwrapped;
  const actualExecId = firstString(nodeExec, ['execId', 'nodeExecId']);
  if (actualExecId && actualExecId !== expectedExecId) {
    throw new Error(`秒懂单节点试运行结果 execId 不匹配：${actualExecId}`);
  }
  const actualNodeId = firstString(nodeExec, ['nodeId', 'id']);
  if (actualNodeId && actualNodeId !== expectedNodeId) {
    throw new Error(`秒懂单节点试运行结果 nodeId 不匹配：${actualNodeId}`);
  }
  const status = firstString(nodeExec, ['status']);
  if (!status) {
    throw new Error('秒懂单节点试运行结果无效：缺少 status');
  }

  const nodeResult = normalizeTrialNodeResult(nodeExec, {
    nodeId: expectedNodeId,
    name: input.nodeName,
    type: input.nodeType,
    category: input.nodeCategory,
    input: input.nodeInputs ?? {},
  });
  const token = nodeResult.metadata.token;
  const cost = nodeResult.metadata.cost;
  return {
    execId: expectedExecId,
    sessionId: '',
    canvasId: firstString(nodeExec, ['canvasId']) || expectedCanvasId,
    status,
    isTerminal: TERMINAL_STATUSES.has(status.toLowerCase()),
    canvasVersion: firstString(nodeExec, ['canvasVersion', 'version']) || null,
    isCanary: asBoolean(nodeExec.isCanary),
    testRun: asBoolean(nodeExec.testRun),
    token,
    cost,
    duration: nodeResult.duration,
    outputActions: nodeResult.actions,
    error: nodeResult.error,
    sessionMemorySnapshot: null,
    nodeResults: [nodeResult],
  };
}

/** 查询一次试运行状态/结果；调用方自行决定何时再次查询。 */
export async function getTrialRun(
  requester: MiaodongRequester,
  input: GetTrialRunInput,
): Promise<NormalizedTrialRun> {
  const orgId = requireNonEmpty(input.orgId, 'orgId');
  const canvasExecId = requireNonEmpty(input.canvasExecId, 'canvasExecId');
  const payload = await requester('/api/canvas/exec', {
    method: 'GET',
    query: { canvasExecId, orgId },
  });
  return normalizeTrialRun(payload);
}

/** 查询一次单节点试运行状态/结果；调用方自行轮询。 */
export async function getNodeTrialRun(
  requester: MiaodongRequester,
  input: GetNodeTrialRunInput,
): Promise<NormalizedTrialRun> {
  const orgId = requireNonEmpty(input.orgId, 'orgId');
  const nodeExecId = requireNonEmpty(input.nodeExecId, 'nodeExecId');
  const payload = await requester('/api/canvas/node/exec', {
    method: 'GET',
    query: { nodeExecId, orgId },
  });
  return normalizeNodeTrialRun(payload, input);
}
