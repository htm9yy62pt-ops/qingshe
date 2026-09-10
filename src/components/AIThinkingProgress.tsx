'use client';

import { useEffect, useRef, useState } from 'react';
import { ThinkingTask, ThinkingScenario, getThinkingTasks } from '@/lib/ai/thinking-tasks';

interface AIThinkingProgressProps {
  scenario: ThinkingScenario;
}

/**
 * 单个 pending assistant bubble 内部使用的 Thinking Progress。
 *
 * 规则（Fix 4B）：
 * - 每次只显示一个 step，不显示完整列表。
 * - 不写入 ChatMessage，不写入 localStorage。
 * - 每个 instance 独立运行 timer（多个 pending request 互不干扰）。
 * - 任务停留时间约 3000ms（区间 2500~4000ms）。
 * - 不循环播放：到最后一个 task 后保持该状态，等待 AI 返回。
 * - useEffect cleanup 释放 timer。
 * - component unmount 时立即停止（pending bubble 切换为 completed/failed 时即触发）。
 */
const TASK_DURATION_MS = 3000;

export function AIThinkingProgress({ scenario }: AIThinkingProgressProps) {
  const tasks = getThinkingTasks(scenario);
  const [index, setIndex] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // scenario 变化时重置进度
  useEffect(() => {
    setIndex(0);
  }, [scenario]);

  useEffect(() => {
    if (tasks.length === 0) return;
    if (index >= tasks.length - 1) {
      // 已经在最后一个 task，保持现状，等待 AI 返回或 unmount
      return;
    }
    timeoutRef.current = setTimeout(() => {
      setIndex((prev) => Math.min(prev + 1, tasks.length - 1));
    }, TASK_DURATION_MS);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [index, tasks]);

  if (tasks.length === 0) return null;
  const label = tasks[index]?.label ?? '';

  return (
    <span className="inline-flex items-center gap-2 text-gray-500">
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse"
      />
      <span>{label}</span>
    </span>
  );
}