/**
 * Qingshe 产品级 Thinking Task 系统。
 *
 * 重要：这不是 AI Chain of Thought，也不是 AI 内部推理展示。
 * 这是轻舍产品层根据当前任务类型推断「正在做什么」，
 * 用于在用户等待 AI 响应时给出有节奏的视觉反馈。
 *
 * 规则：
 * - 不展示给模型 / 不发给 AI / 不写进 ChatMessage / 不写进 localStorage。
 * - 仅前端 UI 状态。
 */

export type ThinkingScenario = 'food_query' | 'record' | 'general' | 'consumable';

export interface ThinkingTask {
  /** 用于 React key */
  id: string;
  /** 用户可见文案 */
  label: string;
  /** 单步展示时长（ms）。实际使用时会根据整体节奏在区间内浮动 */
  duration?: number;
}

interface ThinkingFlow {
  scenario: ThinkingScenario;
  tasks: ThinkingTask[];
}

// 轻量确定性分类：基于用户输入文本与现有 draft 状态，
// 不发起第二次 AI 请求。
const RECORD_KEYWORDS = [
  '买了',
  '买',
  '放入',
  '放冰箱',
  '放进',
  '新增',
  '记录',
  '刚买',
  '收了一',
  '采购了',
  '囤了',
  '到了',
  '登记'
];

const FOOD_QUERY_KEYWORDS = [
  '吃什么',
  '晚饭',
  '午餐',
  '早餐',
  '宵夜',
  '今晚',
  '明天吃',
  '能做什么',
  '可以做什么',
  '能做啥',
  '做啥',
  '想吃点',
  '做点',
  '煮什么',
  '做些什么',
  '还有啥',
  '能吃啥',
  '给我做',
  '帮我做',
  '推荐',
  '菜单',
  '菜谱'
];

export function classifyThinkingScenario(
  userText: string,
  hasActiveRecordDraft: boolean
): ThinkingScenario {
  const text = userText.trim();
  if (!text) return 'general';
  if (hasActiveRecordDraft) return 'record';

  if (RECORD_KEYWORDS.some((k) => text.includes(k))) {
    return 'record';
  }
  // 消耗品场景：面巾纸、洗衣液、生抽等 + 买了
  const consumableKeywords = ['面巾纸','纸巾','卫生纸','洗衣液','洗洁精','垃圾袋','牙膏','洗发水','沐浴露','生抽','老抽','蚝油','味精','食用油'];
  if (consumableKeywords.some((k) => text.includes(k)) && text.includes('买')) {
    return 'consumable';
  }
  if (FOOD_QUERY_KEYWORDS.some((k) => text.includes(k))) {
    return 'food_query';
  }
  return 'general';
}

const FLOWS: Record<ThinkingScenario, ThinkingFlow> = {
  food_query: {
    scenario: 'food_query',
    tasks: [
      { id: 'understand', label: '小青正在看看你的问题' },
      { id: 'check_fridge', label: '小青正在翻一翻你的厨房' },
      { id: 'check_status', label: '小青正在查看食材状态' },
      { id: 'browse_recipes', label: '小青正在翻阅轻舍菜谱' },
      { id: 'compose', label: '小青正在整理可行方案' }
    ]
  },
  record: {
    scenario: 'record',
    tasks: [
      { id: 'understand', label: '小青正在理解你的记录' },
      { id: 'organize', label: '小青正在整理食材信息' },
      { id: 'confirm', label: '小青正在确认需要记录的内容' }
    ]
  },
  consumable: {
    scenario: 'consumable',
    tasks: [
      { id: 'identify', label: '小青正在识别你记录的消耗品' },
      { id: 'organize', label: '小青正在整理存放和使用信息' },
      { id: 'confirm', label: '小青正在确认需要的信息' }
    ]
  },
  general: {
    scenario: 'general',
    tasks: [
      { id: 'understand', label: '小青正在看看你的问题' },
      { id: 'search', label: '小青正在查找相关生活方案' },
      { id: 'compose', label: '小青正在整理建议' }
    ]
  }
};

export function getThinkingTasks(
  scenario: ThinkingScenario
): ThinkingTask[] {
  return FLOWS[scenario].tasks;
}