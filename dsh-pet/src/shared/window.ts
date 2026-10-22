// 宠物窗口的「余量」模型：窗口 = 宠物包围盒 + 四周余量。
//
// 余量的用途是给气泡/右键菜单/对话弹窗留地方，代价是**这块透明区域在没有点击穿透能力的环境里会
// 吞掉鼠标**——原生 Wayland 就是这种环境（实测：Electron 43 的 setIgnoreMouseEvents 在 Linux 只有
// X11 分支，Wayland 下静默空操作；同时 screen.getCursorScreenPoint() 在 Wayland 下不可用，主进程
// 的光标兜底通道也一起失效；setShape 既不影响输入也不影响绘制）。size 462 时窗口 924×744，
// 宠物只占 462×260 —— 其余全是"看不见的桌宠"（用户报的"蓝色方块内的区域都算点在桌宠上"）。
//
// 所以余量分两档：
//   - 宽档（默认，其它平台）：左右下 = 0.5×size，上 = max(0.5×size, 气泡最大高度)。这就是改造前的
//     原值，Windows/macOS/X11 行为逐位不变（那里有真正的整窗穿透，余量不产生死区）；
//   - 收紧档（原生 Wayland）：默认四周只留 MIN_TIGHT_PAD_PX —— 窗口贴着宠物本体；
//     只在**真有东西要显示**时才撑开：气泡 → 撑上边；菜单/对话 → 整圈撑回宽档。
//
// 本模块是余量口径的**唯一**来源：桌面渲染端（shared-core 的 windowMargins）与主进程的
// runtime/electron-helper/window-margin.js 必须同算一份数（守卫测试逐项对照）。

/** 宽档外扩比例（相对宠物尺寸） */
export const WINDOW_MARGIN_RATIO = 0.5;

/** 收紧档保留的内边距（px）：够放悬浮提示与拖拽反馈，又不会重新变成"隐形墙" */
export const MIN_TIGHT_PAD_PX = 12;

/** 余量的三种占用情形：常态 / 有气泡 / 菜单或对话弹窗开着 */
export type WindowMarginMode = 'base' | 'bubble' | 'expand';

export interface WindowMargins {
  /** 上边距 */
  t: number;
  /** 右边距 */
  r: number;
  /** 下边距 */
  b: number;
  /** 左边距 */
  l: number;
}

/**
 * 算窗口余量。
 *
 * @param size 宠物包围盒宽度（px）
 * @param bubbleTopMargin 气泡所需上边距（fonts.ts 的 bubbleTopMarginPx）
 * @param tight 是否收紧档（原生 Wayland 等没有整窗穿透能力的平台）
 * @param mode 占用情形；宽档下三种情形结果相同（余量本来就够用）
 */
export function windowMargins(
  size: number,
  bubbleTopMargin: number,
  tight = false,
  mode: WindowMarginMode = 'base',
): WindowMargins {
  const s = Number(size) || 0;
  const bubble = Number(bubbleTopMargin) || 0;
  const wide = s * WINDOW_MARGIN_RATIO;
  // 宽档：左右下 0.5×size，上边距至少装得下气泡（四边因此不再相等，主进程算命中区必须用上报的
  // marginL/marginT，不能按「窗口宽/4」反推 —— 见 pointer-target.js 的 spriteHitRect）
  if (!tight || mode === 'expand') return { t: Math.max(wide, bubble), r: wide, b: wide, l: wide };
  // 收紧档 + 气泡：只把上边撑到气泡高度，左右下仍贴着宠物（气泡悬在头顶，不需要整圈空间）
  if (mode === 'bubble') {
    const pad = MIN_TIGHT_PAD_PX;
    return { t: Math.max(pad, bubble), r: pad, b: pad, l: pad };
  }
  const pad = MIN_TIGHT_PAD_PX;
  return { t: pad, r: pad, b: pad, l: pad };
}
