'use client';

import { useMemo } from 'react';
import { RecipeExecution, ExecutionStatus } from '@/lib/types/execution';
import { RecipeStep } from '@/lib/types/recipe';

interface RecipeExecutionPanelProps {
  execution: RecipeExecution;
  steps: RecipeStep[];
  onUpdate: (execution: RecipeExecution) => void;
  onRequestConfirm?: () => void;
  onCancel?: () => void;
}

const STATUS_LABEL: Record<ExecutionStatus, string> = {
  preparing: '准备中',
  cooking: '制作中',
  completed: '已完成',
  cancelled: '已取消'
};

export function RecipeExecutionPanel({
  execution,
  steps,
  onUpdate,
  onRequestConfirm,
  onCancel
}: RecipeExecutionPanelProps) {
  const { currentStepIndex, status } = execution;

  const progressText = useMemo(() => {
    if (status === 'completed') return '全部步骤已完成';
    if (currentStepIndex < 0) return `共 ${steps.length} 步，点击“下一步”开始`;
    return `第 ${currentStepIndex + 1} / ${steps.length} 步`;
  }, [currentStepIndex, status, steps.length]);

  const currentStep = steps[currentStepIndex];

  const handleNext = () => {
    const nextIndex = currentStepIndex + 1;
    if (nextIndex >= steps.length) return;

    onUpdate({
      ...execution,
      status: 'cooking',
      currentStepIndex: nextIndex
    });
  };

  const handlePrev = () => {
    const prevIndex = currentStepIndex - 1;
    if (prevIndex < -1) return;

    onUpdate({
      ...execution,
      status: prevIndex < 0 ? 'preparing' : 'cooking',
      currentStepIndex: prevIndex
    });
  };

  const handleCancel = () => {
    onUpdate({
      ...execution,
      status: 'cancelled'
    });
    onCancel?.();
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">{execution.title}</h2>
          <p className="mt-1 text-sm text-gray-500">{progressText}</p>
        </div>
        <span
          className={`text-xs px-2 py-1 rounded ${
            status === 'completed'
              ? 'bg-green-100 text-green-800'
              : status === 'cancelled'
              ? 'bg-gray-100 text-gray-700'
              : 'bg-blue-100 text-blue-800'
          }`}
        >
          {STATUS_LABEL[status]}
        </span>
      </div>

      {currentStep ? (
        <div className="mt-5 bg-amber-50 rounded-lg p-4">
          <div className="text-xs text-amber-700 font-medium mb-1">
            步骤 {currentStep.step}
          </div>
          <p className="text-base text-gray-900 leading-relaxed">{currentStep.content}</p>
        </div>
      ) : status !== 'completed' ? (
        <div className="mt-5 bg-gray-50 rounded-lg p-4 text-sm text-gray-600">
          准备开始制作。确认食材和工具就绪后，点击“下一步”。
        </div>
      ) : (
        <div className="mt-5 bg-green-50 rounded-lg p-4 text-sm text-green-800">
          已完成全部制作步骤。可以选择关闭，或继续浏览其他推荐。
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handlePrev}
          disabled={currentStepIndex < 0}
          className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
        >
          上一步
        </button>

        {currentStepIndex < steps.length - 1 ? (
          <button
            type="button"
            onClick={handleNext}
            className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600"
          >
            下一步
          </button>
        ) : (
          <button
            type="button"
            onClick={onRequestConfirm}
            disabled={status === 'completed'}
            className="px-4 py-2 rounded-lg bg-green-500 text-white hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            完成制作
          </button>
        )}

        <button
          type="button"
          onClick={handleCancel}
          className="ml-auto px-4 py-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100"
        >
          取消
        </button>
      </div>
    </div>
  );
}