import { Recipe } from '../types/recipe';

const today = new Date();

export const QINGSCHE_RECIPES: Recipe[] = [
  {
    id: 'tomato-egg-stir-fry',
    title: '番茄炒鸡蛋',
    description: '经典家常菜，酸甜可口，营养丰富',
    coverImage: '',
    category: '家常菜',
    ingredients: [
      { name: '番茄', quantity: '2个', unit: '个', required: true },
      { name: '鸡蛋', quantity: '3个', unit: '个', required: true },
      { name: '食盐', quantity: '适量', unit: '', required: true },
      { name: '食用油', quantity: '适量', unit: '', required: true }
    ],
    optionalIngredients: [
      { name: '葱花', quantity: '适量', unit: '', required: false },
      { name: '糖', quantity: '少许', unit: '', required: false }
    ],
    steps: [
      { step: 1, content: '番茄洗净切块，鸡蛋打散备用' },
      { step: 2, content: '热锅下油，倒入蛋液炒熟盛起' },
      { step: 3, content: '爆香番茄，加入少许水煮软' },
      { step: 4, content: '倒入炒好的鸡蛋，调味炒匀即可' }
    ],
    estimatedTime: 15,
    difficulty: 'easy',
    tags: ['快手菜', '家常', '营养'],
    sourceType: 'official',
    createdAt: today,
    updatedAt: today
  },
  {
    id: 'tomato-egg-soup',
    title: '番茄蛋汤',
    description: '清淡鲜美，制作简单，适合佐餐',
    coverImage: '',
    category: '汤类',
    ingredients: [
      { name: '番茄', quantity: '1个', unit: '个', required: true },
      { name: '鸡蛋', quantity: '2个', unit: '个', required: true },
      { name: '清水', quantity: '500ml', unit: 'ml', required: true },
      { name: '食盐', quantity: '适量', unit: '', required: true }
    ],
    optionalIngredients: [
      { name: '葱花', quantity: '适量', unit: '', required: false },
      { name: '香油', quantity: '几滴', unit: '', required: false }
    ],
    steps: [
      { step: 1, content: '番茄切块，鸡蛋打散备用' },
      { step: 2, content: '锅中加水烧开，放入番茄煮软' },
      { step: 3, content: '慢慢倒入蛋液，用筷子搅动形成蛋花' },
      { step: 4, content: '调味，撒上葱花即可' }
    ],
    estimatedTime: 10,
    difficulty: 'easy',
    tags: ['快手汤', '清淡', '营养'],
    sourceType: 'official',
    createdAt: today,
    updatedAt: today
  },
  {
    id: 'peas-beef-stir-fry',
    title: '豌豆炒牛肉',
    description: '荤素搭配，口感丰富，营养均衡',
    coverImage: '',
    category: '家常菜',
    ingredients: [
      { name: '豌豆', quantity: '200g', unit: 'g', required: true },
      { name: '牛肉', quantity: '150g', unit: 'g', required: true },
      { name: '蒜', quantity: '2瓣', unit: '瓣', required: true },
      { name: '食盐', quantity: '适量', unit: '', required: true },
      { name: '生抽', quantity: '适量', unit: '', required: true },
      { name: '食用油', quantity: '适量', unit: '', required: true }
    ],
    optionalIngredients: [
      { name: '胡萝卜丁', quantity: '适量', unit: '', required: false },
      { name: '料酒', quantity: '少许', unit: '', required: false }
    ],
    steps: [
      { step: 1, content: '牛肉切片腌制，豌豆洗净备用' },
      { step: 2, content: '热锅下油，先炒牛肉至变色盛起' },
      { step: 3, content: '爆香蒜末，下豌豆翻炒' },
      { step: 4, content: '倒入牛肉片，调味炒匀即可' }
    ],
    estimatedTime: 20,
    difficulty: 'medium',
    tags: ['荤素搭配', '营养', '快手'],
    sourceType: 'official',
    createdAt: today,
    updatedAt: today
  },
  {
    id: 'pepper-beef-stir-fry',
    title: '青椒炒肉',
    description: '经典搭配，清香爽口，下饭神器',
    coverImage: '',
    category: '家常菜',
    ingredients: [
      { name: '青椒', quantity: '3个', unit: '个', required: true },
      { name: '猪肉', quantity: '150g', unit: 'g', required: true },
      { name: '蒜', quantity: '2瓣', unit: '瓣', required: true },
      { name: '食盐', quantity: '适量', unit: '', required: true },
      { name: '生抽', quantity: '适量', unit: '', required: true },
      { name: '食用油', quantity: '适量', unit: '', required: true }
    ],
    optionalIngredients: [
      { name: '姜丝', quantity: '适量', unit: '', required: false },
      { name: '老抽', quantity: '少许', unit: '', required: false }
    ],
    steps: [
      { step: 1, content: '青椒切丝，猪肉切丝腌制' },
      { step: 2, content: '热锅下油，爆香蒜末' },
      { step: 3, content: '先下肉丝炒至变色' },
      { step: 4, content: '加入青椒丝，大火快炒调味即可' }
    ],
    estimatedTime: 15,
    difficulty: 'easy',
    tags: ['下饭菜', '快手菜', '家常'],
    sourceType: 'official',
    createdAt: today,
    updatedAt: today
  },
  {
    id: 'simple-fried-rice',
    title: '简单蛋炒饭',
    description: '剩米饭的好去处，制作简单，营养美味',
    coverImage: '',
    category: '主食',
    ingredients: [
      { name: '隔夜米饭', quantity: '2碗', unit: '碗', required: true },
      { name: '鸡蛋', quantity: '2个', unit: '个', required: true },
      { name: '葱花', quantity: '适量', unit: '', required: true },
      { name: '食盐', quantity: '适量', unit: '', required: true },
      { name: '食用油', quantity: '适量', unit: '', required: true }
    ],
    optionalIngredients: [
      { name: '火腿丁', quantity: '适量', unit: '', required: false },
      { name: '胡萝卜丁', quantity: '适量', unit: '', required: false },
      { name: '豌豆', quantity: '适量', unit: '', required: false }
    ],
    steps: [
      { step: 1, content: '鸡蛋打散，米饭拨散备用' },
      { step: 2, content: '热锅下油，炒熟鸡蛋盛起' },
      { step: 3, content: '下米饭炒散，加入少许油使颗粒分明' },
      { step: 4, content: '倒入鸡蛋，调味撒葱花炒匀即可' }
    ],
    estimatedTime: 10,
    difficulty: 'easy',
    tags: ['快手主食', '剩饭利用', '简单'],
    sourceType: 'official',
    createdAt: today,
    updatedAt: today
  }
];