import type { AIProvider } from './types';
import { AMDProvider } from './amd';
import { getAIProviderName } from './config';

/**
 * AI Provider 工厂函数
 * 
 * 现在：Data Source = localStorage
 * 未来：Data Source = Qingshe Database
 * AI Provider 永远不直接访问 Data Source
 */
export function getAIProvider(): AIProvider {
  // provider 名的缺省值与大小写归一统一走 config，工厂不再直接读环境变量
  const providerType = getAIProviderName();

  switch (providerType) {
    case 'amd':
      return new AMDProvider();
    default:
      // 未知 provider 不许静默 fallback 到 AMD，否则配置错误会被当成正常请求发出去
      throw new Error(`Unsupported AI provider: ${providerType}`);
  }
}