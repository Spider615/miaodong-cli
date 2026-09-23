// 身份 = 某个区的控制台域名 + 用户在浏览器里的登录凭证 + 能看到的企业列表。
// 不用账号密码：用户在控制台执行一行代码，把 localStorage.user 里的登录态复制到剪贴板，
// md 从剪贴板读、验证、按区存进 $MD_HOME/identities.json（0600）。
// 凭证全程不经过对话：不贴进对话框，不打印，导入后清空剪贴板。

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { matchRegionFromUrl } from '../../packages/shared/src/miaodong-regions.ts';
import { EXIT, MdError, usage } from './errors.mjs';
import { mdHome, readJson, writeJson } from './home.mjs';

export const AUTH_PREFIX = 'md-auth:';

function identitiesPath() {
  return join(mdHome(), 'identities.json');
}

export function normalizeOrigin(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw usage('缺少秒懂控制台域名', '例如：md auth snippet xlink-insight.juzibot.com');
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    throw usage(`认不出这个域名：${raw}`);
  }
}

export function regionOf(origin) {
  const region = matchRegionFromUrl(origin);
  const host = new URL(origin).host;
  return region ? { key: region.id, label: region.label } : { key: host, label: host };
}

// 在浏览器控制台执行的一行代码。只认目标域名：localStorage 按域名隔离，在别的页面执行拿到的不是秒懂登录态。
// 嵌在别的系统里（wujie）时登录态键名是 user-ai-pc。
export function buildSnippet(origin) {
  const want = JSON.stringify(origin);
  return `(()=>{try{const want=${want};if(location.origin!==want)return'❌ 当前页面是 '+location.origin+'，请打开 '+want+' 的秒懂控制台再执行';const raw=localStorage.getItem('user')||localStorage.getItem('user-ai-pc');const u=raw?JSON.parse(raw):null;if(!u||!u.token)return'❌ 没读到登录态：先在这个页面登录秒懂';const pick=o=>o&&o.id?{id:String(o.id),name:String(o.name||'')}:null;const p={v:1,origin:location.origin,token:u.token,user:{id:String(u.id||''),name:String(u.name||'')},currentOrg:pick(u.currentOrg),orgs:(Array.isArray(u.orgs)?u.orgs:[]).map(pick).filter(Boolean)};copy('${AUTH_PREFIX}'+btoa(unescape(encodeURIComponent(JSON.stringify(p)))));return'✅ 已复制身份（企业：'+(p.currentOrg?p.currentOrg.name:'未选')+'，共 '+p.orgs.length+' 个企业）。回到 AI 对话只回复「好了」，不要粘贴（里面是登录凭证）'}catch(e){return'❌ '+e.message}})()`;
}

function invalid(message, hint = '让用户在控制台重新执行 md auth snippet 给的那行代码，看到「✅ 已复制身份」后再导入') {
  return new MdError('auth_blob_invalid', message, { exitCode: EXIT.AUTH, hint });
}

export function decodeAuthBlob(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith(AUTH_PREFIX)) throw invalid('剪贴板里不是 md 的身份信息');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice(AUTH_PREFIX.length), 'base64').toString('utf-8'));
  } catch {
    throw invalid('身份信息解析失败（可能没复制完整）');
  }
  const origin = normalizeOrigin(parsed?.origin);
  const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
  if (!token) throw invalid('身份信息里没有登录凭证');
  const pick = (o) => (o && typeof o.id === 'string' && o.id ? { id: o.id, name: String(o.name ?? '') } : null);
  const currentOrg = pick(parsed.currentOrg);
  const orgs = [];
  for (const candidate of [...(Array.isArray(parsed.orgs) ? parsed.orgs : []), currentOrg]) {
    const org = pick(candidate);
    if (org && !orgs.some((o) => o.id === org.id)) orgs.push(org);
  }
  if (orgs.length === 0) throw invalid('身份信息里没有任何企业', '让用户在控制台先选中一个企业，再执行那行代码');
  return {
    origin,
    token,
    user: { id: String(parsed.user?.id ?? ''), name: String(parsed.user?.name ?? '') },
    currentOrgId: (currentOrg ?? orgs[0]).id,
    orgs,
  };
}

export function jwtExpiry(token) {
  const part = String(token).split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function loadIdentities() {
  return readJson(identitiesPath(), {}, { secret: true });
}

export function saveIdentity(identity) {
  const all = loadIdentities();
  all[identity.key] = identity;
  writeJson(identitiesPath(), all, { secret: true });
}

export function removeIdentity(key) {
  const all = loadIdentities();
  if (!all[key]) return false;
  delete all[key];
  writeJson(identitiesPath(), all, { secret: true });
  return true;
}

export function requireIdentities() {
  const list = Object.values(loadIdentities());
  if (list.length === 0) {
    throw new MdError('no_identity', '还没有任何区的身份', {
      exitCode: EXIT.AUTH,
      hint: '先问用户秒懂控制台的域名，然后 md auth snippet <域名>',
    });
  }
  return list;
}

export function readClipboard() {
  try {
    return execFileSync('pbpaste', { encoding: 'utf-8' });
  } catch {
    throw usage('读不到剪贴板（这台机器没有 pbpaste）', '改用 md auth import --stdin，再粘贴');
  }
}

export function clearClipboard() {
  try {
    execFileSync('pbcopy', { input: '' });
  } catch {
    // 非 macOS 没有 pbcopy，忽略
  }
}
