import type { IngredientRecordData, IngredientRecordDraft } from '@/lib/ai/record';

/**
 * 食材确认卡。纯展示：草稿由宿主提供，按钮把点击回传给宿主处理。
 *
 * 首页（消息级）与采购清单页（已购入库）共用这一张卡，
 * 不存在第二套库存确认 UI。卡片只在草稿未消费时由宿主渲染，
 * 消费即由宿主移除，因此组件自身不需要禁用态。
 *
 * 两种形状，一套链路（P0.5-1）：
 * - draft：单条，维持原有整卡确认。
 * - drafts：批量。每行可单独入库，也可以整组确认；确认动作逐行回传
 *   给宿主，宿主对每行执行的都是同一条 SAVE_INGREDIENT 链路 ——
 *   批量只是卡的形状，不是第二套状态机。
 */
export function IngredientConfirmCard({
  draft,
  drafts,
  onConfirm,
  onCancel,
  onRemove
}: {
  draft?: IngredientRecordDraft;
  drafts?: IngredientRecordDraft[];
  onConfirm: (target?: IngredientRecordDraft) => void;
  onCancel: () => void;
  /** 批量模式专用：把第 index 行从卡上请出去（不入库、不发请求） */
  onRemove?: (index: number) => void;
}) {
  // 单条模式：原样整卡确认
  if (draft) {
    return (
      <div className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50 p-3">
        <div className="text-xs font-medium text-emerald-900">加入厨房</div>
        <IngredientFacts data={draft.data} />
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => onConfirm(draft)}
            className="flex-1 rounded-md bg-emerald-600 px-3 py-2 text-sm text-white"
          >
            确认加入
          </button>
          <button
            onClick={onCancel}
            className="rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm text-emerald-800"
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  const rows = drafts ?? [];
  if (rows.length === 0) return null;

  // 批量模式：一行一条。入库永远整组一次提交（同一条 SAVE 链路的批量形态）；
  // 单行「移除」只是把条目请出这张卡，不碰库存，也不产生任何请求。
  return (
    <div className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50 p-3">
      <div className="text-xs font-medium text-emerald-900">
        加入厨房 · {rows.length} 项
      </div>
      <div className="mt-1 divide-y divide-emerald-100">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2 py-1.5">
            <div className="min-w-0 flex-1">
              <IngredientFacts data={row.data} compact />
            </div>
            {rows.length > 1 ? (
              <button
                onClick={() => onRemove?.(index)}
                aria-label={`移除 ${row.data.name ?? '该行'}`}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-emerald-500 hover:bg-emerald-100"
              >
                移除
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => onConfirm()}
          className="flex-1 rounded-md bg-emerald-600 px-3 py-2 text-sm text-white"
        >
          全部加入（{rows.length}）
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm text-emerald-800"
        >
          整组取消
        </button>
      </div>
    </div>
  );
}

function IngredientFacts({
  data,
  compact = false
}: {
  data: IngredientRecordData;
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact
          ? 'flex flex-wrap gap-x-2 text-sm text-emerald-800'
          : 'mt-1 flex flex-wrap gap-x-3 text-sm text-emerald-800'
      }
    >
      <span>{data.name}</span>
      {/* 储存位置只回显用户说出口的区域，没说就是「未指定」。
          落库时 Reality 层仍会兜底一个默认位置，那是下一阶段的口径，卡片不替它圆场。 */}
      <span className={data.location ? undefined : 'text-emerald-600'}>
        {data.quantity ? `${data.quantity}${data.unit || '份'} · ` : ''}
        {data.location ?? '未指定'}
      </span>
      {data.purchaseDate ? <span>{data.purchaseDate} 购入</span> : null}
      {data.expiryDate ? (
        <span>{data.expiryDate} 到期</span>
      ) : compact ? null : (
        <span className="text-emerald-600">保质期未记录</span>
      )}
    </div>
  );
}