/**
 * dsh-pet desktop helper —— 窗口余量（主进程侧口径，与 src/shared/window.ts 同算一份数）。
 *
 * 为什么需要「收紧档」（用户报的"蓝色方块内的区域都算点在桌宠上"）：
 *   宠物窗口 = 宠物包围盒 + 四周余量（给气泡/菜单/对话留地方）。size 462 时窗口 924×744，
 *   宠物本身只占 462×260，其余全是透明余量。平时靠「整窗点击穿透」把点击让给下层应用，但
 *   **原生 Wayland 上那条通道整条不存在**（实测 + 源码）：
 *     · NativeWindowViews::SetIgnoreMouseEvents 在 Linux 只有 `x11_util::IsX11()` 分支，Wayland 静默空操作；
 *     · screen.getCursorScreenPoint() 在 Wayland 下不可用（Electron 文档），光标兜底通道同样失效；
 *     · setShape 在 E43 + niri 下既不影响输入也不影响绘制。
 *   结论：这种环境里只能把窗口本身收到宠物身上 —— 点哪里就是点哪里。
 *   宽档（Windows/macOS/X11）逐位不变，那里有真正的穿透，余量不产生死区。
 *
 * 本文件不 require('electron')，可被 node:test 直接加载；两端口径一致性由
 * src/host/pointer-target.test.ts 的对照表钉住（改数必须两边同步）。
 */

'use strict';

/** 收紧档保留的内边距（px），与 shared/window.ts 的 MIN_TIGHT_PAD_PX 同值（12 → 2：见该处注释） */
const MIN_TIGHT_PAD_PX = 2;

/**
 * 本会话是否需要收紧窗口（= 没有整窗点击穿透能力）。
 *
 * 判定口径（保守优先，只把**明确**的原生 Wayland 判为收紧）：
 *   - 非 linux → 不收紧（win32/darwin 有真正的穿透）；
 *   - 有 WAYLAND_DISPLAY 且会话类型不是 x11 → 收紧（XWayland 下 DISPLAY 也在，不能拿它反证）；
 *   - DSH_PET_TIGHT_WINDOW=0/1 强制关/开（排障逃生口）。
 *
 * @param {{platform?: string, env?: Record<string, string|undefined>}} [o]
 * @returns {boolean}
 */
function needsTightWindow(o = {}) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env || {};
  const force = env.DSH_PET_TIGHT_WINDOW;
  if (force === '0') return false;
  if (force === '1') return true;
  if (platform !== 'linux') return false;
  if (!env.WAYLAND_DISPLAY) return false;
  return (env.XDG_SESSION_TYPE || '').toLowerCase() !== 'x11';
}

/**
 * 本会话是否使用「收纳窗」（窗口永不点击穿透，见 main.js 的 STICKY_WINDOW）。
 *
 * 三层优先级：环境变量 DSH_PET_STICKY（'0'/'1'）> 默认值。默认值由调用方按档位给：
 * 收紧档 true（窗口贴着宠物，可点区就是宠物本体）、宽档 false（有余量，常驻可点会挡下层应用）。
 * 纯函数：不读 Electron，可被 node:test 直接覆盖。
 *
 * @param {{env?: Record<string,string|undefined>, tight?: boolean}} [o]
 * @returns {boolean}
 */
function resolveStickyWindow(o = {}) {
  const env = o.env || process.env || {};
  const raw = String(env.DSH_PET_STICKY ?? '').trim();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  return o.tight === true;
}

/**
 * 窗口余量（与 src/shared/window.ts 的 windowMargins 同一份算法）。
 *
 * @param {number} size 宠物包围盒宽度
 * @param {number} bubbleTop 气泡所需上边距（fonts.ts 的 bubbleTopMarginPx）
 * @param {boolean} [tight] 收紧档
 * @param {'base'|'bubble'|'expand'} [mode] 占用情形
 * @returns {{t:number, r:number, b:number, l:number}}
 */
function windowMargins(size, bubbleTop, tight, mode) {
  const s = Number(size) || 0;
  const bubble = Number(bubbleTop) || 0;
  const wide = s * 0.5;
  if (!tight || mode === 'expand') return { t: Math.max(wide, bubble), r: wide, b: wide, l: wide };
  const pad = MIN_TIGHT_PAD_PX;
  if (mode === 'bubble') return { t: Math.max(pad, bubble), r: pad, b: pad, l: pad };
  return { t: pad, r: pad, b: pad, l: pad };
}

module.exports = { MIN_TIGHT_PAD_PX, needsTightWindow, resolveStickyWindow, windowMargins };
