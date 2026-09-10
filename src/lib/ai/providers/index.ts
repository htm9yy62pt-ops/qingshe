import type { AIProvider } from './types';
import { AMDProvider } from './amd';

/**
 * AI Provider 工厂函数
 * 
 * 现在：Data Source = localStorage
 * 未来：Data Source = Qingshe Database
 * AI Provider 永远不直接访问 Data Source
 */
export function getAIProvider(): AIProvider {
  const providerType = process.env.AI_PROVIDER || 'amd'; // 默认使用AMD

  switch (providerType.toLowerCase()) {
    case 'amd':
      return new AMDProvider();
    default:
      return new AMDProvider(); // 默认使用AMD
  }
}