// 时间参数：--since 30m|6h|24h|7d，或 --from / --to。
// 秒懂的执行列表按毫秒时间戳查，起止时间必传；7 天窗口光首页就要 17–22 秒（实测），所以默认只看最近 24 小时。

import { strArg } from './args.mjs';
import { usage } from './errors.mjs';
import { formatTime } from './output.mjs';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text) {
  const m = /^(\d+)\s*([mhd])$/i.exec(String(text ?? '').trim());
  if (!m || Number(m[1]) <= 0) throw usage(`时间长度写成 30m、6h、24h、7d 这样，收到「${text}」`);
  return Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
}

// 2026-09-23、2026-09-23 10:00、2026-09-23T10:00:30 按本地时间理解；其余交给 Date.parse（ISO）
export function parseTime(text) {
  const s = String(text ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const [, y, mo, d, hh = '0', mi = '0', ss = '0'] = m;
    const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss)).getTime();
    if (Number.isFinite(t)) return t;
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw usage(`看不懂的时间「${text}」`, '写成 2026-09-23 10:00（中间有空格就加引号）或 ISO 时间');
  return t;
}

export function timeWindow(args, { defaultSince = '24h', now = Date.now() } = {}) {
  const since = strArg(args, 'since');
  const from = strArg(args, 'from');
  const to = strArg(args, 'to');
  if (since && (from || to)) throw usage('--since 和 --from / --to 只能二选一');
  const end = to ? parseTime(to) : now;
  const start = from ? parseTime(from) : end - parseDuration(since ?? defaultSince);
  if (!(start < end)) throw usage(`时间窗不对：开始 ${formatTime(start)} 不早于结束 ${formatTime(end)}`);
  return { start, end, label: `${formatTime(start)} ~ ${formatTime(end)}` };
}
