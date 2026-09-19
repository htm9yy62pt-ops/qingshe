import { RealityDataType } from './intent';
import { analyzeFoodIngredients, FoodAnalysis } from './food-analysis';

export interface RealityContext {
  ingredients?: FoodAnalysis | null;
  home_items?: any[] | null;
  consumables?: any[] | null;
  favorite_places?: any[] | null;
  reminders?: any[] | null;
  preferences?: any | null;
  family_members?: any[] | null;
}

export function loadRealityContext(
  requiredData: RealityDataType[],
  clientData: any
): RealityContext {
  const context: RealityContext = {};

  // Only load data that is requested and available in clientData
  if (requiredData.includes("ingredients")) {
    // Check if ingredients exist in clientData
    if (clientData.ingredients && Array.isArray(clientData.ingredients) && clientData.ingredients.length > 0) {
      // Analyze the ingredients to get structured data
      context.ingredients = analyzeFoodIngredients(clientData.ingredients);
    } else {
      // No ingredients available
      context.ingredients = null;
    }
  }

  if (requiredData.includes("home_items")) {
    // Future implementation - currently not available in clientData
    context.home_items = null;
  }

  if (requiredData.includes("consumables")) {
    // route.ts 把请求瞬间的消耗品快照放进 clientData.consumables。
    // 有快照 → 原样透传给 prompt；空 / 缺失 → null（「系统没有获取到」），不凭空造数据。
    if (clientData.consumables && Array.isArray(clientData.consumables) && clientData.consumables.length > 0) {
      context.consumables = clientData.consumables;
    } else {
      context.consumables = null;
    }
  }

  if (requiredData.includes("favorite_places")) {
    // Future implementation - currently not available in clientData
    context.favorite_places = null;
  }

  if (requiredData.includes("reminders")) {
    // Future implementation - currently not available in clientData
    context.reminders = null;
  }

  if (requiredData.includes("preferences")) {
    // Future implementation - currently not available in clientData
    context.preferences = null;
  }

  if (requiredData.includes("family_members")) {
    // Future implementation - currently not available in clientData
    context.family_members = null;
  }

  return context;
}