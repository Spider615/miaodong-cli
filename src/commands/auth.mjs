import { EXIT, usage } from '../errors.mjs';
import { request } from '../http.mjs';
import {
  buildSnippet, clearClipboard, decodeAuthBlob, jwtExpiry, loadIdentities,
  normalizeOrigin, readClipboard, regionOf, removeIdentity, saveIdentity,
} from '../identity.mjs';
import { formatTime, out } from '../output.mjs';

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function snippet(domain) {
  const origin = normalizeOrigin(domain);
  const region = regionOf(origin);
  out(`【取身份】${region.label}（${origin}），约 30 秒：`);
  out(`1. 在浏览器打开 ${origin} 并登录，选好企业（任意页面都行）。`);
  out('2. 打开浏览器控制台：Mac 按 Cmd+Option+J，Windows 按 F12，切到「Console / 控制台」。');
  out('   第一次粘贴被拦时，按提示输入 allow pasting 回车。');
  out('3. 粘贴下面这一整行，回车：');
  out('');
  out(buildSnippet(origin));
  out('');
  out('4. 看到「✅ 已复制身份」后，回到对话说「好了」。');
  out('');
  out('说明：身份只在你的剪贴板和本机 ~/.miaodong/md 里，不会出现在对话中；导入后剪贴板会被清空。');
  return EXIT.OK;
}

async function importIdentity(args) {
  const text = args.stdin ? await readStdin() : readClipboard();
  const blob = decodeAuthBlob(text);
  const region = regionOf(blob.origin);
  const identity = {
    key: region.key,
    label: region.label,
    origin: blob.origin,
    token: blob.token,
    user: blob.user,
    orgs: blob.orgs,
    currentOrgId: blob.currentOrgId,
    savedAt: new Date().toISOString(),
    expiresAt: jwtExpiry(blob.token),
  };
  // 先用一次只读调用验证，验证不过就不落盘
  await request(identity, '/api/bot/list', { query: { orgId: identity.currentOrgId } });
  saveIdentity(identity);
  if (!args.stdin) clearClipboard();
  const org = identity.orgs.find((o) => o.id === identity.currentOrgId);
  const expiry = identity.expiresAt ? ` · 有效期至 ${formatTime(identity.expiresAt)}` : '';
  out(`✅ 已保存：${identity.label} · ${org?.name || identity.currentOrgId} · ${identity.user.name || '（未知用户）'}${expiry}`);
  out(`   可用企业 ${identity.orgs.length} 个：${identity.orgs.map((o) => o.name || o.id.slice(0, 8)).join('、')}`);
  return EXIT.OK;
}

function list() {
  const all = Object.values(loadIdentities());
  if (all.length === 0) {
    out('还没有任何区的身份。先 md auth snippet <秒懂控制台域名>');
    return EXIT.OK;
  }
  out('区 | 域名 | 用户 | 企业数 | 当前企业 | 有效期至 | 取于');
  for (const identity of all) {
    const current = identity.orgs.find((o) => o.id === identity.currentOrgId);
    out([
      `${identity.label}（${identity.key}）`, identity.origin, identity.user?.name || '-', identity.orgs.length,
      current?.name || '-', identity.expiresAt ? formatTime(identity.expiresAt) : '未写明', formatTime(identity.savedAt),
    ].join(' | '));
  }
  return EXIT.OK;
}

function remove(key) {
  if (!key) throw usage('用法：md auth remove <区>', '先 md auth list 看区的名字');
  out(removeIdentity(key) ? `已删除 ${key} 的身份` : `没有 ${key} 的身份`);
  return EXIT.OK;
}

export const auth = {
  summary: '取 / 看 / 删 秒懂身份（按区）',
  usage: [
    'md auth snippet <域名>     生成让用户在浏览器控制台执行的一行代码（原样转给用户）',
    'md auth import [--stdin]   从剪贴板导入身份（--stdin 从标准输入读）',
    'md auth list               已保存身份的区',
    'md auth remove <区>        删除某个区的身份',
  ].join('\n'),
  async run(args) {
    const [sub, value] = args._;
    if (sub === 'snippet') return snippet(value);
    if (sub === 'import') return importIdentity(args);
    if (sub === 'list') return list();
    if (sub === 'remove') return remove(value);
    throw usage('用法：md auth snippet|import|list|remove', 'md auth --help');
  },
};
