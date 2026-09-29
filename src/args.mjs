// 参数解析（从 lib/credentials.mjs 搬来，旧文件 re-export，两边共用一份）。

import { usage } from './errors.mjs';

/** 开关的「关」。写 `--replace-draft false` 的人显然不想开。 */
const FALSY_WORDS = new Set(['false', '0', 'no', 'off', 'n']);
const TRUTHY_WORDS = new Set(['true', 'yes', 'y', 'on', '1']);
export const boolWord = (v) => (TRUTHY_WORDS.has(v.toLowerCase()) ? true : FALSY_WORDS.has(v.toLowerCase()) ? false : undefined);

/**
 * 纯开关：从不带值。解析时就得知道——`--vs-draft abc123` 里的 abc123 是位置参数，不是开关的值；
 * 以前一律把后面的词当值，md exec --vs-draft <执行 id> 的 id 被吞掉，报成「缺 --bot」。
 * 开关后面紧跟 true / false / yes / no / on / off / 1 / 0 / y / n 时才当它的值。
 * 代码里按开关读（boolArg）的参数都要登记在这里，test/args.test.mjs 扫源码对账。
 */
export const BOOLEAN_FLAGS = new Set([
  'allow-check-errors', 'allow-plugin', 'allow-preflight-errors', 'base', 'canary', 'deep', 'down', 'failed', 'help', 'into',
  'keep-platform-params', 'local', 'onto-draft', 'refresh', 'remote', 'replace-draft', 'reset', 'skip-rebuild', 'stdin', 'up', 'vs-draft', 'wait',
]);

/**
 * 在一些命令里是开关、在别的命令里要带值：md diff --json 是开关，md apply --json <文件> 带文件路径；
 * md --version 看 md 版本，md pull --version <版本号> 带秒懂版本号。只能按带值解析，当开关用时写在最后或写成 --json=true。
 */
export const DUAL_FLAGS = new Set(['json', 'version']);

// 同一个参数给了多次就收成数组：--input 这类要给多个；只该给一次的（--bot / --limit …）由 strArg / intArg 报错。
// 以前是悄悄取最后一个——`--bot 甲 --bot 乙` 会静默落到乙上
function assign(out, key, value) {
  if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
  else if (Array.isArray(out[key])) out[key].push(value);
  else out[key] = [out[key], value];
}

/**
 * 解析命令行参数。支持：
 *   --key value     → { key: 'value' }     （值原样是字符串，0 / no / false 也一样）
 *   --key=value     → { key: 'value' }
 *   --key           → { key: true }        （后面没值，或紧跟另一个 --flag）
 *   --no-key        → { key: false }
 *   --开关 [真假词]  → { 开关: true / false }（BOOLEAN_FLAGS 里的，后面不是真假词就不吃它）
 *
 * ⚠️ 开关的布尔语义在解析层就定死：这里的开关有 `--replace-draft` 这种会整份替换草稿的，
 * `--replace-draft false` 必须是 false，不能是字符串 "false"（truthy）。
 * 带值参数不做这个转换：以前一律把单独的 0 / no / n / off / false 当成「关」，
 * `--keyword 0`、`--per-command 0`（每次都拦）都被当成没给。`--confirm false` 由 givenCode 当成没给。
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
    const flag = () => BOOLEAN_FLAGS.has(key);
    const eq = key.indexOf('=');
    if (eq >= 0) {
      const v = key.slice(eq + 1);
      key = key.slice(0, eq);
      assign(out, key, flag() ? boolWord(v) ?? v : v);
      continue;
    }
    const next = argv[i + 1];
    if (flag()) {
      const word = next === undefined ? undefined : boolWord(next);
      assign(out, key, word ?? true);
      if (word !== undefined) i++;
    } else if (next === undefined || next.startsWith('--')) {
      assign(out, key, true);
    } else {
      assign(out, key, next);
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
 * 取开关参数。给了两次报用法错误，不按真值算：`--replace-draft false` 给两次会被收成 [false, false]，
 * 数组是真值——以前就这样被当成「开」，而 --replace-draft 会整份替换草稿（审查 I4）。
 * 带了认不出的值也报错：多半是它后面的词被当成了它的值。
 */
export function boolArg(args, key) {
  const v = args[key];
  if (Array.isArray(v)) throw usage(`--${key} 只能给一次`);
  if (v === undefined || v === false) return false;
  if (v === true) return true;
  // DUAL_FLAGS 按带值解析，--json false 到这里还是字符串
  if (typeof v === 'string' && boolWord(v) !== undefined) return boolWord(v);
  throw usage(`--${key} 是开关，不带值（收到「${v}」）`, '它后面的词被当成了它的值？把开关挪到最后，或写成 --' + key + '=true');
}

/**
 * 取正整数参数。挡住 `--limit --all`（Number(true)===1 会让用户以为在看全部，实际只拿到 1 条）。
 * 超过上限报错：以前悄悄截成上限，--times 50 实际只跑 10 次、用户以为跑了 50 次。
 */
export function intArg(args, key, fallback, max) {
  const v = args[key];
  if (Array.isArray(v)) throw usage(`--${key} 只能给一次`);
  if (v === undefined || v === false) return fallback;
  if (typeof v === 'boolean' || !Number.isInteger(Number(v)) || Number(v) <= 0) {
    throw usage(`--${key} 需要一个正整数，收到 "${v === true ? '(空)' : v}"`);
  }
  const n = Number(v);
  if (max && n > max) throw usage(`--${key} 最多 ${max}，收到 ${n}`);
  return n;
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
