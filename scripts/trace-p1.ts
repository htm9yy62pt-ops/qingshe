/**
 * P1 真实链路 Trace
 *
 * harness 只断言了 parser，真实 UI 走的是 route handler 整条分支。
 * 这里直接调用编译后的 POST handler，请求体与 src/app/page.tsx 发出的完全一致，
 * 不经过 HTTP 端口（沙箱内无法 listen），因此执行的就是线上同一条代码路径。
 *
 * 离线环境下 AMD 端点不可达：一旦响应为 500，即证明该分支真的调用了 LLM（Thinking）。
 */

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/ai/chat/route';

process.env.AMD_AI_API_KEY = process.env.AMD_AI_API_KEY || 'trace-offline-key';
process.env.AMD_AI_MODEL = process.env.AMD_AI_MODEL || 'trace-offline-model';

const BASE = { ingredients: [], myRecipes: [], consumables: [] };

async function call(label: string, payload: Record<string, unknown>) {
  const req = new NextRequest('http://localhost/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...BASE, ...payload })
  });

  const started = Date.now();
  const res = await POST(req);
  const json = (await res.json()) as Record<string, unknown>;
  const elapsed = Date.now() - started;

  const draft = json.draft as { status?: string; missingFields?: string[] } | undefined;
  const llmCalled = res.status === 500;

  console.log(`\n--- ${label} (${elapsed}ms) ---`);
  line('HTTP', res.status);
  line('intent', json.intent);
  line('response', json.response);
  line('draft.status', draft?.status);
  line('draft.missingFields', draft?.missingFields);
  line('action', json.action);
  if (llmCalled) console.log('  >> 500 = 该分支真的调用了 LLM（离线端点不可达）');
  return json;
}

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(20)} ${JSON.stringify(value)}`);
}

async function main() {
  const msg = '今天买了2个番茄';

  // Step 1：干净会话首条明确录入
  const first = (await call('Step 1  干净会话 · 「今天买了2个番茄」', {
    message: msg,
    activeTask: null
  })) as { draft?: { status: string; missingFields: string[]; data: unknown } };

  // Step 2：把 Step 1 返回的 draft 原样回传（= page.tsx 持久化后的第二轮）
  await call('Step 2  带上一条 collecting draft · 同一句重新录入', {
    message: msg,
    activeTask: null,
    currentDraft: first.draft
  });

  // Step 3：active shopping session 是否吞掉新现实录入
  await call('Step 3  active shopping session · 「今天买了2个番茄」', {
    message: msg,
    activeTask: {
      taskType: 'add_shopping_item',
      drafts: [{ name: '牙膏', quantity: 1, unit: '支' }],
      missingFields: [],
      turnCount: 1
    }
  });

  // Step 4：裸食材名
  await call('Step 4  干净会话 · 「番茄」', { message: '番茄', activeTask: null });

  // Step 5：确认卡片后回「确认」→ 应产出 SAVE_INGREDIENT
  const card = (await call('Step 5  干净会话 · 「买了三斤五花肉」（模拟卡片确认前）', {
    message: '买了三斤五花肉',
    activeTask: null
  })) as { draft?: unknown };

  await call('Step 6  对上述 draft 回「确认」', {
    message: '确认',
    activeTask: null,
    currentDraft: card.draft
  });
}

main().catch((err) => {
  console.error('TRACE FAILED:', err);
  process.exit(1);
});