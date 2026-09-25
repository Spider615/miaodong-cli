// 秒懂 12 区 + 独立部署域名映射表（前后端共享）。
//
// 用途：
//   - 前端下拉选区域时展示标签 + 辅助信息
//   - 用户粘贴 URL 时反推区域
//   - 后端拼接 API 请求时取 baseUrl
//
// 放在 packages/shared 让前后端 deep-relative import 同一份，避免两边各维护一份漂移。

export type MiaodongRegion = {
  /** 区域标识（'A'~'Z' + 独立部署标识） */
  id: string;
  /** 展示标签 */
  label: string;
  /** 该区域的秒懂 base URL（不带 /api 后缀，client 统一拼） */
  baseUrl: string;
};

export const MIAODONG_REGIONS: MiaodongRegion[] = [
  // 用户面只展示区号（如「A区」）；云厂商 / 运维商（锘崴 / 数智 / 验飞 / 句子等）属内部信息，
  // 不再混进 label 干扰用户选择——拿不准用哪区时主推「粘贴秒懂网址自动匹配」。
  { id: 'A', label: 'A区', baseUrl: 'https://insight.juzibot.com' },
  { id: 'B', label: 'B区', baseUrl: 'https://lighthouse-insight.juzibot.com' },
  { id: 'C', label: 'C区', baseUrl: 'https://echo-insight.juzibot.com' },
  { id: 'D', label: 'D区', baseUrl: 'https://lantern-insight.juzibot.com' },
  { id: 'E', label: 'E区', baseUrl: 'https://horizon-insight.juzibot.com' },
  // F区：旧域名 af-insight.ddregion.com 已 301 永久重定向到 grove-insight，
  // 而 301 会把登录的 POST 降级成 GET 并丢 body（报 Cannot GET /user/login/email-password），
  // 所以必须直连新域名，不能用会触发跳转的旧域名。
  { id: 'F', label: 'F区', baseUrl: 'https://grove-insight.juzibot.com' },
  { id: 'G', label: 'G区', baseUrl: 'https://fireside-insight.juzibot.com' },
  { id: 'H', label: 'H区', baseUrl: 'https://glimmer-insight.juzibot.com' },
  { id: 'I', label: 'I区', baseUrl: 'https://stride-md.dpclouds.com' },
  { id: 'J', label: 'J区', baseUrl: 'https://journey-insight.juzibot.com' },
  // X区 / J区：曾经配成 willow-hi / journey-hi，那两个是前端站点，
  // POST /api/user/login/email-password 返回 HTML 404，登录必失败。
  // 2026-08-18 实测：秒懂的 API 一律在 *-insight 这一族域名上（返回
  // 201 {"code":-1,"message":"invalid credentials"} 才是打到了登录接口）。
  // ⚠️ 别拿用户给的控制台地址当 baseUrl：ivy-bg.ddregion.com 是小桔/秒回的后台
  // （前端 bundle 是 xiaoju-new-pc，秒懂只是它跳转过去的另一个服务），
  // 它的 /api 下面没有秒懂的登录路由。
  { id: 'X', label: 'X区', baseUrl: 'https://willow-insight.juzibot.com' },
  { id: 'Z', label: 'Z区', baseUrl: 'https://az-insight.juzibot.com' },
  { id: 'liangzi', label: '量子之歌（独立部署）', baseUrl: 'https://inkwell-insight.juzibot.com' },
  { id: 'youzan', label: '有赞（独立部署）', baseUrl: 'https://petal-insight.juzibot.com' },
  { id: 'netease', label: '网易（独立部署）', baseUrl: 'https://cloudweave-insight.juzibot.com' },
  { id: 'xingqudao', label: '兴趣岛（独立部署）', baseUrl: 'https://xlink-insight.juzibot.com' },
];

/**
 * 从用户粘贴的秒懂 URL 反推区域。
 * 提取 host → 在映射表中匹配 → 匹配不到返回 null。
 */
export function matchRegionFromUrl(rawUrl: string): MiaodongRegion | null {
  let host: string;
  try {
    host = new URL(rawUrl.trim().startsWith('http') ? rawUrl.trim() : `https://${rawUrl.trim()}`).host;
  } catch {
    return null;
  }
  return MIAODONG_REGIONS.find((r) => {
    try {
      return new URL(r.baseUrl).host === host;
    } catch {
      return false;
    }
  }) ?? null;
}

/**
 * 根据区域 id 获取 baseUrl。
 * 如果 regionId 不在映射表中，当作自定义 baseUrl 原样返回。
 */
export function resolveBaseUrl(regionId: string, customBaseUrl?: string): string {
  const region = MIAODONG_REGIONS.find((r) => r.id === regionId);
  if (region) return region.baseUrl;
  if (customBaseUrl?.trim()) return customBaseUrl.trim().replace(/\/+$/, '');
  throw new Error(`未知区域 ${regionId} 且没有提供自定义 baseUrl`);
}
