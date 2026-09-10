import { IngredientRecordDraft } from '@/lib/ai/record';
import type {
  AITaskType,
  ActiveTaskSnapshot,
  CardCommand,
  ConsumableDraft,
  ConsumableSessionPhase,
  ConsumableStatusUpdate,
  ShoppingItemDraft
} from '@/lib/ai/tasks';

export interface RecommendedRecipe {
  recipeId: string;
  title: string;
  description?: string;
  estimatedTime?: string | number;
  difficulty?: string;
  availableIngredients: string[];
  missingIngredients: string[];
  urgentIngredientsUsed: string[];
  matchScore: number;
  sourceType: 'official' | 'user';
}

/**
 * 采购完成 → 入库确认的锚点：一条清单条目对应一行冰箱草稿。
 *
 * 草稿只描述食材（name / quantity / purchaseDate），认不出「我是哪一次采购」，
 * 因此把 listId + itemId 单独带在消息上：写入成功后按它给清单条目打 restockedAt，
 * 已入库的条目从此不再出第二张卡（幂等锚点归 ShoppingListItem 自己）。
 */
export interface RestockAnchor {
  listId: string;
  itemId: string;
  name: string;
}

export type ChatMessageStatus = 'pending' | 'completed' | 'failed';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  intent?: string;
  recipeMatches?: RecommendedRecipe[];
  /**
   * 用于把用户消息与其对应的 AI 回复精确关联。
   * 旧消息没有此字段时视为已完成。
   */
  requestId?: string;
  /**
   * 消息状态。仅 assistant 的 pending 状态会在 UI 显示 placeholder。
   * 旧消息没有此字段时视为 completed。
   */
  status?: ChatMessageStatus;
  /**
   * AI Task Foundation：当前 assistant 消息是否携带可执行的 Task。
   * - taskType = 'add_shopping_item' 时，shoppingDrafts 提供待确认草稿。
   * - taskType = 'add_consumable' 时，consumableDrafts 提供待确认草稿。
   * - taskType = 'chat' 或未设置时，无 Task（不展示确认卡片）。
   * - 旧消息没有此字段视为 chat。
   */
  taskType?: AITaskType;
  shoppingDrafts?: ShoppingItemDraft[];
  consumableDrafts?: ConsumableDraft[];
  /**
   * 当前 consumable 任务的对话阶段：
   * - 'collecting'：仍在多轮收集信息（位置 / 用完时间）
   * - 'confirming'：草稿已收齐，等待用户最终确认
   *
   * 仅 taskType === 'add_consumable' 生效。
   * 旧消息没有此字段视为 'confirming'（草稿已就绪）。
   */
  consumablePhase?: ConsumableSessionPhase;
  /**
   * update_consumable_status 的回写指令（requiresConfirmation = false）。
   * 前端应用后立即写 qingshe_consumables，并用于渲染「建议补货」卡片。
   */
  consumableUpdates?: ConsumableStatusUpdate[];
  /**
   * 食材确认卡（Phase B1）：confirming 草稿挂在产生它的那条 assistant 消息上，
   * 与 shoppingDrafts / consumableDrafts 同构。
   *
   * 全局 currentDraft 从此只承担 collecting 的跨轮补字段，
   * 因此卡片不会跟随页面底部，也不会被下一条任务的草稿覆盖。
   */
  ingredientDraft?: IngredientRecordDraft;
  /**
   * P0.5-1 批量冰箱录入：一句话多项食材时整组挂在这条 assistant 消息上，
   * 渲染成一张多行确认卡。每行的确认 / 移除仍复用单条 ingredientDraft 的
   * SAVE_INGREDIENT 链路 —— 批量只是卡的形状，不是第二套状态机。
   * 旧消息没有此字段：单条 ingredientDraft 语义不变。
   */
  ingredientDrafts?: IngredientRecordDraft[];
  /**
   * 采购完成入库（complete_purchase）的回写锚点。
   *
   * 卡片本身复用既有 ingredientDrafts / SAVE_INGREDIENTS 链路，不造第二套确认卡；
   * 这几个 id 只承担冰箱卡链路没有的那一步：写入成功后把对应清单条目打上
   * restockedAt。与采购清单页勾选「已购买」出的那张卡是同一个幂等锚点。
   */
  restockAnchors?: RestockAnchor[];
  /**
   * 该消息携带的 Task 是否已被用户处理完（确认加入 / 取消）。
   *
   * 持久化在消息上，而不是只活在 React state 里，因此：
   * - 刷新页面后 deriveActiveTask 会跳过它，不会把已完成的 Task 重新
   *   恢复成 active continuation 并劫持后续聊天；
   * - 确认卡片能稳定停留在结果态，不会因刷新而回到「可再次提交」。
   */
  taskResolved?: 'committed' | 'cancelled';
}

export interface ChatApiResponse {
  response: string;
  intent: string;
  requiredData: string[];
  draft?: IngredientRecordDraft;
  /** 批量食材草稿（P0.5-1）：与 draft 互斥，同一条响应只出现其一 */
  drafts?: IngredientRecordDraft[];
  /**
   * 采购完成（complete_purchase）：drafts 里每一行对应的清单条目。
   * 前端在 SAVE_INGREDIENTS 成功后按它打 restockedAt，见 ChatMessage.restockAnchors。
   */
  restockAnchors?: RestockAnchor[];
  action?: string;
  ingredient?: Record<string, unknown>;
  /** 批量入库载荷（P0.5-1）：与 SAVE_INGREDIENTS action 同时出现 */
  ingredients?: Record<string, unknown>[];
  recipeMatches?: RecommendedRecipe[];
  /**
   * AI Task Foundation 输出。
   * 当前实现 add_shopping_item。
   */
  task?: {
    taskType: AITaskType;
    confidence: number;
    reason: string;
    requiresConfirmation: boolean;
    shoppingDrafts?: ShoppingItemDraft[];
    consumableDrafts?: ConsumableDraft[];
    /** add_consumable 多轮收集阶段 */
    consumablePhase?: ConsumableSessionPhase;
    /** update_consumable_status 已确定的回写指令 */
    consumableUpdates?: ConsumableStatusUpdate[];
    /**
     * 卡片口令：这条响应等价于用户在上一张确认卡片上点了按钮。
     * 前端用与按钮同一个 commit 函数落地，并把卡片翻到结果态。
     */
    cardCommand?: CardCommand;
  };
  /**
   * 显式卡片动作 / 待确认对象歧义时，服务端原样回传请求里的会话快照。
   * 前端据此保持 activeTask 不变 —— 操作一张卡不该结束另一张卡的会话。
   * 缺省（undefined）表示本轮按常规语义收敛，前端继续用 nextActiveTask(task)。
   */
  activeTask?: ActiveTaskSnapshot | null;
}

/**
 * 卡片按钮的显式动作。
 *
 * 点击 UI 与自然语言是两种输入：按钮自带 target，服务端不需要、也不应该
 * 再用「谁是 currentDraft / 谁是 activeTask」去猜用户点的是哪张卡。
 * 目前只有食材确认卡需要它 —— 采购卡与消耗品卡的草稿存在消息自身，
 * 按钮天然精确绑定到那条消息，不经过服务端。
 */
export interface IngredientCardAction {
  kind: 'ingredient';
  command: CardCommand;
}

export interface ChatRequestBody {
  message: string;
  ingredients?: unknown;
  myRecipes?: unknown;
  currentDraft?: IngredientRecordDraft;
  /** 批量冰箱卡（P0.5-1）：整组确认时随 cardAction 一起送，服务端逐条复用单条映射 */
  drafts?: IngredientRecordDraft[];
  /** 消耗品快照：update_consumable_status 需要按名字匹配已有条目 */
  consumables?: unknown;
  /**
   * 采购清单快照（发送瞬间现读 localStorage）：complete_purchase 靠它判断
   * 「买回来的一样东西是否真挂在清单上」。对不上清单就不凭空造入库卡。
   */
  shoppingLists?: unknown;
  /**
   * 进行中的多轮 Task（服务端无状态，由前端回传）。
   * 存在时优先尝试续采，除非新消息命中了更明确的 Action Task。
   */
  activeTask?: ActiveTaskSnapshot;
  /** 食材确认卡按钮：带 target 的显式动作，优先级高于一切语义推断 */
  cardAction?: IngredientCardAction;
}