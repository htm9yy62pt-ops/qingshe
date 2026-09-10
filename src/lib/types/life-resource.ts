export type LifeResourceType =
  | 'supermarket'
  | 'market'
  | 'online_store'
  | 'local_store'
  | 'other';

export interface LifeResource {
  id: string;
  name: string;
  type: LifeResourceType;
  description?: string;
  address?: string;
  url?: string;
  /**
   * 用户通常在该资源购买的商品类别。
   * 用于 Shopping Decision 与 ShoppingListItem 匹配：
   * LifeResourceFormModal -> LifeResource.tags -> qingshe_life_resources
   * -> Shopping Decision -> Shopping Recommendation。
   */
  tags?: string[];
  isFavorite?: boolean;
  createdAt: string;
  updatedAt?: string;
}