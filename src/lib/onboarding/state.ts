/**
 * 「建立我的生活」的进入标记 —— onboarding 唯一自己拥有的状态。
 *
 * 它只回答一个问题：这个浏览器有没有跟轻舍打过照面。
 * 刻意不看 qingshe_ingredients / qingshe_consumables 是否为空：
 * 用户可能早就手动录过冰箱，却依然没跟轻舍走完这一步，两件事不该互相推断。
 */

export const ONBOARDING_STATE_KEY = 'qingshe_onboarding_v1';

export type OnboardingState = 'done' | 'skipped';

const VALID_STATES: readonly string[] = ['done', 'skipped'];

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

export function readOnboardingState(): OnboardingState | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(ONBOARDING_STATE_KEY);
    // 认不出的值一律当「第一次见面」处理：标记坏了顶多重走一次，不能把用户关在门外
    return raw && VALID_STATES.includes(raw) ? (raw as OnboardingState) : null;
  } catch (e) {
    console.error('读取 onboarding 标记失败:', e);
    return null;
  }
}

/** 没有标记 = 需要建立。有 done / skipped 都不再打扰。 */
export function needsOnboarding(): boolean {
  return readOnboardingState() === null;
}

function writeOnboardingState(state: OnboardingState): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(ONBOARDING_STATE_KEY, state);
  } catch (e) {
    console.error('写入 onboarding 标记失败:', e);
  }
}

/** 欢迎页直接走人：什么都没建立，也一条生活数据都不写。 */
export function markOnboardingSkipped(): void {
  writeOnboardingState('skipped');
}

/** 走到最后一屏（中途逐项跳过也算）。 */
export function markOnboardingDone(): void {
  writeOnboardingState('done');
}