export interface InventoryIngredient {
  id: string;
  name: string;
  quantity: string;
  unit: string;
  category: string;
  purchaseDate: string;
  expiryDate: string;
  storageLocation: string;
  createdAt: string;
  /** 当食材被确认吃完且库存扣减至 0 时标记（可选字段，保持向后兼容） */
  status?: 'finished';
}