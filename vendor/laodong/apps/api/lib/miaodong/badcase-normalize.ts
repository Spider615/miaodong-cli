// apps/api/lib/miaodong/badcase-normalize.ts

/**
 * 调优中心响应的归一化纯函数（无 IO / 无 db 依赖，可脱网单测、可被 miaodong-kit 直接 import）。
 *
 * 从 badcase-query.ts 抽出，行为逐字保持一致。抽出的原因：
 *   badcase-query.ts 顶部 import 了 @juzi/db（binding 查询），任何想复用这些归一化的地方
 *   （如 miaodong-kit 的独立 CLI）一 import 就会连带初始化 SQLite。
 *   这些函数本身与 db 无关，单独成模块后 badcase-query.ts 与 kit 共享同一份，避免两处实现漂移。
 *
 * 这里每个函数都对应一个线上实测过的脏数据形态，不是防御性洁癖：
 *   - createdAt 是 ISO 字符串而非 epoch
 *   - tokenCount 是对象（且常为空对象 {}）而非数字
 *   - triggerContent 是 {triggerType, content:{text}} 嵌套对象而非字符串
 *   - nodeResults 元素没有节点名/类型，得靠画布快照反查
 */

/**
 * 从 outputActions 数组里提取 bot 文本回复。
 * outputActions: [{type:'send-text-message', payload:{text:'...'}}, ...]
 */
export function extractBotReply(outputActions: unknown): string {
  if (!Array.isArray(outputActions)) return '';
  const texts: string[] = [];
  for (const action of outputActions) {
    if (action && typeof action === 'object') {
      const a = action as Record<string, unknown>;
      const payload = a.payload as Record<string, unknown> | undefined;
      const text = payload?.text ?? payload?.content;
      if (typeof text === 'string' && text.trim()) texts.push(text.trim());
    }
  }
  return texts.join(' / ');
}

/** 时间字段统一成 epoch ms：实测调优中心 createdAt 是 ISO 字符串，需 Date.parse（直接 Number() 会得 NaN → "Invalid time value"）。 */
export function toEpochMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/**
 * 明确**不是** token 的字段，累加时必须排除：
 *   - cost*：是钱（实测 metadata.tokenUsage 里就有 costInCny / costInUsd，小数）
 *   - calls：是调用次数
 *   - promptCache / cached：是 prompt 的子集，再加一遍会虚高
 * 参照 trial-core.ts 的 normalizeTokenUsage —— 同一平台同一字段，两处口径必须一致。
 */
const NON_TOKEN_KEYS = new Set([
  'cost', 'costincny', 'costinusd', 'totalcost', 'totalcostincny', 'totalcostinusd',
  'calls', 'callcount',
  'promptcache', 'cached', 'cachedtokens',
]);

/**
 * tokenCount 实测可能是数字、单层对象 {prompt,completion,reasoning,...}、
 * 或按模型分组的嵌套对象 {modelId:{prompt,completion,...}}。
 *
 * 无差别累加所有数值字段会把「钱」和「调用次数」当成 token 加进去
 * （实测 {prompt:100,completion:20,reasoning:5,promptCache:40,calls:1,costInCny:0.35,costInUsd:0.048}
 * 会被算成 166.398 而不是 125，小数点本身就是钱混进来的物证）。
 */
export function toTokenCount(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object') {
    const record = v as Record<string, unknown>;
    // 显式总数优先，有它就不必再逐项累加
    for (const key of ['total', 'totalTokens', 'tokenCount']) {
      const n = Number(record[key]);
      if (Number.isFinite(n) && record[key] !== undefined && record[key] !== null) return n;
    }
    let sum = 0;
    for (const [k, x] of Object.entries(record)) {
      if (NON_TOKEN_KEYS.has(k.toLowerCase())) continue;
      if (x && typeof x === 'object') {
        sum += toTokenCount(x); // {modelId:{...}} 形态
        continue;
      }
      const n = Number(x);
      if (Number.isFinite(n)) sum += n;
    }
    return sum;
  }
  return 0;
}

/** 触发内容：实测是 {triggerType, content:{text}} 嵌套对象，取里面的文本；非文本类用 triggerType 标注。 */
export function extractTriggerText(tc: unknown): string {
  if (typeof tc === 'string') return tc;
  if (tc && typeof tc === 'object') {
    const t = tc as Record<string, unknown>;
    const content = t.content as Record<string, unknown> | undefined;
    if (content && typeof content.text === 'string') return content.text;
    if (typeof t.text === 'string') return t.text;
    if (typeof t.triggerType === 'string') return `[${t.triggerType}]`;
  }
  return '';
}

// ============================================================
// 事件链路回溯（2026-08-16 线上实测契约）
//
// 秒懂把「一次业务处理」拆成多条执行记录：链路 A 跑完，用 canvas-event-action 节点发出事件，
// 秒懂再起一条**新的执行**去跑该事件的入口链路 B。两条链在画布上没有连线，
// 在调优中心也是两条独立记录——被点踩的往往是最后那条「只负责把话发出去」的续集。
//
// 能精确配对，靠的是实测出来的这条等式：
//   上游列表条目 outputActions[].payload = { eventId, eventName, params }
//   下游执行详情 canvasExec.eventSnapshot.canvasEvent = { eventId, data, executionId }
//   且 params 与 data 逐字段一致。
// 于是「谁发出了这条事件」= 同会话里 eventId 相同且载荷对得上的那条，不用按时间猜。
//
// ⚠️ canvasEvent.executionId 不是画布执行 ID（拿它查 history/details 返回 CANVAS_EXEC_NOT_FOUND，
//    兴趣岛 / 巴奴两个 bot 均已验证），所以不能靠它直接跳。
// ============================================================

export type EventTriggerInfo = {
  eventId: string;
  payload: unknown;
  triggerSource: string | null;
  foreignExecutionId: string | null;
};

/**
 * 从 canvasExec.eventSnapshot 里取事件触发信息。
 * 返回 null = 这条不是事件触发的（是用户消息 / 标签变更等真正的源头）。
 */
export function extractEventTrigger(canvasExec: unknown): EventTriggerInfo | null {
  if (!canvasExec || typeof canvasExec !== 'object') return null;
  const snapshot = (canvasExec as Record<string, unknown>).eventSnapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as Record<string, unknown>;
  const ce = s.canvasEvent;
  if (!ce || typeof ce !== 'object') return null;
  const c = ce as Record<string, unknown>;
  const eventId = typeof c.eventId === 'string' ? c.eventId : '';
  if (!eventId) return null;
  return {
    eventId,
    payload: c.data ?? null,
    triggerSource: typeof s.triggerSource === 'string' ? s.triggerSource : null,
    foreignExecutionId: typeof c.executionId === 'string' ? c.executionId : null,
  };
}

/**
 * 详情响应的 canvasExec **没有** triggerContent 字段（实测），真正的触发内容按类型分布在
 * eventSnapshot 的不同子对象里（canvasEvent.data / receiveTextMessage.text / …）。
 * 以前直接读 canvasExec.triggerContent，所以详情里的「触发内容」恒为空。
 */
export function extractTriggerTextFromSnapshot(canvasExec: unknown): string {
  if (!canvasExec || typeof canvasExec !== 'object') return '';
  const c = canvasExec as Record<string, unknown>;

  // 先挖 snapshot 里的真实文本。顺序不能反：extractTriggerText 对事件类会退化成
  // "[canvas-event-trigger]" 这种占位符，而它是 truthy，先跑就会把真正的文本永久挡住。
  const snapshot = c.eventSnapshot;
  if (snapshot && typeof snapshot === 'object') {
    const s = snapshot as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      const v = s[key];
      if (!v || typeof v !== 'object') continue;
      const o = v as Record<string, unknown>;
      // 事件类：真正的内容在 data 里；消息类：直接就是 text
      const box = (o.data && typeof o.data === 'object' ? o.data : o) as Record<string, unknown>;
      if (typeof box.text === 'string' && box.text.trim()) return box.text.trim();
    }
  }

  // 兜底：老字段（列表条目有、详情的 canvasExec 没有），以及非文本触发的 "[tag-event]" 类标注
  return extractTriggerText(c.triggerContent);
}

export type EmittedEvent = { eventId: string; eventName: string; params: unknown };

/** 从一条执行的 outputActions 里挑出它发出的事件（canvas-event-action）。 */
export function extractEmittedEvents(outputActions: unknown): EmittedEvent[] {
  if (!Array.isArray(outputActions)) return [];
  const out: EmittedEvent[] = [];
  for (const action of outputActions) {
    if (!action || typeof action !== 'object') continue;
    const a = action as Record<string, unknown>;
    if (a.type !== 'canvas-event-action') continue;
    const payload = (a.payload ?? {}) as Record<string, unknown>;
    const eventId = typeof payload.eventId === 'string' ? payload.eventId : '';
    if (!eventId) continue;
    out.push({
      eventId,
      eventName: typeof payload.eventName === 'string' ? payload.eventName : '',
      params: payload.params ?? null,
    });
  }
  return out;
}

/**
 * 判断「上游发出的载荷」和「下游收到的载荷」是不是同一次事件。
 *
 * 不用整体深比较：上游 params 与下游 data 的键集合不保证完全一致（平台可能加字段），
 * 一旦不一致整体比较就恒为 false。改成比共有的**标量**字段：
 *   - 有任一共有标量字段对不上 → 直接否掉
 *   - 没有任何冲突且至少配上一个 → 命中
 * 实测同一事件被同会话多条执行发出时，text / userLastMsgId 必然不同，足以区分。
 */
export type EventPayloadVerdict =
  /** 有共有标量字段且全部相等 —— 就是同一次事件 */
  | 'match'
  /** 有共有标量字段但对不上 —— **可证伪**，这条一定不是上游 */
  | 'conflict'
  /** 没有可比的共有标量字段 —— 判不了，不代表不是 */
  | 'unknown';

/**
 * 三态而不是布尔：'conflict'（证明不是）和 'unknown'（判不了）后果完全不同。
 * 压成一个 false 的话，调用方会把「已被证伪的候选」和「无从判断的候选」一起丢进
 * 按时间猜的兜底里，于是一条**已经证明不是上游**的执行会被接上链路，
 * 再从它继续往上爬——整条链都是伪造的，而且看起来收敛得很漂亮。
 */
export function compareEventPayload(emitted: unknown, received: unknown): EventPayloadVerdict {
  if (!emitted || typeof emitted !== 'object' || !received || typeof received !== 'object') {
    return 'unknown';
  }
  const a = emitted as Record<string, unknown>;
  const b = received as Record<string, unknown>;
  let matched = 0;
  for (const key of Object.keys(a)) {
    if (!(key in b)) continue;
    const va = a[key];
    const vb = b[key];
    const scalarA = va === null || ['string', 'number', 'boolean'].includes(typeof va);
    const scalarB = vb === null || ['string', 'number', 'boolean'].includes(typeof vb);
    if (!scalarA || !scalarB) continue; // 嵌套结构不参与判定，避免平台加字段就整体误否
    if (va !== vb) return 'conflict';
    matched += 1;
  }
  return matched > 0 ? 'match' : 'unknown';
}

/** compareEventPayload 的布尔简写：只有确定匹配才算数。 */
export function eventPayloadMatches(emitted: unknown, received: unknown): boolean {
  return compareEventPayload(emitted, received) === 'match';
}

/**
 * 一条执行在链路重建里需要的最小信息。
 * 全部能从**列表**响应直出——实测列表条目的 rawTrigger 与详情的 canvasExec.eventSnapshot
 * 逐字节一致，所以整条链一次 list 就能拼完，不必为每一跳再查一遍详情。
 */
export type ChainExec = {
  execId: string;
  timestamp: number;
  triggerType: string;
  /** 用户原话（receive-* 类）或事件文本；事件类由 rawTrigger.canvasEvent.data 提供。 */
  triggerText: string;
  /** 本条是被哪个事件触发的（null = 它就是源头）。 */
  triggeredBy: { eventId: string; eventName: string; payload: unknown } | null;
  /** 本条发出了哪些事件。 */
  emits: EmittedEvent[];
  /** 本条最终做了什么（send-text-message / handover / …），去掉 canvas-event-action。 */
  actionTypes: string[];
};

/** 把列表响应的一条原始条目转成 ChainExec（纯函数，字段名全部来自实测契约）。 */
export function toChainExec(item: unknown): ChainExec | null {
  if (!item || typeof item !== 'object') return null;
  const it = item as Record<string, unknown>;
  const execId = String(it.execId ?? it.id ?? '');
  if (!execId) return null;

  const rawTrigger = (it.rawTrigger ?? {}) as Record<string, unknown>;
  const tc = (it.triggerContent ?? {}) as Record<string, unknown>;
  const triggerType =
    (typeof rawTrigger.triggerType === 'string' && rawTrigger.triggerType) ||
    (typeof tc.triggerType === 'string' && tc.triggerType) ||
    '';

  // rawTrigger 与详情的 eventSnapshot 同构，直接复用同一个解析器
  const ev = extractEventTrigger({ eventSnapshot: rawTrigger });
  let eventName = '';
  const tcContent = (tc.content ?? {}) as Record<string, unknown>;
  if (typeof tcContent.eventName === 'string') eventName = tcContent.eventName;

  const emits = extractEmittedEvents(it.outputActions);
  const actionTypes = Array.isArray(it.outputActions)
    ? [
        ...new Set(
          (it.outputActions as unknown[])
            .map((a) => (a && typeof a === 'object' ? String((a as Record<string, unknown>).type ?? '') : ''))
            .filter((t) => t && t !== 'canvas-event-action'),
        ),
      ]
    : [];

  return {
    execId,
    timestamp: toEpochMs(it.createdAt ?? it.triggerTime ?? it.timestamp),
    triggerType,
    triggerText: extractTriggerTextFromSnapshot({ triggerContent: it.triggerContent, eventSnapshot: rawTrigger }),
    triggeredBy: ev ? { eventId: ev.eventId, eventName, payload: ev.payload } : null,
    emits,
    actionTypes,
  };
}

export type ChainHop = ChainExec & {
  /** exact=载荷唯一匹配；ambiguous=同事件多条候选，按时间取最近的一条；root=链路源头。 */
  link: 'exact' | 'ambiguous' | 'root';
  /** link=ambiguous 时的其余候选 execId。 */
  otherCandidates: string[];
};

/**
 * 从某条执行出发，沿事件反向走到链路源头，返回**正序**（源头在前）的调用链。
 *
 * 配对规则：上游 emits[].eventId === 本条 triggeredBy.eventId，且 params 与 payload 对得上
 * （eventPayloadMatches）。实测同一事件在同会话里会被多条执行发出（20 分钟内 4 条），
 * 光靠 eventId + 时间先后会认错人，载荷比对才是唯一可靠的判据。
 *
 * maxHops 兜底防环：秒懂允许 A 发事件给 B、B 再发回 A 的写法，没有它会死循环。
 */
export function buildExecutionChain(
  targetExecId: string,
  pool: ChainExec[],
  maxHops = 8,
): ChainHop[] {
  const byId = new Map(pool.map((e) => [e.execId, e]));
  const target = byId.get(targetExecId);
  if (!target) return [];

  const chain: ChainHop[] = [];
  const visited = new Set<string>();
  let cursor: ChainExec | undefined = target;

  while (cursor && chain.length < maxHops) {
    if (visited.has(cursor.execId)) break; // 成环，停
    visited.add(cursor.execId);
    // link 描述的是「本跳与它上游那跳之间的边」，所以必须挂在下游这一跳上，
    // 而且只能在解析完上游之后才写得出来。'root' = 没有再往上的一跳
    // （真源头，或时间窗没覆盖到上游导致断链——看 triggerType 就能分辨）。
    const record: ChainHop = { ...cursor, link: 'root', otherCandidates: [] };
    chain.push(record);

    // 固化本轮游标：下面的闭包里再引用可变的 cursor，TS 会因为
    // cursor 的新值反过来由这些闭包推导而判定循环引用（TS7022），也更难读。
    const current: ChainExec = cursor;
    const trigger = current.triggeredBy;
    if (!trigger) break; // 走到源头（用户消息 / 标签变更等）

    // 候选：本条之前发出过同一 eventId 的执行
    const candidates = pool.filter(
      (e) =>
        e.execId !== current.execId &&
        e.timestamp <= current.timestamp &&
        e.emits.some((m) => m.eventId === trigger.eventId),
    );
    // 按三态分组：conflict 的候选已被证伪，绝不能进兜底
    const matched: ChainExec[] = [];
    const undecided: ChainExec[] = [];
    for (const e of candidates) {
      const verdicts = e.emits
        .filter((m) => m.eventId === trigger.eventId)
        .map((m) => compareEventPayload(m.params, trigger.payload));
      if (verdicts.includes('match')) matched.push(e);
      else if (verdicts.includes('unknown')) undecided.push(e);
      // 全是 conflict → 已证明不是上游，直接丢弃
    }

    if (matched.length === 1) {
      record.link = 'exact';
      cursor = matched[0];
    } else if (matched.length > 1) {
      // 载荷都对得上（同一秒重复触发之类），退回取时间最近的一条并如实标注
      const sorted = [...matched].sort((a, b) => b.timestamp - a.timestamp);
      record.link = 'ambiguous';
      record.otherCandidates = sorted.slice(1).map((e) => e.execId);
      cursor = sorted[0];
    } else if (undecided.length > 0) {
      // 载荷判不了（共有标量为空）：不装作精确，如实降级成按时间猜并把其余候选亮出来
      const sorted = [...undecided].sort((a, b) => b.timestamp - a.timestamp);
      record.link = 'ambiguous';
      record.otherCandidates = sorted.slice(1).map((e) => e.execId);
      cursor = sorted[0];
    } else {
      // 要么窗口里压根没有发过这个事件的执行，要么有但载荷全部对不上（已证伪）。
      // 两种都意味着「真上游不在这个池子里」，如实断在这儿，不接一条错的上去。
      break;
    }
  }

  return chain.reverse();
}

// ============================================================
// 值溯源：一个值在这条执行里是谁产生的
//
// 三分类，不是两分类。「输入里有这个值」其实有两种含义，后果完全相反：
//   · 在 inputs 里 = 上游算好传进来的 → 这个节点是搬运工，继续往上游追
//   · 不在 inputs、却在 prompt 里 = 来自节点**自身的静态配置**
//     （prompt = 配置模板 + inputs 代入，所以差集就是配置里写死的部分）
//     → 产地就是这个节点的配置，往上游追是白追
//
// 实测踩过：一句被点踩的话术，其实是写死在 LLM 节点 systemPrompt 里的预置文案
// （"第二部分 当执行完第一部分后，用户再一次回复消息才发送话术：…"），
// 两分类会判成「上游传进来的」，把排查引向一个根本不存在的上游；
// 而正确结论是——该看的是这段配置本身，以及它挂的触发条件为什么这次成立了。
// ============================================================

export type ValueProvenanceHit = {
  index: number;
  name: string;
  type: string;
  /** 值出现在上游传入的 inputs 里 —— 这个节点只是搬运工 */
  fromUpstream: boolean;
  /** 值出现在节点自身配置里（提示词预置话术 / 代码常量 / 规则字面值） */
  inConfig: boolean;
  inOutput: boolean;
};

export type ValueProvenanceResult = {
  hits: ValueProvenanceHit[];
  /** hardcoded=配置里写死；generated=该节点产生；external=全部来自上游，值从这条执行外面来；none=没搜到 */
  verdict: 'hardcoded' | 'generated' | 'external' | 'none';
  origin: ValueProvenanceHit | null;
};

type ProvenanceNode = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  input: unknown;
  output: unknown;
  prompt?: unknown;
};

export function classifyValueProvenance(
  nodeResults: ProvenanceNode[],
  needle: string,
): ValueProvenanceResult {
  const target = needle.trim();
  if (!target) return { hits: [], verdict: 'none', origin: null };

  const str = (v: unknown) => (v === null || v === undefined ? '' : JSON.stringify(v));

  const hits: ValueProvenanceHit[] = nodeResults.map((nr, i) => {
    const fromUpstream = str(nr.input).includes(target);
    return {
      index: i + 1,
      name: nr.nodeName || nr.nodeId,
      type: nr.nodeType,
      fromUpstream,
      // 只有「不是上游传入」时才算配置——否则 prompt 里代入的上游值会被误判成配置
      inConfig: !fromUpstream && str(nr.prompt).includes(target),
      inOutput: str(nr.output).includes(target),
    };
  });

  const touched = hits.filter((h) => h.fromUpstream || h.inConfig || h.inOutput);
  if (touched.length === 0) return { hits: [], verdict: 'none', origin: null };

  // 优先级：配置里写死 > 该节点生成 > 全部来自上游。
  // 配置排最前，因为它最容易被误判成「模型生成的」而去调温度 / 加提示词约束——
  // 那句话根本不是模型想出来的，是配置里预置的，改温度一点用没有。
  const hardcoded = hits.find((h) => h.inConfig);
  if (hardcoded) return { hits: touched, verdict: 'hardcoded', origin: hardcoded };

  const generated = hits.find((h) => !h.fromUpstream && !h.inConfig && h.inOutput);
  if (generated) return { hits: touched, verdict: 'generated', origin: generated };

  return { hits: touched, verdict: 'external', origin: null };
}

export type NodeMeta = { name: string; type: string; category: string };

/**
 * 从画布快照建 branchId → 分支名 索引。
 *
 * nodeResults 里的 outputBranchId 是裸 UUID，单看没有任何信息量；
 * 配上规则中心 nodePayload.branches 里的 name 才能回答「为什么走了这条路」（实测形如 "L3" / "L4"）。
 */
export function buildBranchNameIndex(rawCanvas: unknown): Map<string, string> {
  const index = new Map<string, string>();
  if (!Array.isArray(rawCanvas)) return index;
  for (const cell of rawCanvas) {
    if (!cell || typeof cell !== 'object') continue;
    const d = ((cell as Record<string, unknown>).data ?? {}) as Record<string, unknown>;
    const payload = (d.nodePayload ?? {}) as Record<string, unknown>;
    const branches = payload.branches;
    if (Array.isArray(branches)) {
      for (const b of branches) {
        if (!b || typeof b !== 'object') continue;
        const br = b as Record<string, unknown>;
        const id = typeof br.branchId === 'string' ? br.branchId : '';
        const name = typeof br.name === 'string' ? br.name : '';
        if (id && name) index.set(id, name);
      }
    }
    const dft = payload.defaultBranchId;
    if (typeof dft === 'string' && dft && !index.has(dft)) index.set(dft, '默认分支');
  }
  return index;
}

/**
 * 从执行详情响应里的画布快照（data.canvas.rawCanvas）建 nodeId → 节点元信息索引。
 *
 * 为什么需要：nodeResults 元素只有 nodeId/status/inputs/output/errorMessage/processDuration，
 * 实测【没有】name/type/category。要显示"哪个节点报错了"的中文业务名，只能靠同一响应里的
 * 画布快照按 id 反查（实测对执行过的节点 100% 命中）。
 *
 * 注意：快照里边的 shape 是 'edge'（不是 canvas/get 的 'custom-curve-edge'），但反查靠 id 精确匹配，不受影响。
 */
export function buildNodeMetaIndex(rawCanvas: unknown): Map<string, NodeMeta> {
  const index = new Map<string, NodeMeta>();
  if (!Array.isArray(rawCanvas)) return index;
  for (const cell of rawCanvas) {
    if (!cell || typeof cell !== 'object') continue;
    const c = cell as Record<string, unknown>;
    const id = typeof c.id === 'string' ? c.id : '';
    if (!id) continue;
    const d = (c.data ?? {}) as Record<string, unknown>;
    index.set(id, {
      name: typeof d.name === 'string' ? d.name : '',
      // type 优先取 data.type，回退到 X6 的 shape（自定义 UUID-shape 节点 data.type 可能缺失）
      type: typeof d.type === 'string' ? d.type : typeof c.shape === 'string' ? c.shape : '',
      category: typeof d.category === 'string' ? d.category : '',
    });
  }
  return index;
}
