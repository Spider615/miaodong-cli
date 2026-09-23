// 秒懂接口封装：只做「请求 + 把外壳拆成 md 用的形状」，不含业务判断。
// 路径与参数位置都来自仓库已接入的代码或会话实测（见 spec §11），orgId 一律放 query。

import { request } from './http.mjs';

const str = (value) => (typeof value === 'string' ? value : '');

export function asArray(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.list) ? value.list : [];
}

export async function listBots(identity, orgId) {
  const payload = await request(identity, '/api/bot/list', { query: { orgId } });
  return asArray(payload?.data)
    .map((bot) => ({ id: str(bot.id), name: str(bot.name), enabled: bot.enabled !== false }))
    .filter((bot) => bot.id);
}
