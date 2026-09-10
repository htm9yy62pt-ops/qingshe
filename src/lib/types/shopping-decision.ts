import { LifeResourceType } from '@/lib/types/life-resource';

export type ShoppingDecisionMode = 'immediate' | 'planned';

export type ShoppingRecommendationReason =
  | 'matching_tag'
  | 'favorite'
  | 'store_type'
  | 'general';

export interface ShoppingResourceMatch {
  resourceId: string;
  resourceName: string;
  resourceType: LifeResourceType;
  matchedItems: string[];
  score: number;
  reasons: ShoppingRecommendationReason[];
}

export interface ShoppingDecision {
  shoppingListId: string;
  immediateOptions: ShoppingResourceMatch[];
  plannedOptions: ShoppingResourceMatch[];
  unmatchedItems: string[];
  generatedAt: string;
}