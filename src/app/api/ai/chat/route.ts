import { NextRequest } from 'next/server';
import { classifyIntent } from '@/lib/ai/intent';
import type { QingsheIntent, RealityDataType } from '@/lib/ai/intent';
import { loadRealityContext } from '@/lib/ai/reality-context';
import type { RealityContext } from '@/lib/ai/reality-context';
import { extractIngredientRecord, buildIngredientDraft, tryParseInventoryRecord, tryParseInventoryRecords, shoppingItemToRestockDraft } from '@/lib/ai/record';
import type { IngredientRecordDraft, IngredientRecordData } from '@/lib/ai/record';
import { parseConfirmation, isIngredientDraftDiscard, readCardCommand } from '@/lib/ai/confirmation';
import { chatWithAI } from '@/lib/ai/service';
import {
  routeAITask,
  continueConsumableTask,
  continueShoppingTask,
  pendingCardOf,
  readDiscardCommand
} from '@/lib/ai/tasks';
// 判定函数只在 task-router 里（barrel 仅转发 routeAITask），直接取源模块，不在 API 层复刻正则。
import { isCookingCapabilityQuery } from '@/lib/ai/tasks/task-router';
import type {
  AITaskContext,
  AITaskExtraction,
  ActiveTaskSnapshot,
  CardCommand,
  ConsumableDraft,
  DiscardTarget,
  RestockItemDraft,
  ShoppingItemDraft
} from '@/lib/ai/tasks';
import type { ConsumableItem } from '@/lib/types/consumable';
import type { ShoppingList } from '@/lib/types/shopping-list';
import { QINGSCHE_RECIPES } from '@/lib/knowledge';
import type { Recipe } from '@/lib/types/recipe';
import { matchRecipes, formatRecipeMatches } from '@/lib/ai/recipe-match';
import type { RecipeMatchDetail } from '@/lib/ai/recipe-match';
import type { RecommendedRecipe, ChatRequestBody, ChatApiResponse } from '@/lib/types/chat';

export async function POST(req: NextRequest) {
  try {
    // 验证 API Key 是否存在
    const apiKey = process.env.AMD_AI_API_KEY;
    const model = process.env.AMD_AI_MODEL;

    if (!apiKey) {
      return Response.json(
        { error: 'Missing AMD AI API key configuration' },
        { status: 500 }
      );
    }

    if (!model) {
      return Response.json(
        { error: 'Missing AMD AI model configuration' },
        { status: 500 }
      );
    }

    // 解析请求体
    const body = (await req.json()) as ChatRequestBody;
    const { message, ingredients, myRecipes, currentDraft, consumables, activeTask, cardAction, shoppingLists } =
      body;

    // 验证消息是否存在
    if (!message) {
      return Response.json(
        { error: 'Message is required' },
        { status: 400 }
      );
    }

    // ============================================================
    // 输入分诊：点击 UI 与自然语言是两种输入，优先级
    //   显式 Card Action > activeTask continuation > currentDraft 自然语言 > router
    //
    // 1) 按钮自带 target，只操作它指向的那张卡。服务端不再用
    //    「谁是 currentDraft / 谁是 activeTask」去猜用户点了哪张卡。
    // 2) 纯文字口令没有 target。只有一个待确认对象时沿用既有语义；
    //    同时挂着多个对象时停下来问一句，绝不替用户选一个去写真实数据。
    //
    // 两条分支都原样回传 activeTask：操作一张卡不该结束另一张卡的会话。
    // ============================================================
    if (cardAction?.kind === 'ingredient') {
      // 批量冰箱卡（P0.5-1）：整组操作带 drafts，逐条复用单条入库映射；
      // 单行确认仍走 currentDraft，两行代码之外没有第二套语义。
      // 取消同样要认批量快照：不认的话整组取消会掉进「无草稿」分支，
      // 对用户说出「这条记录已经处理过了」——明明刚点的是五行的卡。
      if (
        !currentDraft &&
        Array.isArray(body.drafts) &&
        body.drafts.length > 0
      ) {
        if (cardAction.command === 'confirm') {
          return Response.json(ingredientBatchSavePayload(body.drafts, activeTask ?? null));
        }
        return Response.json({
          response: `好的，已取消添加这 ${body.drafts.length} 样食材。`,
          intent: 'REALITY_RECORD',
          requiredData: [],
          activeTask: activeTask ?? null
        } satisfies ChatApiResponse);
      }
      return Response.json(
        ingredientCardResponse(cardAction.command, currentDraft, activeTask ?? null)
      );
    }

    const pendingTargets = pendingTargetsOf(message, currentDraft, activeTask);
    if (pendingTargets.length > 1) {
      return Response.json({
        response:
          `现在有 ${pendingTargets.length} 件待确认事项：${pendingTargets.join(' 和 ')}。` +
          '你想操作哪一个？点卡片上的按钮，或者直接告诉我名称。',
        intent: 'REALITY_RECORD',
        requiredData: [],
        // 快照原样带回：一次澄清不该让任何一张卡消失，也不该丢掉任何一条草稿
        draft: currentDraft,
        activeTask: activeTask ?? null
      } satisfies ChatApiResponse);
    }

    // ============================================================
    // 对象词丢弃口令：「取消采购清单」不是纯句，cardCommand 通道接不住；
    // 落进续采会被当成补字段，卡片原地不动。守卫在这里解析目标：
    // 对象词指向某张待确认卡 → 等价于点它的取消按钮；
    // 无对象词且多张卡 → 反问；没有可取消的卡 → 礼貌空操作。
    // 纯句口令（「算了」「取消」）不进这里：readDiscardCommand 显式让路，
    // 歧义已由上方 pendingTargetsOf 拦下，单目标由 router 第 0 步处理。
    // ============================================================
    const discard = readDiscardCommand(message);
    if (discard) {
      const kinds = pendingDiscardKinds(currentDraft, activeTask);
      const target = discard.target ?? (kinds.length === 1 ? kinds[0] : null);
      if (target && kinds.includes(target)) {
        return Response.json(discardResponse(target, activeTask));
      }
      if (kinds.length > 1) {
        return Response.json({
          response:
            `现在有 ${kinds.length} 件待确认事项。你想取消哪一个？` +
            '点卡片上的按钮，或者直接说「取消采购清单」这类带对象的口令。',
          intent: 'REALITY_RECORD',
          requiredData: [],
          draft: currentDraft,
          activeTask: activeTask ?? null
        } satisfies ChatApiResponse);
      }
      return Response.json({
        response: '现在没有待确认的卡片，不需要取消。',
        intent: 'REALITY_RECORD',
        requiredData: [],
        activeTask: activeTask ?? null
      } satisfies ChatApiResponse);
    }

    // 构建客户端数据，包含当前可用的用户真实数据
    const clientData = {
      ingredients: Array.isArray(ingredients) ? ingredients : []
    };

    const safeUserRecipes: Recipe[] = Array.isArray(myRecipes) ? myRecipes : [];

    let responseMessage = '';
    let intent: QingsheIntent = 'LIFE_SOLUTION';
    let requiredData: RealityDataType[] = [];
    let draft: IngredientRecordDraft | undefined;
    let draftList: IngredientRecordDraft[] | undefined;
    let recommendedRecipes: RecommendedRecipe[] | undefined;

    // ============================================================
    // Router Gate：routeAITask 先于 currentDraft 执行。
    // 明确 Action Intent 优先级高于旧 Draft，可打断 Ingredient Draft 收集；
    // 对应的 handler 在下方 else 分支中短路 return（同一套 handler，不重复实现）。
    // ============================================================
    const safeConsumables: ConsumableItem[] = Array.isArray(consumables)
      ? (consumables as ConsumableItem[])
      : [];
    // 采购清单快照由前端在发送瞬间现读 localStorage 带来（服务端无状态，拿不到 storage）。
    // complete_purchase 只认挂在清单上的东西：对不上清单就没有入库草稿，也不会有卡片。
    const safeShoppingLists: ShoppingList[] = Array.isArray(shoppingLists)
      ? (shoppingLists as ShoppingList[])
      : [];

    const taskContext: AITaskContext = {
      message,
      ingredients: Array.isArray(ingredients) ? ingredients : [],
      consumables: safeConsumables,
      shoppingLists: safeShoppingLists,
      hasActiveInventoryDraft: !!currentDraft,
      activeTask
    };

    const taskExtraction = routeAITask(taskContext);

    // 卡片口令：用户在输入框里打字代替了点按钮（见 task-router 第 0 步）。
    // 冰箱食材草稿优先于口令 —— 那条流程本来就有自己的确认语义，不去抢。
    if (!currentDraft && taskExtraction.cardCommand) {
      const payload =
        taskExtraction.intent.taskType === 'add_shopping_item'
          ? buildShoppingResponse(taskExtraction)
          : buildConsumableResponse(taskExtraction);
      return Response.json({
        ...payload,
        task: { ...payload.task, cardCommand: taskExtraction.cardCommand }
      } satisfies ChatApiResponse);
    }

    const routedTaskType = taskExtraction.intent.taskType;
    // Router 只负责「这句话归谁」；continuation = true 表示字段还没绑定，
    // 需要交给 continue*Task，而不是当成一次全新的 Task 执行。
    const isContinuation = taskExtraction.continuation === true;
    const isExplicitActionTask =
      routedTaskType === 'add_shopping_item' ||
      routedTaskType === 'complete_purchase' ||
      routedTaskType === 'add_consumable' ||
      routedTaskType === 'update_consumable_status' ||
      routedTaskType === 'add_inventory' ||
      routedTaskType === 'add_reminder' ||
      routedTaskType === 'create_life_record';

    if (process.env.NODE_ENV === 'development') {
      // add_inventory 单独成档：它是唯一不短路 return、而是走确定性 Draft 构建的 Action。
      const decision = isContinuation
        ? activeTask?.taskType === 'add_shopping_item'
          ? 'continue-shopping'
          : 'continue-consumable'
        : routedTaskType === 'add_inventory'
          ? 'add-inventory'
          : isExplicitActionTask
            ? 'action-task'
            : currentDraft
              ? 'continue-draft'
              : 'fallback';
      console.log(
        `[AI_ROUTE] message: ${message} | taskType: ${routedTaskType} | hasCurrentDraft: ${!!currentDraft} | activeTask: ${activeTask?.taskType ?? 'none'} | decision: ${decision}`
      );
    }

    // ============================================================
    // Active Task Continuation：把续采回答绑定到进行中的会话。
    // 优先级高于 Ingredient Draft —— 会话是更近、更具体的一次提问。
    // 「20 天提醒我一次」这类回答已在 Router 里避开 add_reminder 关键词。
    // ============================================================
    if (isContinuation && activeTask) {
      if (activeTask.taskType === 'add_consumable') {
        return Response.json(
          buildConsumableResponse(continueConsumableTask(activeTask, taskContext))
        );
      }
      if (activeTask.taskType === 'add_shopping_item') {
        return Response.json(
          buildShoppingResponse(continueShoppingTask(activeTask, taskContext))
        );
      }
    }

    // 只有未命中明确 Action 时，才把消息当作现有 Draft 的补充信息
    if (currentDraft && !isExplicitActionTask) {
      // 作废口令先于一切字段语义：整句只是「取消 / 算了」时直接丢弃这条录入。
      // 不回传 draft —— 前端据此清掉 currentDraft 与 qingshe_ai_record_draft，
      // 全程零 LLM，弱网下也不会把「取消」变成一次失败的字段提取。
      if (isIngredientDraftDiscard(message)) {
        return Response.json({
          response: '好的，已取消添加这条食材记录。',
          intent: 'REALITY_RECORD',
          requiredData: []
        } satisfies ChatApiResponse);
      }

      // 如果当前草稿状态为确认中，优先处理确认逻辑
      if (currentDraft.status === 'confirming') {
        const confirmationResult = parseConfirmation(message);
        
        if (confirmationResult === 'confirmed') {
          // 检查草稿是否具备完成Ingredient所需的核心字段
          // 保质期可选：InventoryIngredient.expiryDate 允许空串，/reality 会按「正常」展示
          const draftData = currentDraft.data;
          if (draftData.name && draftData.purchaseDate) {
            // 落地形状与卡片按钮共用同一个构建器：两条路径必须写出同一条记录。
            return Response.json(ingredientSavePayload(draftData));
          } else {
            // 数据不完整，返回错误
            return Response.json(
              { error: 'Draft data incomplete for saving' },
              { status: 400 }
            );
          }
        } else if (confirmationResult === 'rejected') {
          // 用户拒绝，将状态改为收集状态，继续补充信息
          // 检查用户消息中是否包含新信息
          const extractedData = await extractIngredientRecord(message, currentDraft);
          draft = buildIngredientDraft(extractedData, currentDraft);
          
          intent = 'REALITY_RECORD';
          requiredData = [];

          if (draft.status === 'collecting') {
            // 询问缺失字段
            responseMessage = `好的，我已更新信息。目前还需要确认：${fieldLabels(draft.missingFields)}是什么？`;
          } else if (draft.status === 'confirming') {
            // 被驳回后重新确认：只复述已知事实，不凭空补价格 / 保质期 / 位置
            responseMessage = `好的，我重新确认一下：${describeKnownFacts(draft.data)}。信息正确吗？`;
          }
        } else if (confirmationResult === 'unclear') {
          // 用户表达不确定，保持确认状态
          responseMessage = '没问题，这条记录暂时保留着，你确认后告诉我即可。';
          intent = 'REALITY_RECORD';
          requiredData = [];
          draft = currentDraft; // 保持当前草稿
        }
      } else {
        // 专门处理食材记录补充（原来的状态是 collecting）
        const extractedData = await extractIngredientRecord(message, currentDraft);
        draft = buildIngredientDraft(extractedData, currentDraft);
        
        intent = 'REALITY_RECORD';
        requiredData = [];

        if (draft.status === 'collecting') {
          // 询问缺失字段
          responseMessage = `我已经记下你购买的信息。目前还需要确认：${fieldLabels(draft.missingFields)}是什么？`;
        } else if (draft.status === 'confirming') {
          // 只播报已知事实：价格/保质期缺失时不拼出 undefined，也不逼用户补表
          responseMessage = `好的，我确认一下：${describeKnownFacts(draft.data)}。信息正确吗？`;
        }
      }
    } else {
      // ============================================================
      // Action Task handlers（唯一一套）：复用 Router Gate 的判定结果并短路 return。
      // 进入此分支的两种情况：
      // 1) 无 currentDraft 的正常请求；
      // 2) 有 currentDraft 但命中明确 Action（Draft Interrupt Policy）。
      // 明确 Action 在此直接返回，不会落入下方 REALITY_RECORD / chat 流程。
      // ============================================================

      if (taskExtraction.intent.taskType === 'add_shopping_item') {
        return Response.json(buildShoppingResponse(taskExtraction));
      }

      // 采购完成（买回来了 / 买好了）：清单上的东西到手 → 出入库确认卡。
      // 排在消耗品/食材录入之前是 Router 的决定（第 1.5 步），这里只负责把它落成卡片。
      if (taskExtraction.intent.taskType === 'complete_purchase') {
        return Response.json(buildRestockResponse(taskExtraction));
      }

      if (taskExtraction.intent.taskType === 'add_reminder') {
        return Response.json({
          response: taskExtraction.replyText,
          intent: 'REMINDER_PLACEHOLDER',
          requiredData: [],
          task: {
            taskType: 'add_reminder',
            confidence: taskExtraction.intent.confidence,
            reason: taskExtraction.intent.reason,
            requiresConfirmation: true
          }
        } satisfies ChatApiResponse);
      }

      if (taskExtraction.intent.taskType === 'add_consumable') {
        return Response.json(buildConsumableResponse(taskExtraction));
      }

      if (taskExtraction.intent.taskType === 'update_consumable_status') {
        const updates = taskExtraction.consumableUpdates ?? [];
        return Response.json({
          response: taskExtraction.replyText,
          intent: 'CONSUMABLE_STATUS_UPDATE',
          requiredData: [],
          task: {
            taskType: 'update_consumable_status',
            confidence: taskExtraction.intent.confidence,
            reason: taskExtraction.intent.reason,
            requiresConfirmation: false,
            consumableUpdates: updates,
            // 紧急补货派生的采购草稿：让这条消息直接挂上标准确认卡片
            ...(taskExtraction.shoppingDrafts
              ? { shoppingDrafts: taskExtraction.shoppingDrafts }
              : {})
          }
        } satisfies ChatApiResponse);
      }

      if (taskExtraction.intent.taskType === 'create_life_record') {
        return Response.json({
          response: taskExtraction.replyText,
          intent: 'LIFE_RECORD_PLACEHOLDER',
          requiredData: [],
          task: {
            taskType: 'create_life_record',
            confidence: taskExtraction.intent.confidence,
            reason: taskExtraction.intent.reason,
            requiresConfirmation: true
          }
        } satisfies ChatApiResponse);
      }

      // add_inventory 例外：Router 已确定这是冰箱录入，不再让 LLM 猜意图，
      // 直接进入既有的确定性 Draft 构建流程（字段补全仍交给后续步骤）。
      // 再快一档：先试确定性解析，命中即免 LLM Thinking；
      // 未命中（复杂表达）保持原样 fallback 到 extractIngredientRecord。
      let deterministicInventory: IngredientRecordData | null = null;
      let deterministicInventoryBatch: IngredientRecordData[] | null = null;
      if (taskExtraction.intent.taskType === 'add_inventory') {
        intent = 'REALITY_RECORD';
        requiredData = ['ingredients'];
        // 先试批量：一句多料（「冰箱里有牛肉、豌豆，帮我加进冰箱」）零 LLM 出多行卡；
        // 不中再试单条，仍不中才落回 LLM 提取。
        deterministicInventoryBatch = tryParseInventoryRecords(message);
        if (!deterministicInventoryBatch) {
          deterministicInventory = tryParseInventoryRecord(message);
        }
      } else if (isCookingCapabilityQuery(message)) {
        // Router 已经把这句话判成「凭现在厨房里有什么能做啥」（task-router 第 1.5+ 步），
        // 意图不需要再让 classifyIntent 猜一次：直接锁定 REALITY_QUERY + ingredients，
        // 落进下方现成的「读库存 → 分析食材 → matchRecipes」链路。
        // 分类器依赖 API key / model，它一不可用，这条查询就会退化成没有库存依据的闲聊。
        intent = 'REALITY_QUERY';
        requiredData = ['ingredients'];
      } else {
        const intentResult = await classifyIntent(message);
        intent = intentResult.intent;
        requiredData = intentResult.requiredData;
      }
      
      // 如果 Intent 是 REALITY_RECORD，进行食材记录提取
      if (intent === 'REALITY_RECORD') {
        if (deterministicInventoryBatch) {
          draftList = deterministicInventoryBatch.map((item) => buildIngredientDraft(item));
          responseMessage = `好的，一共 ${draftList.length} 样食材，我列成一张卡。逐行确认，或者整组入库。`;
        } else {
          const extractedData =
            deterministicInventory ?? (await extractIngredientRecord(message));
          draft = buildIngredientDraft(extractedData);

          if (draft.status === 'collecting') {
            // 询问缺失字段
            responseMessage = `我已经记下你购买的信息。目前还需要确认：${fieldLabels(draft.missingFields)}是什么？`;
          } else if (draft.status === 'confirming') {
            // 只播报已知事实：价格/保质期缺失时不拼出 undefined，也不逼用户补表
            responseMessage = `好的，我确认一下：${describeKnownFacts(draft.data)}。信息正确吗？`;
          }
        }
      } else {
        // 非 REALITY_RECORD 的处理
        // 根据 Intent 加载所需的现实上下文数据
        const realityContext = loadRealityContext(requiredData, clientData);
        
        // 根据 Intent 构建不同的系统提示词
        let systemPrompt = '';
        
        // 提示词分支仍覆盖完整意图集合（REALITY_RECORD 已在上方提前返回处理）
        switch (intent as QingsheIntent) {
          case 'REALITY_RECORD':
            systemPrompt = `你是"轻舍 Qingshe"的 AI 生活助手。当前识别到用户意图是：REALITY_RECORD（现实生活记录）。
轻舍的使命是帮助用户更聪明地处理现实生活。用户正在记录现实生活发生的事情，但暂不自动写入数据库。
以下是系统实际读取到的用户真实生活数据。只有这些数据可以被视为用户现实情况。未提供的数据代表系统当前不知道，不允许推测或编造。

${formatRealityContext(realityContext)}

你主要帮助用户处理日常生活问题、食材利用、家庭资源管理、消费决策、生活提醒、家居问题、减少浪费和节省不必要的开支。

重要原则：
1. 不要假装知道用户现实生活中不存在的数据。
2. 如果系统提供了用户真实数据，必须优先基于这些数据回答。
3. 没有相关用户数据时不要编造。
4. 回答尽量实际、简洁、可执行。
5. 当前阶段只进行自然语言回复，不执行数据库写入。
6. 当前阶段不要输出 JSON。
7. 识别到这是记录类信息，可以确认或询问相关信息，但暂时不执行写入操作。`;
            break;
            
          case 'REALITY_QUERY':
            // 检查是否是食物相关的查询
            if (requiredData.includes("ingredients")) {
              // 如果是食物相关查询，使用专门的食品分析提示词
              const ingredientsAnalysis = realityContext.ingredients;
              
              if (ingredientsAnalysis && ingredientsAnalysis.availableIngredients.length > 0) {
                // 有食材数据，使用食品分析 + Recipe Match
                const { urgentIngredients, availableIngredients, expiredIngredients } = ingredientsAnalysis;
                
                // 构建食材描述
                let ingredientsDescription = "【用户真实冰箱数据】\n\n";
                
                // 可用食材
                if (availableIngredients.length > 0) {
                  ingredientsDescription += "可用食材：\n";
                  availableIngredients.forEach(ingredient => {
                    if (ingredient.daysUntilExpiry !== null) {
                      ingredientsDescription += `- ${ingredient.name}：剩余${ingredient.daysUntilExpiry}天过期\n`;
                    } else {
                      ingredientsDescription += `- ${ingredient.name}：保质期未知\n`;
                    }
                  });
                  ingredientsDescription += "\n";
                }
                
                // 临期食材（优先处理）
                if (urgentIngredients.length > 0) {
                  ingredientsDescription += "优先处理（临期食材）：\n";
                  urgentIngredients.forEach(ingredient => {
                    ingredientsDescription += `- ${ingredient.name}：距离过期${ingredient.daysUntilExpiry}天\n`;
                  });
                  ingredientsDescription += "\n";
                }
                
                // 已过期食材（不建议使用）
                if (expiredIngredients.length > 0) {
                  ingredientsDescription += "已过期，不建议使用：\n";
                  expiredIngredients.forEach(ingredient => {
                    ingredientsDescription += `- ${ingredient.name}\n`;
                  });
                  ingredientsDescription += "\n";
                }

                // 执行 Recipe Match
                const recipeMatches = matchRecipes(ingredientsAnalysis, QINGSCHE_RECIPES, safeUserRecipes);
                const topMatches = recipeMatches.slice(0, 5);
                const formattedMatches = formatRecipeMatches(topMatches);

                // 只有真正有可用食材匹配的候选才作为结构化推荐返回前端
                const validTopMatches = topMatches.filter(
                  (match) => match.availableIngredients.length > 0
                );
                if (validTopMatches.length > 0) {
                  recommendedRecipes = validTopMatches.map(toRecommendedRecipe);
                }
                
                systemPrompt = `你是轻舍 Qingshe 的现实生活解决助手。

用户询问吃什么、能做什么或如何利用冰箱食材时，必须遵循以下流程：

## 第一步：理解真实冰箱数据

只有系统提供的【用户真实冰箱数据】才能被视为用户真实拥有的食材。
不能假设用户拥有任何未提供的食材。

## 第二步：参考 Recipe Match 结果

系统已经通过确定性程序对所有菜谱进行了匹配计算。
你只能从以下 Recipe Match 结果中选择推荐菜谱，不能编造或推荐未出现在结果中的菜谱。
每个候选都标注了：已有食材、缺少/可能需要食材、临期食材、匹配分数、推荐原因。

${formattedMatches}

## 第三步：生成自然语言回答

请按以下结构组织回答，但保持自然、不要机械照搬：

1. 先说明冰箱情况：用户有什么、哪些需要优先处理。
2. 说明为什么优先处理临期食材（如果有）。
3. 推荐 1-3 个菜谱，每个推荐必须包含：
   - 菜名
   - 已有：必须从 Recipe Match 的 availableIngredients 中来
   - 可能缺少：必须从 Recipe Match 的 missingIngredients 中来，不要改写成"你缺少"，用"可能还需要"或"如果家里没有的话需要买"
   - 为什么推荐：说明匹配分数、是否使用临期食材、是否接近完整匹配
4. 如果缺少食材，只生成采购需求描述，不要推荐具体商店、超市或商品链接（因为"我的好店"数据尚未接入）。
5. 如果 Recipe Match 结果为空或匹配度都很低，请诚实说明，并建议用户先补充食材。

## 绝对禁止

- 不要凭空创造"用户已有食材"
- "已有"只能来自 Recipe Match 的 availableIngredients
- "缺少/可能需要"只能来自 Recipe Match 的 missingIngredients
- 不要使用过期食材（expiredIngredients）作为可用食材
- 不要输出 JSON，只输出自然语言
- 不要给出详细菜谱步骤（Execution Plan 尚未实现）
- 不要推荐具体商店或商品购买链接

以下是系统读取到的用户真实冰箱数据：

${ingredientsDescription}

记住：只有系统提供的数据才能被视为用户真实拥有的食材。未提供的数据不能说用户拥有。`;
              } else {
                // 没有食材数据
                systemPrompt = `你是"轻舍 Qingshe"的 AI 生活助手。当前识别到用户意图是：REALITY_QUERY（现实查询）。
                
用户询问关于食物的问题，但现在还没有获取到你的冰箱食材，所以不能根据你的真实库存推荐。如果你愿意，可以先告诉我冰箱里有什么，或者去「家」里添加食材。

以下是系统实际读取到的用户真实生活数据。只有这些数据可以被视为用户现实情况。未提供的数据代表系统当前不知道，不允许推测或编造。

${formatRealityContext(realityContext)}

你主要帮助用户处理日常生活问题、食材利用、家庭资源管理、消费决策、生活提醒、家居问题、减少浪费和节省不必要的开支。

重要原则：
1. 不要假装知道用户现实生活中不存在的数据。
2. 如果系统提供了用户真实数据，必须优先基于这些数据回答。
3. 没有相关用户数据时不要编造。
4. 回答尽量实际、简洁、可执行。
5. 当前阶段只进行自然语言回复，不执行数据库写入。
6. 当前阶段不要输出 JSON。
7. 优先使用提供的冰箱真实数据回答问题。`;
              }
            } else {
              // 非食物相关的查询
              systemPrompt = `你是"轻舍 Qingshe"的 AI 生活助手。当前识别到用户意图是：REALITY_QUERY（现实查询）。
轻舍的使命是帮助用户更聪明地处理现实生活。用户正在查询与自己真实生活数据相关的问题。
以下是系统实际读取到的用户真实生活数据。只有这些数据可以被视为用户现实情况。未提供的数据代表系统当前不知道，不允许推测或编造。

${formatRealityContext(realityContext)}

你主要帮助用户处理日常生活问题、食材利用、家庭资源管理、消费决策、生活提醒、家居问题、减少浪费和节省不必要的开支。

重要原则：
1. 不要假装知道用户现实生活中不存在的数据。
2. 如果系统提供了用户真实数据，必须优先基于这些数据回答。
3. 没有相关用户数据时不要编造。
4. 回答尽量实际、简洁、可执行。
5. 当前阶段只进行自然语言回复，不执行数据库写入。
6. 当前阶段不要输出 JSON。
7. 优先使用提供的冰箱真实数据回答问题。`;
            }
            break;
            
          case 'LIFE_SOLUTION':
            systemPrompt = `你是"轻舍 Qingshe"的 AI 生活助手。当前识别到用户意图是：LIFE_SOLUTION（生活解决方案）。
轻舍的使命是帮助用户更聪明地处理现实生活。用户正在寻求普通现实生活解决方案。
以下是系统实际读取到的用户真实生活数据。只有这些数据可以被视为用户现实情况。未提供的数据代表系统当前不知道，不允许推测或编造。

${formatRealityContext(realityContext)}

你主要帮助用户处理日常生活问题、食材利用、家庭资源管理、消费决策、生活提醒、家居问题、减少浪费和节省不必要的开支。

重要原则：
1. 不要假装知道用户现实生活中不存在的数据。
2. 如果系统提供了用户真实数据，必须优先基于这些数据回答。
3. 没有相关用户数据时不要编造。
4. 回答尽量实际、简洁、可执行。
5. 当前阶段只进行自然语言回复，不执行数据库写入。
6. 当前阶段不要输出 JSON。
7. 根据现实生活解决方案定位回答。当前没有知识库时可以使用 AI 自身知识，但不要假装知道用户现实数据。`;
            break;
            
          case 'EMOTIONAL_REDIRECT':
            systemPrompt = `你是"轻舍 Qingshe"的 AI 生活助手。当前识别到用户意图是：EMOTIONAL_REDIRECT（情绪引导）。
轻舍的使命是帮助用户更聪明地处理现实生活。用户表达了焦虑、烦躁、低落等日常情绪，希望获得生活化回应并引导回现实行动。
以下是系统实际读取到的用户真实生活数据。只有这些数据可以被视为用户现实情况。未提供的数据代表系统当前不知道，不允许推测或编造。

${formatRealityContext(realityContext)}

你主要帮助用户处理日常生活问题、食材利用、家庭资源管理、消费决策、生活提醒、家居问题、减少浪费和节省不必要的开支。

重要原则：
1. 不要假装知道用户现实生活中不存在的数据。
2. 如果系统提供了用户真实数据，必须优先基于这些数据回答。
3. 没有相关用户数据时不要编造。
4. 回答尽量实际、简洁、可执行。
5. 当前阶段只进行自然语言回复，不执行数据库写入。
6. 当前阶段不要输出 JSON。
7. 保持轻舍特色：可以有轻松、有趣的回应，但不要进行心理治疗或假装专业诊断。最终应该尝试引导用户回到现实生活行动。如果有冰箱数据，可以适度结合真实食材；没有数据不要编造。`;
            break;
            
          case 'UNSUPPORTED':
            systemPrompt = `你是"轻舍 Qingshe"的 AI 生活助手。当前识别到用户意图是：UNSUPPORTED（不支持的问题）。
轻舍的使命是帮助用户更聪明地处理现实生活。用户提出了与轻舍现实生活助手定位无关的问题。
以下是系统实际读取到的用户真实生活数据。只有这些数据可以被视为用户现实情况。未提供的数据代表系统当前不知道，不允许推测或编造。

${formatRealityContext(realityContext)}

你主要帮助用户处理日常生活问题、食材利用、家庭资源管理、消费决策、生活提醒、家居问题、减少浪费和节省不必要的开支。

重要原则：
1. 不要假装知道用户现实生活中不存在的数据。
2. 如果系统提供了用户真实数据，必须优先基于这些数据回答。
3. 没有相关用户数据时不要编造。
4. 回答尽量实际、简洁、可执行。
5. 当前阶段只进行自然语言回复，不执行数据库写入。
6. 当前阶段不要输出 JSON。
7. 不要回答用户原问题，统一告诉用户：
"这个问题暂时不属于轻舍的服务范围。轻舍主要帮助你处理现实生活中的问题，比如家庭管理、吃什么、怎么买、怎么省、怎么利用已有资源等。如果你觉得这个问题也值得轻舍未来支持，可以通过反馈告诉我们。"`;
            break;
            
          default:
            systemPrompt = `你是"轻舍 Qingshe"的 AI 生活助手。轻舍的使命是帮助用户更聪明地处理现实生活。以下是系统实际读取到的用户真实生活数据。只有这些数据可以被视为用户现实情况。未提供的数据代表系统当前不知道，不允许推测或编造。

${formatRealityContext(realityContext)}

你主要帮助用户处理日常生活问题、食材利用、家庭资源管理、消费决策、生活提醒、家居问题、减少浪费和节省不必要的开支。

重要原则：
1. 不要假装知道用户现实生活中不存在的数据。
2. 如果系统提供了用户真实数据，必须优先基于这些数据回答。
3. 没有相关用户数据时不要编造。
4. 回答尽量实际、简洁、可执行。
5. 当前阶段只进行自然语言回复，不执行数据库写入。
6. 当前阶段不要输出 JSON。`;
        }

        // 使用统一的AI服务调用
        try {
          responseMessage = await chatWithAI({
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: message }
            ],
            temperature: 0.7,
            maxTokens: 256
          });
        } catch (error) {
          console.error('AI service call failed:', {
            errorInfo: error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                  cause: error instanceof Error ? error.cause : undefined,
                }
              : {
                  message: String(error),
                }
          });
          
          return Response.json(
            { error: 'AI request failed' },
            { status: 500 }
          );
        }
      }
    }

    // 返回最终响应
    const responsePayload: ChatApiResponse = { 
      response: responseMessage,
      intent,
      requiredData,
      ...(draft && { draft }),
      ...(draftList && draftList.length > 0 ? { drafts: draftList } : {}),
      ...(recommendedRecipes && { recipeMatches: recommendedRecipes })
    };

    return Response.json(responsePayload);
  } catch (error) {
    console.error('Error calling AI API:', {
      errorInfo: error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
            cause: error instanceof Error ? error.cause : undefined,
          }
        : {
            message: String(error),
          }
    });

    // 返回通用错误信息，不暴露敏感信息
    return Response.json(
      { error: 'Failed to get response from AI service' },
      { status: 500 }
    );
  }
}

/**
 * 食材草稿的文案原语。
 *
 * 首次提取、补字段后重确认、被驳回后重确认 —— 三条分支必须说同一套话。
 * 之前分叉的代价已经出现过一次：「只播报已知事实」只落在两处，
 * 第三处仍会拼出 `undefined元` 和 `保质期未知到期`。
 */
const MISSING_FIELD_LABELS: Record<string, string> = {
  name: '名称',
  price: '价格',
  expiryDate: '保质期'
};

function fieldLabels(missingFields: string[]): string {
  return missingFields.map((field) => MISSING_FIELD_LABELS[field] ?? field).join('、');
}

/**
 * 只播报草稿里真实存在的字段。
 * 缺失的价格 / 保质期 / 位置一律不提 —— 不占位、不补默认值、不逼用户补表。
 */
function describeKnownFacts(data: IngredientRecordData): string {
  const today = new Date().toISOString().split('T')[0];
  const boughtAt = data.purchaseDate
    ? data.purchaseDate === today
      ? '今天买的'
      : `${data.purchaseDate}买的`
    : '';
  const spec = data.quantity ? ` ×${data.quantity}${data.unit ?? ''}` : '';

  return [
    `${boughtAt}${data.name || '这笔'}${spec}`,
    data.price ? `${data.price}元` : '',
    data.location ? `放在${data.location}` : '',
    data.expiryDate ? `${data.expiryDate}到期` : ''
  ]
    .filter(Boolean)
    .join('，');
}

/**
 * 冰箱入库的落地指令。
 *
 * 卡片按钮与自然语言口令必须写出同一条记录 —— 之前两处各写一份字段映射，
 * 任何一处补字段（比如 storageLocation）都会悄悄漏掉另一处。
 */
/** 单条食材 → 库存记录字段。单条入库与批量入库共用这一份映射，杜绝两处漂移。 */
function ingredientRecord(data: IngredientRecordData): Record<string, unknown> {
  return {
    name: data.name,
    quantity: data.quantity ? String(data.quantity) : '1',
    unit: data.unit || '',
    category: data.category || '其他',
    purchaseDate: data.purchaseDate,
    expiryDate: data.expiryDate || '',
    storageLocation: data.location || '冷藏'
  };
}

function ingredientSavePayload(data: IngredientRecordData): ChatApiResponse {
  return {
    response: '已确认，已帮你加入冰箱。',
    intent: 'REALITY_RECORD',
    requiredData: [],
    action: 'SAVE_INGREDIENT',
    ingredient: ingredientRecord(data)
  };
}

/**
 * 批量冰箱入库（P0.5-1）：一张多行卡「全部加入」= 一次请求、一次落盘。
 * 任何一行不满足入库条件就整组不写 —— 存一半、留一半卡是最难收拾的状态，
 * 不如退回原文让用户重新确认。
 *
 * activeTask 与单条卡同权原样回传：整组入库也不该顺手结束另一张卡的采购会话。
 */
function ingredientBatchSavePayload(
  drafts: IngredientRecordDraft[],
  activeTask: ActiveTaskSnapshot | null
): ChatApiResponse {
  const session = { activeTask };
  const saveable = drafts.filter(
    (d) => d?.status === 'confirming' && !!d.data?.name && !!d.data?.purchaseDate
  );
  if (drafts.length === 0 || saveable.length !== drafts.length) {
    return {
      response: '这张清单里还有信息没补齐，先补完再确认入库。',
      intent: 'REALITY_RECORD',
      requiredData: [],
      ...session
    };
  }
  return {
    response: `已确认，${drafts.length} 样食材都进冰箱了。`,
    intent: 'REALITY_RECORD',
    requiredData: [],
    action: 'SAVE_INGREDIENTS',
    ingredients: drafts.map((d) => ingredientRecord(d.data)),
    ...session
  };
}

/**
 * 食材确认卡按钮的响应。
 *
 * 只操作按钮指向的那条食材草稿，绝不触碰 activeTask：即使当前 activeTask
 * 是另一张卡正在等的采购会话，点「取消番茄」也只能取消番茄。
 * activeTask 原样回传，前端据此保持它不被这次点击结束。
 */
function ingredientCardResponse(
  command: CardCommand,
  draft: IngredientRecordDraft | undefined,
  activeTask: ActiveTaskSnapshot | null
): ChatApiResponse {
  const session = { activeTask };

  if (!draft) {
    // 快照已过期（多半是重复点击或刷新后残留）：什么都不写，卡片随之收敛。
    return {
      response: '这条食材记录已经处理过了。',
      intent: 'REALITY_RECORD',
      requiredData: [],
      ...session
    };
  }

  if (command === 'cancel') {
    return {
      response: '好的，已取消添加这条食材记录。',
      intent: 'REALITY_RECORD',
      requiredData: [],
      ...session
    };
  }

  const saveable =
    draft.status === 'confirming' && !!draft.data.name && !!draft.data.purchaseDate;
  if (!saveable) {
    // 卡片与服务器状态不一致：不猜、不写，把草稿原样退回，卡片停在待补状态。
    return {
      response: '这条食材还差一点信息，先把它补完再确认。',
      intent: 'REALITY_RECORD',
      requiredData: [],
      draft,
      ...session
    };
  }

  return { ...ingredientSavePayload(draft.data), ...session };
}

/** 有名字就带括号，没名字就别拼出空的「（）」 */
function withName(label: string, name: string): string {
  return name ? `${label}（${name}）` : label;
}

/**
 * 这条纯文字口令能指向几个待确认对象。
 *
 * 只有整句就是「确认 / 取消」口令时才可能歧义 —— 其余表达各有自己的语义通道，
 * 不会被这条规则拦下。0 或 1 个时沿用既有优先级继续执行；2 个以上说明服务端
 * 无法判断用户说的是哪张卡，必须停下来问，而不是替用户选一个去写真实数据。
 *
 * 按钮走不到这里：它自带 target，在上面就短路了。
 */
function pendingTargetsOf(
  message: string,
  currentDraft: IngredientRecordDraft | undefined,
  activeTask: ActiveTaskSnapshot | undefined
): string[] {
  if (!readCardCommand(message)) return [];

  const targets: string[] = [];
  if (currentDraft) {
    targets.push(
      withName(
        `食材${currentDraft.status === 'confirming' ? '入库' : '记录'}`,
        currentDraft.data.name ?? ''
      )
    );
  }

  const card = pendingCardOf(activeTask);
  if (card === 'shopping') {
    targets.push(
      withName('采购清单', (activeTask?.shoppingDrafts ?? []).map((i) => i.name).join('、'))
    );
  } else if (card === 'consumable') {
    targets.push(
      withName('消耗品登记', (activeTask?.consumableDrafts ?? []).map((i) => i.name).join('、'))
    );
  }

  return targets;
}

/** 当前有哪些待确认对象可以被丢弃：食材草稿 + 至多一张卡片（activeTask 只有一个 taskType） */
function pendingDiscardKinds(
  currentDraft: IngredientRecordDraft | undefined,
  activeTask: ActiveTaskSnapshot | undefined
): DiscardTarget[] {
  const kinds: DiscardTarget[] = [];
  if (currentDraft) kinds.push('ingredient');
  const card = pendingCardOf(activeTask);
  if (card === 'shopping') kinds.push('shopping');
  else if (card === 'consumable') kinds.push('consumable');
  return kinds;
}

/**
 * 丢弃响应：三种对象共用一条原则 —— 只翻卡片状态，绝不写真实数据。
 * 卡片/草稿的取消由前端执行与按钮同一个 cancel 函数；食材草稿靠「无 draft 返回」清除。
 */
function discardResponse(
  target: DiscardTarget,
  activeTask: ActiveTaskSnapshot | undefined
): ChatApiResponse {
  if (target === 'ingredient') {
    return {
      response: '好的，已取消添加这条食材记录。',
      intent: 'REALITY_RECORD',
      requiredData: [],
      // activeTask 原样带回：取消食材草稿不该顺手结束采购会话
      activeTask: activeTask ?? null
    };
  }

  const extraction: AITaskExtraction = {
    intent: {
      taskType: target === 'shopping' ? 'add_shopping_item' : 'add_consumable',
      confidence: 0.98,
      reason: '对象词取消口令：等价于点击卡片取消按钮'
    },
    drafts: { items: [] },
    replyText: target === 'shopping' ? '好，这次先不加。' : '好，这次先不登记。',
    requiresConfirmation: true,
    cardCommand: 'cancel',
    ...(target === 'consumable' ? { consumablePhase: 'collecting' as const } : {})
  };
  return target === 'shopping'
    ? buildShoppingResponse(extraction)
    : buildConsumableResponse(extraction);
}

// 辅助函数：add_consumable 的统一响应形状（首次提取与多轮续采共用同一套契约）
/** 这两个构建器总会带上 task 负载 —— 卡片口令要在 task 上追加字段，契约得写清楚 */
type TaskResponse = Omit<ChatApiResponse, 'task'> & {
  task: NonNullable<ChatApiResponse['task']>;
};

function buildConsumableResponse(extraction: AITaskExtraction): TaskResponse {
  const items =
    ((extraction.drafts as { items?: ConsumableDraft[] }).items ?? []);
  return {
    response: extraction.replyText,
    intent: 'REALITY_RECORD_CONSUMABLE',
    requiredData: [],
    task: {
      taskType: 'add_consumable',
      confidence: extraction.intent.confidence,
      reason: extraction.intent.reason,
      requiresConfirmation: true,
      consumableDrafts: items,
      consumablePhase: extraction.consumablePhase,
      // 口令等价物（取消/确认）由守卫或续采写进 extraction，这里透传给前端
      ...(extraction.cardCommand ? { cardCommand: extraction.cardCommand } : {})
    }
  };
}

// 辅助函数：add_shopping_item 的统一响应形状（首次提取与续采补全共用同一套契约）
function buildShoppingResponse(extraction: AITaskExtraction): TaskResponse {
  const shoppingDrafts =
    ((extraction.drafts as { items?: ShoppingItemDraft[] }).items ?? []);
  return {
    response: extraction.replyText,
    intent: 'REALITY_RECORD_SHOPPING',
    requiredData: [],
    task: {
      taskType: 'add_shopping_item',
      confidence: extraction.intent.confidence,
      reason: extraction.intent.reason,
      requiresConfirmation: true,
      shoppingDrafts,
      ...(extraction.cardCommand ? { cardCommand: extraction.cardCommand } : {})
    }
  };
}

/**
 * complete_purchase 的统一响应形状：清单条目 → 入库草稿。
 *
 * 不造第二套确认卡 —— 草稿走 ChatApiResponse.drafts，前端渲染的仍是 IngredientConfirmCard，
 * 确认后走的仍是 SAVE_INGREDIENTS → commitIngredients（现读后追加，不覆盖确认期间别人的入库）。
 * 这里也不问「多久用完」和存放位置：采购完成不需要那些字段，草稿形状与采购清单页
 * 同一条链路，都由 record.ts 的 shoppingItemToRestockDraft 生成。
 *
 * 唯一多出来的是 restockAnchors：冰箱卡只知道往库存里加东西，不知道该把哪几条清单
 * 条目打上 restockedAt。锚点与草稿一一对应，落盘留在前端确认成功之后 —— 服务端
 * 不落盘，写失败的卡留在原位，清单也不该被提前标记。
 */
function buildRestockResponse(extraction: AITaskExtraction): TaskResponse {
  const items = (extraction.drafts as { items?: RestockItemDraft[] }).items ?? [];
  // 不另写「能不能入库」的判断：那条规则只有 shoppingItemToRestockDraft 一份。
  // flatMap 顺带保证 anchors 与 drafts 来自同一批行，不会各滤各的。
  const rows = items.flatMap((item) => {
    const draft = shoppingItemToRestockDraft({ ...item, status: 'purchased' });
    return draft
      ? [{ draft, anchor: { listId: item.listId, itemId: item.id, name: item.name } }]
      : [];
  });

  if (rows.length === 0) {
    // Router 判定是采购完成，但清单上一条都对不上：只回执，不出卡、不写任何东西。
    return {
      response: '好的，买回来就好。这次清单上没找到对应的东西，你说名字我再帮你入库。',
      intent: 'REALITY_RECORD_SHOPPING',
      requiredData: [],
      task: {
        taskType: 'complete_purchase',
        confidence: extraction.intent.confidence,
        reason: extraction.intent.reason,
        requiresConfirmation: false
      }
    };
  }

  return {
    response: extraction.replyText,
    intent: 'REALITY_RECORD_SHOPPING',
    requiredData: [],
    drafts: rows.map((row) => row.draft),
    restockAnchors: rows.map((row) => row.anchor),
    task: {
      taskType: 'complete_purchase',
      confidence: extraction.intent.confidence,
      reason: extraction.intent.reason,
      requiresConfirmation: true
    }
  };
}

// 辅助函数：格式化现实上下文数据以便提供给 AI
function formatRealityContext(context: RealityContext): string {
  const lines: string[] = [];

  if (context.ingredients !== undefined) {
    if (context.ingredients === null) {
      lines.push("冰箱食材数据：系统当前没有获取到用户冰箱数据。");
    } else {
      lines.push(`冰箱食材数据：${JSON.stringify(context.ingredients, null, 2)}`);
    }
  }

  if (context.home_items !== undefined) {
    if (context.home_items === null) {
      lines.push("家中物品数据：系统当前没有获取到用户家中物品数据。");
    } else {
      lines.push(`家中物品数据：${JSON.stringify(context.home_items, null, 2)}`);
    }
  }

  if (context.consumables !== undefined) {
    if (context.consumables === null) {
      lines.push("消耗品数据：系统当前没有获取到用户消耗品数据。");
    } else {
      lines.push(`消耗品数据：${JSON.stringify(context.consumables, null, 2)}`);
    }
  }

  if (context.favorite_places !== undefined) {
    if (context.favorite_places === null) {
      lines.push("常去地点数据：系统当前没有获取到用户常去地点数据。");
    } else {
      lines.push(`常去地点数据：${JSON.stringify(context.favorite_places, null, 2)}`);
    }
  }

  if (context.reminders !== undefined) {
    if (context.reminders === null) {
      lines.push("提醒事项数据：系统当前没有获取到用户提醒事项数据。");
    } else {
      lines.push(`提醒事项数据：${JSON.stringify(context.reminders, null, 2)}`);
    }
  }

  if (context.preferences !== undefined) {
    if (context.preferences === null) {
      lines.push("偏好设置数据：系统当前没有获取到用户偏好设置数据。");
    } else {
      lines.push(`偏好设置数据：${JSON.stringify(context.preferences, null, 2)}`);
    }
  }

  if (context.family_members !== undefined) {
    if (context.family_members === null) {
      lines.push("家庭成员数据：系统当前没有获取到用户家庭成员数据。");
    } else {
      lines.push(`家庭成员数据：${JSON.stringify(context.family_members, null, 2)}`);
    }
  }

  return lines.join('\n');
}

/**
 * 将 RecipeMatch 详情转换为前端可用的轻量化推荐结构
 */
function toRecommendedRecipe(match: RecipeMatchDetail): RecommendedRecipe {
  return {
    recipeId: match.recipe.id,
    title: match.recipe.title,
    description: match.recipe.description,
    estimatedTime: match.recipe.estimatedTime,
    difficulty: match.recipe.difficulty,
    availableIngredients: match.availableIngredients,
    missingIngredients: match.missingIngredients,
    urgentIngredientsUsed: match.urgentIngredientsUsed,
    matchScore: match.matchScore,
    sourceType: match.recipe.sourceType
  };
}