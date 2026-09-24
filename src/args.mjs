// 参数解析（从 lib/credentials.mjs 搬来，旧文件 re-export，两边共用一份）。

import { usage } from './errors.mjs';

/** 被当成布尔 false 的字面值。写 `--confirm false` 的人显然不想确认。 */
const FALSY_WORDS = new Set(['false', '0', 'no', 'off', 'n']);

// 同一个参数给了多次就收成数组：--input 这类要给多个；只该给一次的（--bot / --limit …）由 strArg / intArg 报错。
// 以前是悄悄取最后一个——`--bot 甲 --bot 乙` 会静默落到乙上
function assign(out, key, value) {
  if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
  else if (Array.isArray(out[key])) out[key].push(value);
  else out[key] = [out[key], value];
}

/**
 * 解析命令行参数。支持：
 *   --key value     → { key: 'value' }
 *   --key=value     → { key: 'value' }
 *   --key           → { key: true }        （后面没值，或紧跟另一个 --flag）
 *   --key false     → { key: false }       （false/0/no/off/n 一律解析成布尔 false）
 *   --no-key        → { key: false }
 *
 * ⚠️ 为什么要认 `--key false`：这里的开关有 `--confirm` 这种「真的会写线上」的。
 * 早期版本把值一律当字符串，于是 `--confirm false` 得到字符串 "false"（truthy），
 * `if (!args.confirm)` 判断失效 —— 实测会直接推送覆盖线上画布。布尔语义必须在解析层就定死。
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    if (a.startsWith('--no-') && a.length > 5) {
      out[a.slice(5)] = false;
      continue;
    }
    let key = a.slice(2);
    const eq = key.indexOf('=');
    if (eq >= 0) {
      const v = key.slice(eq + 1);
      key = key.slice(0, eq);
      assign(out, key, FALSY_WORDS.has(v.toLowerCase()) ? false : v);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      assign(out, key, true);
    } else {
      assign(out, key, FALSY_WORDS.has(next.toLowerCase()) ? false : next);
      i++;
    }
  }
  return out;
}

/**
 * 取字符串参数。挡住 `--bot --all` 这种漏值写法（会解析成布尔 true，
 * 直接拿去当 botId 会拼出 /api/canvas/get?botId=true 这样的荒唐请求）。
 */
export function strArg(args, key) {
  const v = args[key];
  if (Array.isArray(v)) throw usage(`--${key} 只能给一次`);
  if (v === undefined || v === false) return undefined;
  if (typeof v !== 'string' || !v.trim()) {
    throw usage(`--${key} 需要一个值，比如 --${key} <值>`);
  }
  return v.trim();
}

/**
 * 取正整数参数。挡住 `--limit --all`（Number(true)===1 会让用户以为在看全部，实际只拿到 1 条）。
 */
export function intArg(args, key, fallback, max) {
  const v = args[key];
  if (Array.isArray(v)) throw usage(`--${key} 只能给一次`);
  if (v === undefined || v === false) return fallback;
  if (typeof v === 'boolean' || !Number.isInteger(Number(v)) || Number(v) <= 0) {
    throw usage(`--${key} 需要一个正整数，收到 "${v === true ? '(空)' : v}"`);
  }
  const n = Number(v);
  return max ? Math.min(n, max) : n;
}

/** 可以给多次的参数（--input a=1 --input b=2）。没给返回空数组；给了但漏了值报用法错误。 */
export function listArg(args, key) {
  const v = args[key];
  if (v === undefined || v === false) return [];
  const list = Array.isArray(v) ? v : [v];
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) throw usage(`--${key} 需要一个值，比如 --${key} <值>`);
  }
  return list.map((item) => item.trim());
}
