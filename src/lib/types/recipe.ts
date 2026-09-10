export interface RecipeIngredient {
  name: string;
  quantity?: string;
  unit?: string;
  required: boolean;
}

export interface RecipeStep {
  step: number;
  content: string;
}

export interface Recipe {
  id: string;
  title: string;
  description: string;
  coverImage?: string;
  category: string;
  ingredients: RecipeIngredient[];
  optionalIngredients: RecipeIngredient[];
  steps: RecipeStep[];
  estimatedTime: number; // in minutes
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
  sourceType: 'official' | 'user';
  createdAt: Date;
  updatedAt: Date;
}

export interface RecipeMatchResult {
  recipe: Recipe;
  existingIngredients: RecipeIngredient[]; // 用户拥有的食材
  missingIngredients: RecipeIngredient[]; // 缺少的食材
  matchPercentage: number; // 匹配度百分比
  containsUrgentIngredients: boolean; // 是否包含临期食材
  urgentIngredients: RecipeIngredient[]; // 临期食材列表
}