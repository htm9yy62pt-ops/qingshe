'use client';

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChatMessage, ChatApiResponse, IngredientCardAction, RecommendedRecipe } from '@/lib/types/chat';
import { IngredientConfirmCard } from '@/components/IngredientConfirmCard';
import type { IngredientRecordDraft } from '@/lib/ai/record';
import { readCardCommand } from '@/lib/ai/confirmation';
import { Recipe } from '@/lib/types/recipe';
import { InventoryIngredient } from '@/lib/types/ingredient';
import { QINGSCHE_RECIPES } from '@/lib/knowledge';
import { RecipeMatchCards } from '@/components/RecipeMatchCards';
import { RecipeDetailModal } from '@/components/RecipeDetailModal';
import { loadIngredients, saveIngredients, commitIngredients } from '@/lib/reality/ingredients';
import { BuildLifeOnboarding } from '@/components/BuildLifeOnboarding';
import { needsOnboarding } from '@/lib/onboarding/state';
import {
  sendRequest,
  reconcilePendingOnMount,
  clearPendingRequests
} from '@/lib/ai/request-manager';
import {
  classifyThinkingScenario,
  ThinkingScenario
} from '@/lib/ai/thinking-tasks';
import { AIThinkingProgress } from '@/components/AIThinkingProgress';
import { ShoppingDraftConfirm } from '@/components/ShoppingDraftConfirm';
import { ConsumableDraftConfirm } from '@/components/ConsumableDraftConfirm';
import { loadConsumables } from '@/lib/reality/consumables';
import { applyConsumableStatusUpdates } from '@/lib/reality/consumable-updates';
import {
  deriveActiveTask,
  nextActiveTask,
  buildShoppingDraftSummary,
  type ActiveTaskSnapshot,
  type ShoppingItemDraft,
  type CardCommand,
  type CardKind,
  type ConsumableStatusUpdate
} from '@/lib/ai/tasks';
import { commitConsumables } from '@/lib/reality/consumable-commit';
import { getShoppingLists, markShoppingItemRestocked, commitShoppingDrafts } from '@/lib/reality/shopping-lists';

/** 食材草稿的持久化槽位。B1 起只服务 collecting 的跨轮补字段。 */
const RECORD_DRAFT_KEY = 'qingshe_ai_record_draft';

/**
 * collecting 草稿的唯一持久化出口。confirming 草稿不走这里 —— 它活在消息上。
 */
function saveCollectingDraft(draft: IngredientRecordDraft | null) {
  try {
    if (draft) {
      localStorage.setItem(RECORD_DRAFT_KEY, JSON.stringify(draft));
    } else {
      localStorage.removeItem(RECORD_DRAFT_KEY);
    }
  } catch {
    // ignore
  }
}

/**
 * 历史 confirming 草稿的一次性迁移（B1）。
 *
 * 旧版本把 confirming 草稿存在 RECORD_DRAFT_KEY 里，刷新后靠全局槽位复活。
 * 这里把它搬进最后一条「已完成、未 resolved、还没挂过食材卡」的 assistant 消息，
 * 然后由调用方删掉 key。
 *
 * 幂等：key 删除后不会再触发；已有 ingredientDraft 的消息不会被覆盖。
 * 找不到宿主（消息列表已清空 / 只剩 pending）时原样返回，调用方照样丢弃该草稿，
 * 不会凭空插入消息。
 */
function migrateConfirmingDraft(
  msgs: ChatMessage[],
  draft: IngredientRecordDraft
): ChatMessage[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (
      m.role === 'assistant' &&
      m.status !== 'pending' &&
      m.status !== 'failed' &&
      !m.taskResolved &&
      !m.ingredientDraft &&
      !m.ingredientDrafts?.length
    ) {
      const next = [...msgs];
      next[i] = { ...m, ingredientDraft: draft };
      return next;
    }
  }
  return msgs;
}

/**
 * 屏幕上还活着的那张食材确认卡（挂在消息上、未被消费）。
 *
 * 服务端无状态，打字口令时只有前端知道有没有卡。B1 把 confirming 草稿从全局
 * 槽位挪进消息后，这条上报通道就是歧义澄清唯一的信息来源 —— 不报上去，
 * 「食材卡 + 采购卡同时挂着」会退化成服务端替用户挑一张去写真实数据。
 */
function liveIngredientCard(
  msgs: ChatMessage[]
): { messageId: string; draft: IngredientRecordDraft; drafts: IngredientRecordDraft[] } | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant' || m.status !== 'completed' || m.taskResolved) continue;
    if (m.ingredientDraft?.status === 'confirming') {
      return { messageId: m.id, draft: m.ingredientDraft, drafts: [m.ingredientDraft] };
    }
    // 批量卡（P0.5-1）：头一行作为「活着的那张卡」的样本，整组随口令上报 ——
    // UPDATE_FIELD 改的是哪一行不重要，重要的是保存时必须带走全部行。
    const confirming = m.ingredientDrafts?.filter((d) => d.status === 'confirming');
    if (confirming?.length) return { messageId: m.id, draft: confirming[0], drafts: confirming };
  }
  return null;
}

const loadMyRecipes = (): Recipe[] => {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('qingshe_my_recipes');
    return stored ? JSON.parse(stored) : [];
  }
  return [];
};

/**
 * 首页三个入口。Tailwind 需要静态类名，配色直接写死在数据里。
 */
const HOME_ENTRIES = [
  { href: '/reality', label: '我的厨房', icon: '🍳', tone: 'bg-blue-100' },
  { href: '/life-resources', label: '我的好店', icon: '🏪', tone: 'bg-green-100' },
  {
    href: '/reality?tab=reminders',
    label: '提醒事项',
    icon: '⏰',
    tone: 'bg-purple-100'
  }
];

export default function HomePage() {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [myRecipes, setMyRecipes] = useState<Recipe[]>([]);
  const [ingredients, setIngredients] = useState<InventoryIngredient[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<RecommendedRecipe | null>(null);
  const messagesEndRef = useRef<null | HTMLDivElement>(null);
  // 已确认/取消的 shoppingDraft requestId 集合：
  // 用于在 committed 后从 UI 摘掉 ShoppingDraftConfirm。
  const [committedShoppingDrafts, setCommittedShoppingDrafts] = useState<
    Record<string, 'committed' | 'cancelled'>
  >({});
  // 已确认/取消的 consumableDraft requestId 集合
  const [committedConsumableDrafts, setCommittedConsumableDrafts] = useState<
    Record<string, 'committed' | 'cancelled'>
  >({});
  // 进行中的多轮 Task（目前只有 add_consumable）。服务端无状态，随请求回传。
  const [activeTask, setActiveTask] = useState<ActiveTaskSnapshot | null>(null);

  /**
   * 食材草稿的唯一真相源是消息本身（ChatMessage.ingredientDraft）。
   * 这里只保留 collecting 的跨轮补字段快照 —— 它是「当前任务」，跟着页面底部走是对的。
   * confirming 的卡片永远钉在它所属的那条 assistant 消息里，不再进这个 state。
   */
  const [currentDraft, setCurrentDraft] = useState<IngredientRecordDraft | null>(
    null
  );

  /**
   * 食材卡的一次性提交回执：messageId → 已点下的按钮。
   * 只活在内存里 —— 卡片被消费后 ingredientDraft 即清除，刷新后的禁用态由消息本身负责。
   */
  const [ingredientCardResults, setIngredientCardResults] = useState<
    Record<string, 'confirm' | 'cancel'>
  >({});

  /**
   * requestId → 该请求所服务的食材卡宿主消息。
   *
   * 点一次卡片会新起一个请求（留下一条「确认」气泡和一条回答），卡片却属于
   * 原来那条消息。服务端无状态、只认 requestId，所以这条回程索引由前端自己记：
   * 没有它，写入成功后不知道该收哪张卡，退回待补时又会把卡复制一份。
   */
  const cardHostByRequest = useRef<Record<string, string>>({});

  /**
   * 「建立我的生活」的出场判定。
   *
   * 标记只活在 localStorage，服务端渲染阶段无从知道这个浏览器有没有跟轻舍打过照面，
   * 所以首帧之后再问一次 needsOnboarding：不在 SSR 猜答案，也不给首页留水合分叉。
   */
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShowOnboarding(needsOnboarding()));
    return () => cancelAnimationFrame(frame);
  }, []);

  /**
   * 浮层退场：收起自己，再把首页那份库存展示快照对齐到最新 ——
   * 「建立我的生活」期间是真的写进了冰箱，首页不该继续显示进来之前的那份。
   */
  const finishOnboarding = useCallback(() => {
    setShowOnboarding(false);
    setIngredients(loadIngredients());
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // 初始化时从 localStorage 读取聊天记录和 draft
  useEffect(() => {
    // 从 localStorage 读取聊天记录
    const savedMessages = localStorage.getItem('qingshe_ai_messages');
    // 旧版本把 confirming 草稿存在全局槽位里，先把它搬回宿主消息再渲染。
    const savedDraft = localStorage.getItem(RECORD_DRAFT_KEY);
    let confirmingDraft: IngredientRecordDraft | null = null;
    if (savedDraft) {
      try {
        const parsed = JSON.parse(savedDraft) as IngredientRecordDraft;
        if (parsed?.type === 'ingredient' && parsed.status === 'confirming') {
          confirmingDraft = parsed;
        } else if (parsed?.type === 'ingredient' && parsed.status === 'collecting') {
          setCurrentDraft(parsed);
        }
      } catch (e) {
        console.error('Failed to parse saved draft:', e);
      }
      localStorage.removeItem(RECORD_DRAFT_KEY);
    }

    if (savedMessages) {
      try {
        let parsedMessages: ChatMessage[] = JSON.parse(savedMessages).map(
          (msg: ChatMessage) => ({
            ...msg,
            createdAt: new Date(msg.createdAt) // 将字符串日期转换为Date对象
          })
        );
        if (confirmingDraft) {
          parsedMessages = migrateConfirmingDraft(parsedMessages, confirmingDraft);
        }
        setMessages(parsedMessages);
        setActiveTask(deriveActiveTask(parsedMessages));
        // 已确认 / 已取消的 Task 状态持久化在消息上，刷新后一并恢复：
        // 否则卡片会回到「可再次提交」，造成重复写入采购清单。
        const resolvedTasks = parsedMessages.reduce(
          (acc, m) => {
            if (m.requestId && m.taskResolved) {
              acc[m.requestId] = m.taskResolved;
            }
            return acc;
          },
          {} as Record<string, 'committed' | 'cancelled'>
        );
        setCommittedShoppingDrafts(resolvedTasks);
        setCommittedConsumableDrafts(resolvedTasks);
      } catch (e) {
        console.error('Failed to parse saved messages:', e);
        // 如果解析失败，使用默认欢迎消息
        setMessages([
          {
            id: 'welcome',
            content: '你好，我是小青。告诉我你正在遇到什么生活问题，或者告诉我今天发生了什么。',
            role: 'assistant',
            createdAt: new Date(),
            status: 'completed'
          }
        ]);
      }
    } else {
      // 如果没有保存的消息，使用默认欢迎消息
      setMessages([
        {
          id: 'welcome',
          content: '你好，我是小青。告诉我你正在遇到什么生活问题，或者告诉我今天发生了什么。',
          role: 'assistant',
          createdAt: new Date(),
          status: 'completed'
        }
      ]);
    }

    // 初始化时读取用户自建菜谱，用于菜谱详情查询
    setMyRecipes(loadMyRecipes());

    // 初始化时读取冰箱食材，用于制作结果确认后的库存更新
    setIngredients(loadIngredients());
  }, []);

  // 持久化工具
  const saveMessagesToLocalStorage = (messagesToSave: ChatMessage[]) => {
    try {
      localStorage.setItem('qingshe_ai_messages', JSON.stringify(messagesToSave));
    } catch (e) {
      console.error('Failed to save messages to localStorage:', e);
    }
  };

  /**
   * 计算某条 assistant pending 消息应该展示哪个 Thinking Scenario。
   * 找到它的前一条 user 消息，根据其内容做轻量确定性分类。
   */
  const getScenarioForPending = (
    msgs: ChatMessage[],
    assistantIndex: number
  ): ThinkingScenario => {
    for (let i = assistantIndex - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'user') {
        return classifyThinkingScenario(
          m.content,
          currentDraft != null && currentDraft.status === 'collecting'
        );
      }
    }
    return 'general';
  };

  /**
   * 读取并以纯函数方式更新 messages 的持久化版本。
   * 不依赖任何 React 组件 state。供 Request Manager callback 在组件
   * 已经 unmount 的情况下依然能够可靠写入 localStorage。
   * 写完之后尝试调用 setMessages 通知 UI（如果组件仍存活则生效，
   * 已 unmount 时 React 会静默忽略，不影响 storage）。
   */
  /** 读取持久化的聊天记录（localStorage 是唯一真相，回调里不能依赖闭包状态） */
  const readStoredMessages = (): ChatMessage[] => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem('qingshe_ai_messages');
      const parsed = raw ? (JSON.parse(raw) as ChatMessage[]) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const updateMessagesInStorage = (
    updater: (current: ChatMessage[]) => ChatMessage[]
  ) => {
    if (typeof window === 'undefined') return;
    const next = updater(readStoredMessages());
    saveMessagesToLocalStorage(next);
    setMessages(next);
  };

  /**
   * 把食材草稿写进指定消息（null 表示清除）。
   *
   * 走 updateMessagesInStorage 而不是闭包里的 messages：卡片可能在响应回来之后
   * 才被点击、甚至组件已经 unmount，真相源始终是 localStorage 里的那条消息。
   *
   * 落新卡时顺带作废旧卡，维持「屏幕上只有一张活着的食材卡」：服务端只认一个
   * currentDraft，两张卡同时挂着会让打字「确认」指向不明，而新的一句录入已经
   * 说明用户放弃了上一条。
   */
  const patchMessageDraft = (
    messageId: string,
    draft: IngredientRecordDraft | null,
    drafts?: IngredientRecordDraft[] | null
  ) => {
    const nextDrafts = drafts && drafts.length > 0 ? drafts : undefined;
    updateMessagesInStorage((prev) =>
      prev.map((m) => {
        if (m.id === messageId) {
          return {
            ...m,
            ingredientDraft: draft ?? undefined,
            ingredientDrafts: nextDrafts
          };
        }
        if (
          (draft || nextDrafts) &&
          (m.ingredientDraft || m.ingredientDrafts || m.restockAnchors)
        ) {
          // 单条卡与批量卡同权：落新卡时把别的卡作废，两种卡形一起清。
          // 采购完成入库的回写锚点跟着它那张卡走，卡作废了锚点也就没有归属，一并收掉。
          return {
            ...m,
            ingredientDraft: undefined,
            ingredientDrafts: undefined,
            restockAnchors: undefined
          };
        }
        return m;
      })
    );
  };

  /**
   * 采购完成入库的回写：把这张卡对应的清单条目打上 restockedAt。
   *
   * 库存写入走的是既有冰箱卡链路（SAVE_INGREDIENTS → commitIngredients），那条链路
   * 只认识食材，不认识「这次采购」。锚点存在消息上，就是补这一步用的。
   *
   * 只在写入成功之后调用：写失败的卡留在原位可以重试，清单不该被提前标记。
   * markShoppingItemRestocked 每次自己现读再落盘（时间戳幂等），逐条 fold 即可。
   */
  const markRestockedAnchors = (messageId: string | undefined) => {
    if (!messageId) return;
    const anchors = readStoredMessages().find((m) => m.id === messageId)
      ?.restockAnchors;
    if (!anchors?.length) return;
    anchors.reduce(
      (lists, anchor) =>
        markShoppingItemRestocked(lists, anchor.listId, anchor.itemId),
      getShoppingLists()
    );
  };

  // 更新或追加一个 assistant 占位（用于绑定 requestId）
  // 接受 prev 列表，返回新列表。不依赖外部 React state，兼容已 unmount 组件。
  //
  // 关键修复（Part 1 — Thinking Progress Residual）：
  // - 任何一次 assistant 写入都先 "clearAllPendingAssistants"
  //   保证响应完成后不存在 status === 'pending' 的 assistant。
  // - 仅在没有任何相同 requestId 的占位时，才插入新占位。
  // - 这样无论 response 来得多快/多慢、是否串消息，UI 都不会残留多个 Thinking Progress。
  const upsertAssistantPlaceholder = (
    prev: ChatMessage[],
    userMessageId: string,
    requestId: string,
    patch: Partial<ChatMessage>
  ): ChatMessage[] => {
    // Step 1: 清除 prev 中所有 status === 'pending' 的 assistant。
    // 这些都是孤儿占位（无论是历史失败还是并发残留），不允许残留。
    const withoutPending = prev.filter(
      (m) => !(m.role === 'assistant' && m.status === 'pending')
    );

    // Step 2: 尝试找已经存在的同 requestId assistant（非 pending 状态，可能是 completed/failed）。
    let found = false;
    const next = withoutPending.map((m) => {
      if (m.requestId === requestId) {
        found = true;
        return { ...m, ...patch };
      }
      return m;
    });
    if (found) return next;

    // Step 3: 没找到同 requestId，则在该 user 消息之后插入新占位。
    // 此时 prev 中已无 pending assistant，所以插入后只会有一个对应 assistant。
    const userIdx = next.findIndex((m) => m.id === userMessageId);
    const placeholder: ChatMessage = {
      id: `assistant_${requestId}`,
      role: 'assistant',
      content: '',
      createdAt: new Date(),
      requestId,
      status: 'pending',
      ...patch
    };
    if (userIdx < 0) return [...next, placeholder];
    return [...next.slice(0, userIdx + 1), placeholder, ...next.slice(userIdx + 1)];
  };

  /**
   * 把 AI 判定出的余量回写应用到消耗品存储。
   * update_consumable_status 不经过确认卡片：用户陈述的就是事实。
   * 写入编排（含提醒重算）由 reality 层负责，页面只触发。
   */
  const applyConsumableUpdates = (updates: ConsumableStatusUpdate[]) => {
    applyConsumableStatusUpdates(updates);
  };

  /**
   * 卡片口令：用户在输入框里打字「确认 / 算了」，等价于点了卡片上的按钮。
   *
   * 写入复用与按钮同一个 commit 函数，卡片也翻到同一个结果态 ——
   * 否则就会出现「AI 嘴上说已记录，qingshe_reminders 里却什么都没有」。
   */
  const applyCardCommand = (kind: CardKind, command: CardCommand) => {
    const pending = [...readStoredMessages()].reverse().find((m) => {
      if (m.role !== 'assistant' || !m.requestId || m.taskResolved) return false;
      return kind === 'shopping'
        ? (m.shoppingDrafts?.length ?? 0) > 0
        : m.consumablePhase === 'confirming' &&
            (m.consumableDrafts?.length ?? 0) > 0;
    });
    if (!pending) return;

    if (command === 'confirm') {
      if (kind === 'shopping') {
        commitShoppingDrafts(pending.shoppingDrafts ?? []);
      } else {
        commitConsumables(pending.consumableDrafts ?? []);
      }
    }
    resolveTask(pending, command === 'confirm' ? 'committed' : 'cancelled', kind);
  };

  const handleAssistantComplete = (
    userMessageId: string,
    requestId: string,
    data: ChatApiResponse
  ) => {
    // 本轮的 assistant 消息。confirming 卡就挂在消息上，不再往全局槽位里塞。
    const assistantMessageId = `assistant_${requestId}`;
    // 这张卡是不是某次卡片点击续出来的。点卡片会新起一个请求，卡却属于原来那条
    // 消息 —— 服务端只认 requestId，靠 cardHostByRequest 补这条回程索引。
    const hostMessageId = cardHostByRequest.current[requestId];
    delete cardHostByRequest.current[requestId];
    let cardDraft: IngredientRecordDraft | undefined;
    let cardDrafts: IngredientRecordDraft[] | undefined;
    let cardConsumed = false;

    // 处理食材保存动作（与原先逻辑保持一致）
    if (data.draft) {
      if (data.draft.status === 'confirming') {
        // 确认卡属于消息，不属于页面底部；全局槽位只留 collecting，
        // 否则下一句明确录入会被这张旧卡劫持成字段补充。
        cardDraft = data.draft;
        setCurrentDraft(null);
        saveCollectingDraft(null);
      } else {
        setCurrentDraft(data.draft);
        saveCollectingDraft(data.draft);
      }
    } else if (data.drafts?.length) {
      // 批量冰箱卡（P0.5-1）：整组挂在消息上，不碰全局 collecting 槽位。
      cardDrafts = data.drafts;
      setCurrentDraft(null);
      saveCollectingDraft(null);
    } else if (data.intent === 'REALITY_RECORD') {
      // 服务端本轮没有回传草稿 = 这一条录入已走完（确认/取消），
      // 本地必须同步作废，否则残留草稿会把下一句明确录入劫持成字段补充。
      setCurrentDraft(null);
      saveCollectingDraft(null);
      cardConsumed = true;
    }

    if (data.action === 'SAVE_INGREDIENT' && data.ingredient) {
      const existingIngredients = loadIngredients();
      const ingredientData = data.ingredient as Record<string, unknown>;
      const newIngredient: InventoryIngredient = {
        id: `ingredient_${Date.now()}`,
        name: ingredientData.name as string,
        quantity: String(ingredientData.quantity || '1'),
        unit: (ingredientData.unit as string) || '',
        category: (ingredientData.category as string) || '其他',
        purchaseDate: ingredientData.purchaseDate as string,
        expiryDate: ingredientData.expiryDate as string,
        storageLocation: (ingredientData.storageLocation as string) || '冷藏',
        createdAt: new Date().toISOString().split('T')[0]
      };
      saveIngredients([...existingIngredients, newIngredient]);
      setCurrentDraft(null);
      saveCollectingDraft(null);
      // 只买回来一样东西时卡片只有一行，走的就是这条单条链路 —— 锚点照样要收，
      // 否则清单条目没打上 restockedAt，下次勾选还会出第二张卡。
      markRestockedAnchors(hostMessageId);
      // 写入成功才收卡：失败时卡片留在原位，可以重试。
      cardConsumed = true;
    }
    // 批量冰箱卡（P0.5-1）：一次请求 N 条，同一张卡整组消费。
    // 入库交给 Reality 层唯一写入者：现读 storage 再追加，一次调用只 save 一次。
    // 字段映射（1 / 其他 / 冷藏 / 今天）不在页面里各写一份，onboarding 用的是同一个。
    if (data.action === 'SAVE_INGREDIENTS' && data.ingredients?.length) {
      commitIngredients(data.ingredients);
      setCurrentDraft(null);
      saveCollectingDraft(null);
      // 这张卡来自采购完成时，顺手把清单条目打上 restockedAt；普通冰箱卡没有锚点，空转。
      markRestockedAnchors(hostMessageId);
      cardConsumed = true;
    }

    // Task 状态机：推导逻辑收敛在 active-task.nextActiveTask，页面与 harness 共用一份。
    // - add_consumable / add_shopping_item → 保存草稿与阶段，下一句可续采
    // - 其它 Task（含 chat）→ 视为用户改口，结束进行中的会话
    // - update_consumable_status → 另外直接回写 Reality Storage
    // 卡片口令：打字等于点按钮，先把写入落地（与按钮共用 commit），再收敛会话状态
    if (data.task?.cardCommand) {
      applyCardCommand(
        data.task.taskType === 'add_shopping_item' ? 'shopping' : 'consumable',
        data.task.cardCommand
      );
    }
    // 服务端显式回传快照（点了一张卡 / 正在问「你要操作哪一个」）时，这一轮
    // 不收敛任何会话 —— 操作食材卡不该结束正在等的采购会话。
    // 字段缺省才按常规推导下一轮 activeTask。
    setActiveTask(data.activeTask !== undefined ? data.activeTask : nextActiveTask(data.task));

    if (data.task?.taskType === 'update_consumable_status') {
      applyConsumableUpdates(data.task.consumableUpdates ?? []);
    }

    updateMessagesInStorage((prev) =>
      upsertAssistantPlaceholder(prev, userMessageId, requestId, {
        content: data.response,
        createdAt: new Date(),
        intent: data.intent,
        ...(data.recipeMatches && data.recipeMatches.length > 0
          ? { recipeMatches: data.recipeMatches }
          : {}),
        // 采购完成的回写锚点跟着卡片挂在本条消息上（卡片本身走既有 drafts 通道）。
        ...(data.restockAnchors?.length
          ? { restockAnchors: data.restockAnchors }
          : {}),
        ...(data.task
          ? {
              taskType: data.task.taskType,
              ...(data.task.shoppingDrafts
                ? { shoppingDrafts: data.task.shoppingDrafts }
                : {}),
              ...(data.task.consumableDrafts
                ? { consumableDrafts: data.task.consumableDrafts }
                : {}),
              ...(data.task.consumablePhase
                ? { consumablePhase: data.task.consumablePhase }
                : {}),
              ...(data.task.consumableUpdates
                ? { consumableUpdates: data.task.consumableUpdates }
                : {})
            }
          : {}),
        status: 'completed'
      })
    );

    // 卡片落位放在消息写入之后：宿主消息可能正是本轮新建的这条，先保证它存在。
    //
    // 三种结果：
    // - 本轮点的是已有卡片，服务端把同一份草稿退回（还差字段）→ 卡留在原消息上刷新，
    //   不复制一份到下面，否则同一条记录会出现两张可点的卡。
    // - 本轮产出了新的确认卡 → 挂到本轮的 assistant 消息上。
    // - 卡片已被消费（写入成功 / 取消）→ 从宿主消息上摘掉。
    //
    // 直接录入（无卡、无 cardAction）时 hostMessageId 为空，走不到摘卡分支，
    // 不会被误标 taskResolved。
    const cardTargetId = hostMessageId ?? assistantMessageId;
    if (cardDrafts) {
      // 批量卡与单条卡同一落点：挂在回程的那条消息上，全列表只留这一张。
      patchMessageDraft(cardTargetId, null, cardDrafts);
    } else if (cardDraft) {
      patchMessageDraft(cardTargetId, cardDraft);
    } else if (cardConsumed && hostMessageId) {
      updateMessagesInStorage((prev) =>
        prev.map((m) =>
          m.id === hostMessageId &&
          (m.ingredientDraft || m.ingredientDrafts || m.restockAnchors)
            ? {
                ...m,
                ingredientDraft: undefined,
                ingredientDrafts: undefined,
                // 锚点跟着卡片一起消费：库存已写入，restockedAt 也已在上面落好。
                restockAnchors: undefined,
                taskResolved: 'committed' as const
              }
            : m
        )
      );
    }
  };

  const handleAssistantFailed = (
    userMessageId: string,
    requestId: string,
    error: Error
  ) => {
    console.error('AI request failed:', error);
    // 请求失败：卡片没被消费，摘掉回程索引让它下次还能被点到。
    const failedHostId = cardHostByRequest.current[requestId];
    delete cardHostByRequest.current[requestId];
    if (failedHostId) {
      // 一次性回执也要撤回，否则失败后这张卡永远点不动，用户无法重试。
      setIngredientCardResults((prev) => {
        if (!(failedHostId in prev)) return prev;
        const next = { ...prev };
        delete next[failedHostId];
        return next;
      });
    }
    updateMessagesInStorage((prev) =>
      upsertAssistantPlaceholder(prev, userMessageId, requestId, {
        content: '抱歉，与 AI 通信时出现错误，请稍后重试。',
        createdAt: new Date(),
        status: 'failed'
      })
    );
  };

  /**
   * 食材确认卡按钮。messageId 决定这张卡自己的命运，全局槽位只被清一次。
   *
   * - confirm：把这条消息上的草稿快照交给服务端写入。卡片要等服务端确认写入
   *   成功才收起（见 handleAssistantComplete 的摘卡分支），失败时留在原位可重试。
   * - cancel：纯本地动作 —— 立刻收卡、作废草稿，再发一句「取消」让助手确认。
   *   取消没有服务端副作用，不需要等回执。
   *
   * 重复点击由 messageId 回执拦住：一次点击只对应一次写入。
   */
  const handleIngredientCardClick = (
    messageId: string,
    draft: IngredientRecordDraft,
    command: 'confirm' | 'cancel',
    drafts?: IngredientRecordDraft[]
  ) => {
    if (ingredientCardResults[messageId] || draft.status !== 'confirming') return;
    setIngredientCardResults((prev) => ({ ...prev, [messageId]: command }));
    // 批量卡整组同命运：超过一行才走批量通道，单行保持原语义。
    const group = drafts && drafts.length > 1 ? drafts : undefined;
    const cardAction = { kind: 'ingredient' as const, command };

    if (command === 'cancel') {
      patchMessageDraft(messageId, null);
      setCurrentDraft(null);
      saveCollectingDraft(null);
      sendMessage('取消', group ? { cardAction, drafts: group } : { cardAction, draft });
      return;
    }

    // 确认：记下「这个请求为哪张卡服务」，回执才知道收哪张。
    const requestId = sendMessage('确认', group ? { cardAction, drafts: group } : { cardAction, draft });
    if (requestId) cardHostByRequest.current[requestId] = messageId;
  };

  /**
   * 发送一条用户消息。输入框提交与确认卡片按钮共用这一条出口，
   * 保证 activeTask 快照的取法只有一处。
   *
   * 传入 cardAction 时 message 只是气泡展示文案：服务端按 cardAction 定位草稿，
   * 不再用「谁是 currentDraft / 谁是 activeTask」去猜用户点了哪张卡。
   *
   * options.draft 是卡片点击时的显式覆盖：食材确认卡的草稿来自那条消息本身，
   * 不是全局 collecting 槽位。缺省（undefined）才代表「输入框说话，用当前任务」。
   *
   * 返回本轮 requestId（空输入被丢弃时返回 null），调用方据此把请求和它服务的
   * 那张卡对上号。
   *
   * Fix 4A: 不以全局 isLoading 锁定输入，每个请求拥有独立 requestId，支持并发。
   */
  const sendMessage = (
    text: string,
    options?: {
      cardAction?: IngredientCardAction;
      draft?: IngredientRecordDraft | null;
      drafts?: IngredientRecordDraft[];
    }
  ): string | null => {
    const trimmed = text.trim();
    if (!trimmed) return null;

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const userMessageId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const userMessage: ChatMessage = {
      id: userMessageId,
      content: trimmed,
      role: 'user',
      createdAt: new Date()
    };

    const assistantPlaceholder: ChatMessage = {
      id: `assistant_${requestId}`,
      role: 'assistant',
      content: '',
      createdAt: new Date(),
      requestId,
      status: 'pending'
    };

    // 防御性：发送前先清除 prev 中所有 pending assistant 占位。
    // 避免上一次失败/孤儿请求在 React state 与 storage 中残留，
    // 进而导致 Thinking Progress 与真实回复同时渲染。
    const clearedMessages = messages.filter(
      (m) => !(m.role === 'assistant' && m.status === 'pending')
    );
    const updatedMessages = [...clearedMessages, userMessage, assistantPlaceholder];
    setMessages(updatedMessages);
    saveMessagesToLocalStorage(updatedMessages);

    // 抓取当前 ingredients / recipes / consumables 快照
    const ingredientsSnapshot = loadIngredients();
    const myRecipesSnapshot = loadMyRecipes();
    const consumablesSnapshot = loadConsumables();
    // 采购清单同理：complete_purchase 要拿这句话去对「清单上到底有什么」。
    // 用 React state 里那份会把刚在清单页加的东西当成不存在，现读 storage 才是真相。
    const shoppingListsSnapshot = getShoppingLists();
    // 打字口令与按钮是两条输入路径，服务的可能是同一张卡。按钮自带 draft；
    // 打字时卡活在消息上，服务端看不见 —— 只在口令句把它报上去，平时不报，
    // 否则下一句明确录入会被这张旧卡劫持成字段补充（正是 B1 要拆掉的耦合）。
    const textCard =
      options?.draft === undefined && options?.drafts === undefined && readCardCommand(trimmed)
        ? liveIngredientCard(clearedMessages)
        : null;
    const draftSnapshot =
      options?.draft !== undefined ? options.draft : (textCard?.draft ?? currentDraft);
    // 批量卡整组才有意义：一行卡维持原单条链路，超过一行才走批量通道。
    const batchGroup =
      options?.drafts && options.drafts.length > 1
        ? options.drafts
        : textCard && textCard.drafts.length > 1
          ? textCard.drafts
          : undefined;
    // 打字「确认 / 取消」打到批量卡上等价于按它的按钮：直接转成显式 cardAction，
    // 不让服务端靠 currentDraft 去猜口令指的是哪张卡。
    const typedCommand = batchGroup && !options?.cardAction ? readCardCommand(trimmed) : null;
    const cardActionSnapshot =
      options?.cardAction ??
      (typedCommand ? { kind: 'ingredient' as const, command: typedCommand } : undefined);
    const activeTaskSnapshot = activeTask;

    // 通过 Request Manager 发起请求（与 React 组件解耦）
    sendRequest({
      userMessageId,
      body: {
        message: trimmed,
        ingredients: ingredientsSnapshot,
        myRecipes: myRecipesSnapshot,
        // 批量通道生效时不带单条样本：服务端按「有无 currentDraft」分流批量 / 单条。
        currentDraft:
          batchGroup && cardActionSnapshot ? undefined : draftSnapshot || undefined,
        ...(batchGroup && cardActionSnapshot ? { drafts: batchGroup } : {}),
        consumables: consumablesSnapshot,
        shoppingLists: shoppingListsSnapshot,
        activeTask: activeTaskSnapshot || undefined,
        ...(cardActionSnapshot ? { cardAction: cardActionSnapshot } : {})
      },
      callbacks: {
        onAssistantComplete: handleAssistantComplete,
        onAssistantFailed: handleAssistantFailed
      }
    });

    // 打字口令同样在为那张卡服务：写入成功后不知道该收哪张，靠这条回程索引。
    if (textCard) cardHostByRequest.current[requestId] = textCard.messageId;

    return requestId;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    sendMessage(inputValue);
    setInputValue('');
  };

  // 页面挂载时做 pending 调和：消除"永久 pending"卡死
  useEffect(() => {
    if (messages.length === 0) return;
    reconcilePendingOnMount({
      messages,
      onMarkFailed: (userMessageId, requestId) => {
        updateMessagesInStorage((prev) =>
          upsertAssistantPlaceholder(prev, userMessageId, requestId, {
            content: '请求已超时，请重试。',
            status: 'failed'
          })
        );
      }
    });
    // 仅在首次挂载执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recipeMap = useMemo(() => {
    return new Map<string, Recipe>(
      [...QINGSCHE_RECIPES, ...myRecipes].map((recipe) => [recipe.id, recipe])
    );
  }, [myRecipes]);

  // 清空对话记录
  const clearConversation = () => {
    if (confirm('确定要清空聊天记录吗？')) {
      setMessages([
        {
          id: 'welcome',
          content: '你好，我是小青。告诉我你正在遇到什么生活问题，或者告诉我今天发生了什么。',
          role: 'assistant',
          createdAt: new Date(),
          status: 'completed'
        }
      ]);
      localStorage.setItem('qingshe_ai_messages', JSON.stringify([
        {
          id: 'welcome',
          content: '你好，我是小青。告诉我你正在遇到什么生活问题，或者告诉我今天发生了什么。',
          role: 'assistant',
          createdAt: new Date(),
          status: 'completed'
        }
      ]));
      clearPendingRequests();
      // 会话清空 = 所有进行中的 Task / 待确认草稿一起作废
      setActiveTask(null);
      setCommittedShoppingDrafts({});
      setCommittedConsumableDrafts({});
      setCurrentDraft(null);
    }
  };

  /**
   * 结束一条 Task 消息。三件事必须同时发生，缺一不可：
   * 1. 卡片转结果态（内存）
   * 2. 把结果写回消息本身（taskResolved）—— 刷新后卡片不会回到「可再次提交」
   * 3. 释放 activeTask —— 已办完的会话不会继续劫持下一句输入
   */
  const resolveTask = (
    message: ChatMessage,
    outcome: 'committed' | 'cancelled',
    kind: 'shopping' | 'consumable'
  ) => {
    const requestId = message.requestId;
    if (!requestId) return;
    const setResolved =
      kind === 'shopping' ? setCommittedShoppingDrafts : setCommittedConsumableDrafts;
    setResolved((prev) => ({ ...prev, [requestId]: outcome }));
    updateMessagesInStorage((current) =>
      current.map((m) => (m.id === message.id ? { ...m, taskResolved: outcome } : m))
    );
    setActiveTask(null);
  };

  /**
   * 菜谱弹窗「加入采购清单」的唯一入口：缺料 → ShoppingItemDraft[] → 一条挂着
   * 采购卡的消息。整条确认链复用现有购物卡，不引入第二套采购状态机：
   *
   * - 卡片渲染只看 msg.shoppingDrafts，不依赖服务端往返 —— 这条消息是纯本地插入的。
   * - 按钮与打字「确认 / 算了」都走 commitShoppingDrafts / resolveTask，
   *   与 AI 采购任务共用同一个落库出口和结果态。
   * - activeTask 只在槽位空闲时认领这张卡；已有任务进行中就不劫持，
   *   卡片照样可点，槽位归属留给进行中的那个任务。
   * - 刷新恢复不用另写：deriveActiveTask 按最后一条未 resolve 的带卡消息认领槽位。
   */
  const handleRecipeShoppingDrafts = (drafts: ShoppingItemDraft[]) => {
    if (drafts.length === 0) return;
    const requestId = `recipe_${Date.now()}`;
    const message: ChatMessage = {
      id: `assistant_${requestId}`,
      role: 'assistant',
      content: buildShoppingDraftSummary(drafts),
      createdAt: new Date(),
      status: 'completed',
      taskType: 'add_shopping_item',
      requestId,
      shoppingDrafts: drafts
    };
    updateMessagesInStorage((prev) => [...prev, message]);
    if (!activeTask) {
      setActiveTask({ taskType: 'add_shopping_item', shoppingDrafts: drafts });
    }
  };

  const handleQuickQuestion = (question: string) => {
    setInputValue(question);
  };

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 bg-gray-50 pb-16">
        <div className="max-w-md mx-auto px-4 pt-4">
          <h1 className="text-3xl font-bold text-center mb-2">轻舍</h1>
          <p className="text-gray-600 text-center mb-6">该省省，该花花，管好钱包住好家</p>
          
          {/* 聊天区域 */}
          <div className="bg-white rounded-xl shadow-sm p-4 mb-4 border border-gray-200 min-h-[400px] max-h-[50vh] overflow-y-auto">
            <div className="space-y-4">
              {messages.map((msg, msgIndex) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] min-w-0 overflow-hidden rounded-lg px-4 py-2 ${
                      msg.role === 'user'
                        ? 'bg-blue-500 text-white rounded-br-none'
                        : 'bg-gray-100 text-gray-800 rounded-bl-none'
                    }`}
                  >
                    {msg.status === 'pending' ? (
                      <AIThinkingProgress
                        scenario={getScenarioForPending(messages, msgIndex)}
                      />
                    ) : msg.status === 'failed' ? (
                      <span className="text-red-600">
                        {msg.content || '请求未完成，请重试。'}
                      </span>
                    ) : (
                      msg.content
                    )}
                    {msg.intent && (
                      <div className="text-xs opacity-70 mt-1">
                        {`Intent: ${msg.intent}`}
                      </div>
                    )}
                    {msg.role === 'assistant' && msg.status !== 'pending' && (
                      <RecipeMatchCards
                        matches={msg.recipeMatches}
                        onRecipeClick={(recipeId) => {
                          const match = msg.recipeMatches?.find((r) => r.recipeId === recipeId);
                          if (!match) return;
                          // 弹窗里的「库存 xx」和消耗匹配都取自这份列表状态。
                          // 打开前对齐到当前真实库存，会话中途刚录入/入库的食材
                          // 才不会被当成「系统未记录」，也不会带着旧数量去扣减。
                          setIngredients(loadIngredients());
                          setSelectedMatch(match);
                        }}
                      />
                    )}
                    {/*
                      食材录入确认卡片：一句明确的购买不再被追问价格/保质期，
                      直接以卡片收口。卡片属于这条消息 —— 它不跟着页面底部跑，
                      新任务出现、刷新、往上翻历史，它都留在原来的回答下面。
                      按钮走显式 cardAction + 本条消息的草稿快照，
                      既不会被「同时挂着多张卡」的歧义澄清拦下，也不会结束别的会话；
                      输入框里打字「确认 / 取消」仍然有效，两条路径写出同一条记录。
                    */}
                    {msg.role === 'assistant' &&
                      msg.status === 'completed' &&
                      msg.ingredientDraft?.status === 'confirming' && (
                        <IngredientConfirmCard
                          draft={msg.ingredientDraft}
                          onConfirm={() =>
                            handleIngredientCardClick(
                              msg.id,
                              msg.ingredientDraft!,
                              'confirm'
                            )
                          }
                          onCancel={() =>
                            handleIngredientCardClick(
                              msg.id,
                              msg.ingredientDraft!,
                              'cancel'
                            )
                          }
                        />
                      )}

                    {/*
                      批量冰箱卡（P0.5-1）：一句话多样的整组确认 / 取消。
                      「移除」只把行请出卡片，不写库存也不发请求；入库永远整组一次。
                    */}
                    {msg.role === 'assistant' &&
                      msg.status === 'completed' &&
                      (msg.ingredientDrafts?.length ?? 0) > 0 && (
                        <IngredientConfirmCard
                          drafts={msg.ingredientDrafts}
                          onConfirm={() =>
                            handleIngredientCardClick(
                              msg.id,
                              msg.ingredientDrafts![0],
                              'confirm',
                              msg.ingredientDrafts
                            )
                          }
                          onCancel={() =>
                            handleIngredientCardClick(
                              msg.id,
                              msg.ingredientDrafts![0],
                              'cancel',
                              msg.ingredientDrafts
                            )
                          }
                          onRemove={(index) =>
                            patchMessageDraft(
                              msg.id,
                              null,
                              msg.ingredientDrafts!.filter((_, i) => i !== index)
                            )
                          }
                        />
                      )}

                    {/*
                      采购确认卡：只要这条消息带着草稿就渲染。
                      普通 add_shopping_item 和补货派生的 update_consumable_status
                      共用同一张卡，不再为补货单独造 UI。
                    */}
                    {msg.role === 'assistant' &&
                      msg.status === 'completed' &&
                      msg.shoppingDrafts &&
                      msg.shoppingDrafts.length > 0 &&
                      msg.requestId &&
                      committedShoppingDrafts[msg.requestId] !== 'cancelled' && (
                        <ShoppingDraftConfirm
                          drafts={msg.shoppingDrafts}
                          committed={
                            committedShoppingDrafts[msg.requestId] === 'committed'
                          }
                          onDraftsChange={(next) =>
                            updateMessagesInStorage((current) =>
                              current.map((m) =>
                                m.id === msg.id ? { ...m, shoppingDrafts: next } : m
                              )
                            )
                          }
                          onCommitted={() => resolveTask(msg, 'committed', 'shopping')}
                          onCancel={() => resolveTask(msg, 'cancelled', 'shopping')}
                          onNavigateToList={() => router.push('/shopping-list')}
                        />
                      )}

                    {/* 消耗品草稿：仅在多轮收集结束（confirming）后展示确认卡片 */}
                    {msg.role === 'assistant' &&
                      msg.taskType === 'add_consumable' &&
                      msg.consumablePhase === 'confirming' &&
                      (msg.consumableDrafts?.length ?? 0) > 0 &&
                      msg.requestId &&
                      committedConsumableDrafts[msg.requestId] !== 'cancelled' && (
                        <ConsumableDraftConfirm
                          drafts={msg.consumableDrafts!}
                          committed={
                            committedConsumableDrafts[msg.requestId] === 'committed'
                          }
                          onDraftsChange={(next) =>
                            updateMessagesInStorage((current) =>
                              current.map((m) =>
                                m.id === msg.id ? { ...m, consumableDrafts: next } : m
                              )
                            )
                          }
                          onNavigateToList={() => router.push('/consumables')}
                          onCommitted={() => resolveTask(msg, 'committed', 'consumable')}
                          onCancel={() => resolveTask(msg, 'cancelled', 'consumable')}
                        />
                      )}


                  </div>
                </div>
              ))}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* 示例问题快捷入口 */}
          {messages.length <= 2 && (
            <div className="grid grid-cols-2 gap-2 mb-4">
              <button 
                onClick={() => handleQuickQuestion('厨房里的食材能做什么？')}
                className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 px-3 rounded-lg"
              >
                厨房里的食材能做什么？
              </button>
              <button 
                onClick={() => handleQuickQuestion('今天不知道吃什么')}
                className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 px-3 rounded-lg"
              >
                今天不知道吃什么
              </button>
              <button 
                onClick={() => handleQuickQuestion('我想买一个床垫')}
                className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 px-3 rounded-lg"
              >
                我想买一个床垫
              </button>
              <button 
                onClick={() => handleQuickQuestion('帮我记录今天买的东西')}
                className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 px-3 rounded-lg"
              >
                帮我记录今天买的东西
              </button>
            </div>
          )}

          {/* 输入框和发送按钮 */}
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="告诉我你的生活问题…"
              className="flex-1 border border-gray-300 rounded-full px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={!inputValue.trim()}
              className={`px-6 py-3 rounded-full font-medium ${
                inputValue.trim()
                  ? 'bg-blue-500 text-white hover:bg-blue-600'
                  : 'bg-gray-200 text-gray-500 cursor-not-allowed'
              }`}
            >
              发送
            </button>
          </form>

          {/* 清空对话按钮 */}
          <div className="mt-4 text-center">
            <button
              onClick={clearConversation}
              className="text-sm text-gray-500 hover:text-gray-700 underline"
            >
              清空对话
            </button>
          </div>

          {/* 核心能力入口：三个卡片都要点得进去，首页是唯一总入口 */}
          <div className="grid grid-cols-3 gap-4 mt-8">
            {HOME_ENTRIES.map((entry) => (
              <Link
                key={entry.href}
                href={entry.href}
                className="bg-white rounded-lg p-4 text-center shadow-sm border border-gray-200 active:scale-[0.98] transition"
              >
                <div
                  className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-2 ${entry.tone}`}
                >
                  <span className="text-lg">{entry.icon}</span>
                </div>
                <p className="text-sm text-gray-700">{entry.label}</p>
              </Link>
            ))}
          </div>
        </div>
      </main>

      {selectedMatch && (
        <RecipeDetailModal
          recommended={selectedMatch}
          fullRecipe={recipeMap.get(selectedMatch.recipeId) ?? null}
          ingredients={ingredients}
          onClose={() => setSelectedMatch(null)}
          onInventoryUpdated={(next) => setIngredients(next)}
          onAddShoppingDrafts={handleRecipeShoppingDrafts}
        />
      )}
      {showOnboarding && (
        <BuildLifeOnboarding onFinished={finishOnboarding} />
      )}
    </div>
  );
}