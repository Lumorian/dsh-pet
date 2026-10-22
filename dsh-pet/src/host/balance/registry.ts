/**
 * 余额服务商注册表：内置（编译期）+ 第三方（运行时）。
 * 只负责名录与查找，不含任何服务商知识（内置定义都在 ./providers/）。
 * 内置优先；第三方不得占用内置 id；重复 id 抛错；disposer 只删自己登记的那一份。
 */
import { commandCode } from './providers/commandcode';
import { deepseekAccount } from './providers/deepseek-account';
import { deepseekOfficial } from './providers/deepseek-official';
import { newApi } from './providers/newapi';
import { opencodeGo } from './providers/opencode-go';
import type { BalanceProvider, PluginProvider } from './types';

/** 内置服务商：编译期登记，顺序即优先级。 */
export const BUILTIN_PROVIDERS: BalanceProvider[] = [
  opencodeGo,
  commandCode,
  deepseekOfficial,
  deepseekAccount,
  newApi,
];

/** 内置 id + 别名（第三方注册时**一个都不许占**：否则它会在某个路由名下静默顶掉内置取数） */
function builtinIds(): string[] {
  return BUILTIN_PROVIDERS.flatMap((p) => [p.id, ...(p.aliases ?? [])]);
}

/** 第三方运行时注册：provider id → 定义。 */
const external = new Map<string, PluginProvider>();

/**
 * 注册一个第三方服务商。
 *
 * @param def - 服务商定义；`id` 必须与 agentDefaultModel 报告的 id 一致。
 * @returns 注销函数；同一 id 被重新注册后，旧注销函数不会误删新的那份。
 * @throws {TypeError} 定义不是对象、`id` 为空或 `fetch` 不是函数时。
 * @throws {Error} `id` 与内置冲突，或已被其他第三方注册时。
 */
export function registerBalanceProvider(def: PluginProvider): () => void {
  if (!def || typeof def !== 'object') throw new TypeError('provider 定义必须是对象');
  if (typeof def.id !== 'string' || def.id.length === 0) throw new TypeError('id 必须是非空字符串');
  if (typeof def.fetch !== 'function') throw new TypeError('fetch 必须是函数');
  if (builtinIds().includes(def.id)) throw new Error('不能覆盖内置服务商: ' + def.id);
  if (external.has(def.id)) throw new Error('该服务商 id 已被注册: ' + def.id);

  external.set(def.id, def);
  return () => {
    // 只在当前登记的还是自己时才删：防止迟到的一次注销把后来者顶掉
    if (external.get(def.id) === def) external.delete(def.id);
  };
}

/**
 * 现在到底有哪些 id（排障：为什么当前服务商显示「不支持」）。
 *
 * @returns `builtin` 为内置 id，`external` 为第三方已注册 id（每次调用返回新数组）。
 */
export function listBalanceProviders(): { builtin: string[]; external: string[] } {
  return { builtin: BUILTIN_PROVIDERS.map((p) => p.id), external: [...external.keys()] };
}

/**
 * provider id → 定义：先内置（含别名），再第三方；都没有 = 不支持。
 *
 * 别名只参与**命中**，不改变返回的定义 —— 结果里的 `provider` 由取数上下文原样带回，
 * 于是气泡/日志里看到的永远是 DSH 真正报告的那个 id。
 */
export function matchBalanceProvider(provider: string): BalanceProvider | PluginProvider | undefined {
  return (
    BUILTIN_PROVIDERS.find((p) => p.id === provider || (p.aliases ?? []).includes(provider)) ?? external.get(provider)
  );
}
