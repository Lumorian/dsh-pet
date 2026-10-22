/**
 * New API 余额（provider id `newapi`）的契约测试。
 *
 * 三件事钉住：
 *   ① 真实报文的解析：总额度（subscription.hard_limit_usd）− 已用（usage.total_usage ÷ 100）= 剩余；
 *   ② 自建网关的接线：`credential.mode === 'route'` —— 端点与凭证名都从 DSH 路由配置读，
 *      缺路由 / 缺 apiKeyEnv / 缺凭证三种失败各报各的，且一个请求都不发；
 *   ③ 失败口径：必填字段缺失 / 非法 / 站点按 token 计量 → 一律抛错（→ fetch-error），绝不伪造 0。
 *
 * 报文照抄线上实测（`/v1/dashboard/billing/*` 与 `/api/status`），fetch 用 stub 顶替，不联网。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  findRouteProfile,
  matchBalanceProvider,
  newApiBillingBase,
  parseNewApi,
  queryBalance,
  type BalanceResult,
} from './balance/index.ts';

/** 线上实测报文（站点的 quota_display_type = USD） */
const STATUS = {
  success: true,
  data: { quota_display_type: 'USD', quota_per_unit: 500000, usd_exchange_rate: 7.3, version: '0.13.2-patch1' },
};
const SUBSCRIPTION = {
  object: 'billing_subscription',
  has_payment_method: true,
  soft_limit_usd: 36868.521728,
  hard_limit_usd: 36868.521728,
  system_hard_limit_usd: 36868.521728,
  access_until: 0,
};
const USAGE = { object: 'list', total_usage: 3587451.5218 };

/** 取成功的 newapi 数据；形状不对直接失败 */
function moneyOf(result: BalanceResult) {
  if (!result.ok || result.shape !== 'money') {
    assert.fail('期望 newapi 的成功结果，实际：' + JSON.stringify(result));
  }
  return result.data.wallets[0]!;
}

/** 极简 Response 替身：被测代码只用到 ok / status / json() */
function res(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** 装上 fetch stub（记录 URL 与 Authorization）；只按 URL 路由，不做真实网络 */
function stubFetch(handler: (url: string) => Response) {
  const calls: string[] = [];
  const auths: (string | null)[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    auths.push(new Headers(init?.headers).get('authorization'));
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
  return {
    calls,
    auths,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** 默认路由：三个接口都给线上实测报文 */
function newApiRoute(url: string): Response {
  if (url.endsWith('/api/status')) return res(STATUS);
  if (url.includes('/dashboard/billing/subscription')) return res(SUBSCRIPTION);
  if (url.includes('/dashboard/billing/usage')) return res(USAGE);
  return res({}, 404);
}

describe('newapi —— 已登记（自建网关：端点与凭证取自 DSH 路由配置）', () => {
  test('provider id 命中；凭证模式是 route（不内置地址、不猜凭证名）', () => {
    const def = matchBalanceProvider('newapi');
    assert.ok(def && 'credential' in def, '内置服务商必须带凭证声明');
    assert.equal(def.id, 'newapi');
    assert.deepEqual(def.credential, { mode: 'route' });
    assert.equal(typeof def.fetch, 'function');
  });

  test('常见别名 new-api / new_api 也能命中（同一套取数）', () => {
    assert.equal(matchBalanceProvider('new-api')?.id, 'newapi');
    assert.equal(matchBalanceProvider('new_api')?.id, 'newapi');
    assert.equal(matchBalanceProvider('newapi-plus'), undefined, '别名之外的名字不命中（→ unsupported）');
  });
});

describe('newApiBillingBase —— 端点收敛成「根 + /v1」', () => {
  test('根域名 / 带 /v1 / 带尾斜杠都收敛到同一个前缀', () => {
    assert.equal(newApiBillingBase('https://api.example.com'), 'https://api.example.com/v1');
    assert.equal(newApiBillingBase('https://api.example.com/'), 'https://api.example.com/v1');
    assert.equal(newApiBillingBase('https://api.example.com/v1'), 'https://api.example.com/v1');
    assert.equal(newApiBillingBase('https://api.example.com/v1/'), 'https://api.example.com/v1');
    assert.equal(newApiBillingBase('  https://gw.example.com  '), 'https://gw.example.com/v1');
  });

  test('非 http(s) 端点直接抛错（不猜一个协议去试）', () => {
    assert.throws(() => newApiBillingBase('api.example.com'), /路由端点非法/);
    assert.throws(() => newApiBillingBase('ftp://api.example.com'), /路由端点非法/);
  });
});

describe('parseNewApi —— 真实报文', () => {
  test('剩余 = 总额度 − 已用 ÷ 100；档位基准 = 总额度', () => {
    const w = moneyOf(parseNewApi(SUBSCRIPTION, USAGE, STATUS, 'newapi'));
    // 36868.521728 − 35874.515218 = 994.00651 → 两位小数
    assert.equal(w.currency, 'USD');
    assert.equal(w.total, '994.01');
    assert.equal(w.fullBalance, '36868.52', '基准 = 总额度 → 剩余 ÷ 总额度就是档位百分比');
    assert.equal(w.granted, '0.00', 'new-api 不披露赠送/充值拆分：不编一个拆不开的账');
    assert.equal(w.toppedUp, '994.01');
  });

  test('额度展示类型 CNY → 气泡币种跟着站点走（不做汇率换算）', () => {
    const cny = { data: { ...STATUS.data, quota_display_type: 'CNY' } };
    assert.equal(moneyOf(parseNewApi(SUBSCRIPTION, USAGE, cny, 'newapi')).currency, 'CNY');
  });

  test('站点没回 quota_display_type → 按 USD 读（OpenAI 兼容接口的默认口径）', () => {
    const w = moneyOf(parseNewApi(SUBSCRIPTION, USAGE, { data: {} }, 'newapi'));
    assert.equal(w.currency, 'USD');
  });

  test('按 token 计量的站点（TOKENS）→ 抛错，绝不把 token 数当金额', () => {
    const tokens = { data: { quota_display_type: 'TOKENS' } };
    assert.throws(() => parseNewApi(SUBSCRIPTION, USAGE, tokens, 'newapi'), /额度展示类型不支持/);
  });

  test('已用超过总额度（透支）→ 如实报负数，不夹到 0', () => {
    const w = moneyOf(parseNewApi({ hard_limit_usd: 10 }, { total_usage: 2000 }, STATUS, 'newapi'));
    assert.equal(w.total, '-10.00');
  });
});

describe('parseNewApi —— 必填缺失/非法一律抛错（绝不伪造 0）', () => {
  test('缺 hard_limit_usd / 为 0 → 抛错', () => {
    assert.throws(() => parseNewApi({}, USAGE, STATUS, 'newapi'), /非法字段 hard_limit_usd/);
    assert.throws(() => parseNewApi({ hard_limit_usd: 0 }, USAGE, STATUS, 'newapi'), /总额度非法/);
  });

  test('缺 total_usage / 非法 → 抛错', () => {
    assert.throws(() => parseNewApi(SUBSCRIPTION, {}, STATUS, 'newapi'), /非法字段 total_usage/);
    assert.throws(() => parseNewApi(SUBSCRIPTION, { total_usage: 'n/a' }, STATUS, 'newapi'), /非法字段 total_usage/);
  });

  test('响应根不是对象（如 null）→ 抛错', () => {
    assert.throws(() => parseNewApi(null, USAGE, STATUS, 'newapi'), /hard_limit_usd/);
  });
});

describe('queryBalance —— 自建网关的接线（fetch stub，不联网）', () => {
  const ROUTES = [
    {
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: { providers: { newapi: { apiKeyEnv: 'NEWAPI_API_KEY', baseURL: 'https://api.example.com' } } },
    },
  ];

  test('命中路由：端点取自路由配置、凭证名取自 apiKeyEnv，三个接口并发拉齐', async () => {
    const stub = stubFetch(newApiRoute);
    const refs: string[] = [];
    try {
      const result = await queryBalance(
        'newapi',
        async (ref) => {
          refs.push(ref);
          return 'k-123';
        },
        undefined,
        (provider) => findRouteProfile(ROUTES, provider),
      );
      assert.equal(result.ok, true);
      assert.equal(moneyOf(result).total, '994.01');
      assert.deepEqual(refs, ['NEWAPI_API_KEY'], '凭证名来自路由配置的 apiKeyEnv，不是插件写死的');
      assert.deepEqual([...stub.calls].sort(), [
        'https://api.example.com/api/status',
        'https://api.example.com/v1/dashboard/billing/subscription',
        'https://api.example.com/v1/dashboard/billing/usage',
      ]);
      assert.deepEqual([...new Set(stub.auths)], ['Bearer k-123']);
    } finally {
      stub.restore();
    }
  });

  test('路由端点写了 /v1 → 不拼出双 /v1', async () => {
    const stub = stubFetch(newApiRoute);
    try {
      await queryBalance(
        'newapi',
        async () => 'k',
        undefined,
        () => ({
          baseURL: 'https://gw.example.com/v1',
          apiKeyEnv: 'NEWAPI_API_KEY',
        }),
      );
      assert.deepEqual([...stub.calls].sort(), [
        'https://gw.example.com/api/status',
        'https://gw.example.com/v1/dashboard/billing/subscription',
        'https://gw.example.com/v1/dashboard/billing/usage',
      ]);
    } finally {
      stub.restore();
    }
  });

  test('DSH 里没有这条路由 → credential-missing，且一个请求都不发', async () => {
    const stub = stubFetch(newApiRoute);
    try {
      assert.deepEqual(
        await queryBalance(
          'newapi',
          async () => 'k',
          undefined,
          () => undefined,
        ),
        {
          ok: false,
          provider: 'newapi',
          reason: 'credential-missing',
          message: '缺少 DSH 路由配置（newapi）',
        },
      );
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });

  test('路由存在但没填 apiKeyEnv → credential-missing（提示该补哪一项）', async () => {
    const stub = stubFetch(newApiRoute);
    try {
      assert.deepEqual(
        await queryBalance(
          'newapi',
          async () => 'k',
          undefined,
          () => ({ baseURL: 'https://x.test' }),
        ),
        {
          ok: false,
          provider: 'newapi',
          reason: 'credential-missing',
          message: '路由 newapi 未配置 apiKeyEnv',
        },
      );
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });

  test('凭证库里没有该引用 → credential-missing（报出引用名）', async () => {
    const stub = stubFetch(newApiRoute);
    try {
      assert.deepEqual(
        await queryBalance(
          'newapi',
          async () => undefined,
          undefined,
          () => ({ apiKeyEnv: 'NEWAPI_API_KEY' }),
        ),
        {
          ok: false,
          provider: 'newapi',
          reason: 'credential-missing',
          message: '缺少凭证 NEWAPI_API_KEY',
        },
      );
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });

  test('没注入路由查询（旧调用方）→ credential-missing，不退化成 unsupported', async () => {
    const stub = stubFetch(newApiRoute);
    try {
      const r = await queryBalance('newapi', async () => 'k');
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.reason, 'credential-missing');
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });

  test('401 → fetch-error，错误信息带接口路径与状态码', async () => {
    const stub = stubFetch(() => res({ error: { message: 'unauthorized' } }, 401));
    try {
      const r = await queryBalance(
        'newapi',
        async () => 'k',
        undefined,
        () => ({
          apiKeyEnv: 'NEWAPI_API_KEY',
          baseURL: 'https://api.example.com',
        }),
      );
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.reason, 'fetch-error');
      assert.match(r.ok === false ? (r.message ?? '') : '', /new-api \/api\/status HTTP 401/);
    } finally {
      stub.restore();
    }
  });

  test('路由没填 baseURL → fetch-error 且提示该去哪配（不猜一个地址去试）', async () => {
    const stub = stubFetch(newApiRoute);
    try {
      const r = await queryBalance(
        'newapi',
        async () => 'k',
        undefined,
        () => ({ apiKeyEnv: 'NEWAPI_API_KEY' }),
      );
      assert.equal(r.ok === false && r.reason, 'fetch-error');
      assert.match(r.ok === false ? (r.message ?? '') : '', /缺少路由端点/);
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });
});

describe('findRouteProfile —— 从生效配置里取端点与凭证名', () => {
  const row = (name: string, config: unknown) => ({ name, config });

  test('命中 providers 字典里的那条路由', () => {
    assert.deepEqual(
      findRouteProfile(
        [row('@deepseek-ai/dsh-llm-pi-ai', { providers: { newapi: { baseURL: 'https://a.test', apiKeyEnv: 'K' } } })],
        'newapi',
      ),
      { baseURL: 'https://a.test', apiKeyEnv: 'K' },
    );
  });

  test('可热更新字段（{ get() } 包裹）也能读出来', () => {
    const live = {
      providers: { get: () => ({ newapi: { baseURL: 'https://b.test', apiKeyEnv: 'K2' } }) },
    };
    assert.deepEqual(findRouteProfile([row('@deepseek-ai/dsh-llm-pi-ai', live)], 'newapi'), {
      baseURL: 'https://b.test',
      apiKeyEnv: 'K2',
    });
  });

  test('不相干的模块行跳过；没有这条路由 → undefined', () => {
    assert.equal(findRouteProfile([row('@deepseek-ai/dsh-pet', { providers: {} })], 'newapi'), undefined);
    assert.equal(findRouteProfile([row('@deepseek-ai/dsh-llm-pi-ai', { providers: {} })], 'newapi'), undefined);
    assert.equal(findRouteProfile([], 'newapi'), undefined);
  });

  test('空白串按「没配」处理（不拼出半截地址）；只有一半字段也照样命中', () => {
    const rows = [row('@deepseek-ai/dsh-llm-pi-ai', { providers: { newapi: { baseURL: '  ', apiKeyEnv: ' K ' } } })];
    assert.deepEqual(findRouteProfile(rows, 'newapi'), { apiKeyEnv: 'K' });
  });

  test('前一行说了算（顺序即优先级）', () => {
    const rows = [
      row('@deepseek-ai/dsh-llm-pi-ai', { providers: { newapi: { baseURL: 'https://first.test' } } }),
      row('@deepseek-ai/dsh-llm-pi-ai', { providers: { newapi: { baseURL: 'https://second.test' } } }),
    ];
    assert.equal(findRouteProfile(rows, 'newapi')?.baseURL, 'https://first.test');
  });
});
