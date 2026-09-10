import { LifeResource, LifeResourceType } from '@/lib/types/life-resource';

const STORAGE_KEY = 'qingshe_life_resources';

export function getLifeResources(): LifeResource[] {
  if (typeof window === 'undefined') return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as LifeResource[];
  } catch {
    return [];
  }
}

export function saveLifeResources(resources: LifeResource[]): LifeResource[] {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(resources));
  }
  return resources;
}

export interface CreateLifeResourceInput {
  name: string;
  type: LifeResourceType;
  description?: string;
  address?: string;
  url?: string;
  tags?: string[];
}

export function createLifeResource(input: CreateLifeResourceInput): LifeResource {
  const now = new Date().toISOString();
  return {
    id: `life_resource_${Date.now()}`,
    name: input.name.trim(),
    type: input.type,
    ...(input.description ? { description: input.description.trim() } : {}),
    ...(input.address ? { address: input.address.trim() } : {}),
    ...(input.url ? { url: input.url.trim() } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    isFavorite: false,
    createdAt: now,
    updatedAt: now
  };
}

export function addLifeResource(
  resources: LifeResource[],
  resource: LifeResource
): LifeResource[] {
  const nextResources = [resource, ...resources];
  return saveLifeResources(nextResources);
}

export function updateLifeResource(
  resources: LifeResource[],
  resource: LifeResource
): LifeResource[] {
  const nextResources = resources.map((item) =>
    item.id === resource.id ? { ...resource, updatedAt: new Date().toISOString() } : item
  );
  return saveLifeResources(nextResources);
}

export function deleteLifeResource(
  resources: LifeResource[],
  id: string
): LifeResource[] {
  const nextResources = resources.filter((item) => item.id !== id);
  return saveLifeResources(nextResources);
}

export function toggleFavoriteLifeResource(
  resources: LifeResource[],
  id: string
): LifeResource[] {
  const nextResources = resources.map((item) =>
    item.id === id
      ? { ...item, isFavorite: !item.isFavorite, updatedAt: new Date().toISOString() }
      : item
  );
  return saveLifeResources(nextResources);
}