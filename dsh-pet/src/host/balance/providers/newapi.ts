/**
 * New API（provider id `newapi`，别名 `new-api` / `new_api`）—— 自建网关的账户余额（金额）。
 *
 * **端点与凭证都不写死**：new-api 是一套自建网关程序，同一份代码部署在谁的域名上、被 DSH 起名叫
 * 什么都由部署方决定（`https://api.example.com`、`https://gw.example.com/v1`…）。所以本路由的凭证
 * 模式是 `mode: 'route'` —— 端点（`baseURL`）与凭证引用名（`apiKeyEnv`）都从 DSH 自己的
 * `llm-pi-ai.providers.<id>` 路由配置里取，插件既不内置任何地址，也不猜凭证叫什么名字。
 *
 * 取数（new-api 的 OpenAI 兼容计费接口，口径见其 `controller/billing.go`）：
 * - `GET /v1/dashboard/billing/subscription` → `hard_limit_usd`：**总额度**（剩余 + 已用）；
 * - `GET /v1/dashboard/billing/usage`         → `total_usage`：**已用额度 × 100**（即「分」）；
 *   剩余 = 总额度 − 已用 ÷ 100（实测：总额度不变、已用随每次请求增长，与源码口径一致）；
 * - `GET /api/status`（公开，免鉴权）→ `quota_display_type`：站点的额度展示类型，决定上面两个
 *   数字到底是什么币种（`USD` / `CNY` / `TOKENS`）。只认前两种：按 token 计量的站点没有金额，
 *   直接报错——绝不把 token 数当金额显示。
 *
 * 展示形态与 DeepSeek 两条路由**完全一致**（`money`）：档位基准 `fullBalance` = 总额度，于是
 * 「剩余 ÷ 总额度」直接就是档位百分比，气泡是「余额 $993.85」，展示层一行都不用改。
 *
 * 为什么不走 `/api/user/self`：那条路要**用户令牌**（还要 `New-Api-User` 头），插件手上只有
 * API Key，所以只走上面两个 OpenAI 兼容计费接口。
 */
import { fetchWithRetry, num, obj } from '../internal';
import type { BalanceProvider, BalanceSuccess } from '../types';

/** 站点展示类型 → 气泡上的币种代码。不在表里 = 没有金额语义（如 TOKENS），取数直接报错 */
const DISPLAY_TYPE_CURRENCY: Record<string, string> = { USD: 'USD', CNY: 'CNY' };

/**
 * 路由端点 → 计费接口前缀（统一收敛成「根 + /v1」）。
 * 部署方可能填 `https://api.example.com`，也可能照抄 OpenAI 兼容地址 `https://api.example.com/v1`，
 * 尾部斜杠也不该让拼接出双斜杠——都在这里抹平。非 http(s) 直接抛错（不猜一个协议去试）。
 */
export function newApiBillingBase(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('dsh-pet: new-api 路由端点非法（' + baseURL + '）');
  return /\/v1$/i.test(base) ? base : base + '/v1';
}

/** 抓一次 JSON（GET + Bearer），HTTP 非 2xx 抛错；`label` 是接口路径，只进错误信息（便于自查哪一个失败） */
async function fetchJson(url: string, key: string, label: string): Promise<unknown> {
  const res = await fetchWithRetry(url, key);
  if (!res.ok) throw new Error('new-api ' + label + ' HTTP ' + res.status);
  return (await res.json()) as unknown;
}

/**
 * 三个接口的响应 → 成功结果（纯函数：网络与凭证都在外面，测试直接喂真实报文）。
 *
 * 失败口径：**必填字段缺失/非法一律抛错**（调用方落成 `fetch-error`，绝不伪造 0 余额）。
 * 余额为负照常带出（透支是真的欠钱，与 DeepSeek 同口径），不在取数层夹到 0。
 */
export function parseNewApi(
  subscriptionBody: unknown,
  usageBody: unknown,
  statusBody: unknown,
  provider: string,
): BalanceSuccess {
  // 展示类型决定币种：老版本 / 精简部署不回这个字段时按 USD（OpenAI 兼容接口的默认口径）读
  const status = obj(obj(statusBody)?.data);
  const displayType =
    typeof status?.quota_display_type === 'string' ? status.quota_display_type.trim().toUpperCase() : '';
  const currency = displayType === '' ? 'USD' : DISPLAY_TYPE_CURRENCY[displayType];
  if (currency === undefined) {
    throw new Error('dsh-pet: new-api 站点的额度展示类型不支持（' + displayType + '）');
  }

  const total = num(obj(subscriptionBody)?.hard_limit_usd, 'hard_limit_usd');
  const used = num(obj(usageBody)?.total_usage, 'total_usage') / 100;
  // 总额度为 0 = 这个 key 所属账户没有额度（或响应形态变了）：报错，不显示一个假的 0%
  if (!(total > 0)) throw new Error('dsh-pet: new-api 总额度非法（hard_limit_usd=' + total + '）');

  const remaining = (total - used).toFixed(2);
  return {
    ok: true,
    provider,
    shape: 'money',
    data: {
      wallets: [
        {
          currency,
          total: remaining,
          // new-api 不披露「赠送 / 充值」的拆分：分项字段只用于展示分项，这里与 deepseek-account
          // 「没有赠金钱包时 granted 记 0.00」同一口径——不去编一个拆不开的账。
          granted: '0.00',
          toppedUp: remaining,
          // 档位基准 = 总额度：余额 ≥ 总额度 = 未消耗，于是「剩余 ÷ 总额度」就是档位百分比
          fullBalance: total.toFixed(2),
        },
      ],
    },
  };
}

export const newApi: BalanceProvider = {
  id: 'newapi',
  // 同一套取数在各地被起成这几种常见的路由名（端点与凭证一律取自命中路由自己的配置）
  aliases: ['new-api', 'new_api'],
  credential: { mode: 'route' },
  async fetch({ key, provider, route }) {
    const baseURL = route?.baseURL;
    // queryBalance 只保证 credential.mode === 'route' 的路由拿得到 key（apiKeyEnv 已解析）；
    // 端点缺失在这里报，且把「该去哪配」写进错误信息（唯一能修的地方就是 DSH 的路由配置）
    if (typeof baseURL !== 'string' || baseURL.length === 0) {
      throw new Error('dsh-pet: new-api 缺少路由端点（在 DSH 的路由配置 providers.' + provider + '.baseURL 里填）');
    }
    const base = newApiBillingBase(baseURL);
    // 三个请求互不依赖：并发发出，免得串行等三次超时。status 在站点根上（不在 /v1 下）
    const root = /\/v1$/i.test(base) ? base.slice(0, -3) : base;
    const [status, subscription, usage] = await Promise.all([
      fetchJson(root + '/api/status', key, '/api/status'),
      fetchJson(base + '/dashboard/billing/subscription', key, '/v1/dashboard/billing/subscription'),
      fetchJson(base + '/dashboard/billing/usage', key, '/v1/dashboard/billing/usage'),
    ]);
    return parseNewApi(subscription, usage, status, provider);
  },
};
