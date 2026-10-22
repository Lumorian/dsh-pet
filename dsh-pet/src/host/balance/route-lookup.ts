/**
 * 路由配置查询（host 侧，纯逻辑）：把「DSH 里这条 provider 路由是怎么配的」取出来给余额取数用。
 *
 * 为什么需要它：有些服务商是**自建网关**（典型是 new-api / one-api 这类程序）——同一个程序部署在
 * 谁的域名上、被 DSH 起成什么名字都由部署方决定。那样的服务商不能内置地址，也不能猜凭证叫什么，
 * 只能回到 DSH 自己的路由配置里读 `baseURL` 与 `apiKeyEnv`（`credential.mode === 'route'`）。
 *
 * 本模块只做「一堆配置行 → 某条路由的端点与凭证名」这一件事，不碰网络、不碰 ctx：
 * 调用方（index.ts）负责把 `configEditor.configuration()` 摊成 `RouteRow[]` 传进来，测试直接喂数组。
 *
 * 为什么不用 `ctx.settings.get('llm-pi-ai')`：那是**宿主版本相关**的便捷读法（当前 DSH 的
 * `ctx.settings` 只有 describe/update，没有按命名空间取值的 `get`）。`configEditor` 是 base bundle
 * 自带的稳定服务，返回的就是**已叠加各层 patch 后的生效配置**，与本插件 inject 里的服务同一来源。
 */

/** 一条已生效的插件配置行（`configEditor.configuration()` 的投影） */
export interface RouteRow {
  /** 模块名（如 `@deepseek-ai/dsh-llm-pi-ai`）；用来挑出承载 provider 路由的那一行 */
  name?: string;
  /** 该行**合并后**的配置（含 providers 字典） */
  config?: unknown;
}

/** 一条 provider 路由里余额取数要用的两件事 */
export interface RouteProfile {
  /** 路由端点（apiKeyEnv 之外唯一需要的字段） */
  baseURL?: string;
  /** 凭证引用名（DSH credentialRef）：由调用方经 `ctx.credentials.resolve` 解析 */
  apiKeyEnv?: string;
}

/** 承载 provider 路由的模块名片段（pi-ai 适配器：`providers` 字典就挂在它的配置上） */
const ROUTE_MODULE = 'llm-pi-ai';

/** 取一层 Volatile 包裹的实值：Cordis 的可热更新字段是 `{ get() }`，普通配置原样返回 */
function unwrap(value: unknown): unknown {
  let cur = value;
  // 只解一层套一层地解到非 Volatile 为止；上限防止病态的自引用结构把这里挂死
  for (let i = 0; i < 8; i++) {
    if (cur === null || typeof cur !== 'object') return cur;
    const get = (cur as { get?: unknown }).get;
    if (typeof get !== 'function') return cur;
    cur = (get as () => unknown).call(cur);
  }
  return cur;
}

/**
 * 取**自身属性**：对象才取，数组/空值一律 undefined（配置是外部数据，不信任形状）。
 * 用 `hasOwnProperty.call` 而不是 `Object.hasOwn`/直接取值：后者会让 `__proto__`、`constructor`
 * 这类段读到原型链上的继承值（tsconfig 的 lib 也停在 ES2020，没有 `Object.hasOwn`）。
 */
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** 非空字符串才算给了值（空白串按「没配」处理，免得拼出 `/v1` 式的半截地址去发请求） */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 在一堆配置行里找某条 provider 路由的端点与凭证名。
 *
 * @param rows - 已生效的配置行（顺序即优先级：先命中的行说了算）
 * @param provider - DSH 报告的 provider id（= `providers` 字典的键）
 * @returns `{ baseURL?, apiKeyEnv? }`；这条路由不存在于任何一行 → undefined
 */
export function findRouteProfile(rows: readonly RouteRow[], provider: string): RouteProfile | undefined {
  for (const row of rows) {
    if (typeof row?.name !== 'string' || !row.name.includes(ROUTE_MODULE)) continue;
    const providers = unwrap(own(unwrap(row.config), 'providers'));
    const profile = own(providers, provider);
    if (profile === undefined || profile === null) continue;
    const baseURL = text(own(unwrap(profile), 'baseURL'));
    const apiKeyEnv = text(own(unwrap(profile), 'apiKeyEnv'));
    // 命中了路由名就算命中（哪怕两个字段都没配）：调用方据此区分「这条路由配得不全」与「压根没这条路由」
    return { ...(baseURL === undefined ? {} : { baseURL }), ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }) };
  }
  return undefined;
}
