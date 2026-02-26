import { NotFoundError } from '../errors/index.js';
import type { Developer, NewDeveloper, Api } from '../db/schema.js';

export interface CreateDeveloperInput {
  user_id: string;
  name?: string;
  website?: string;
  description?: string;
  category?: string;
}

export interface UpdateDeveloperInput {
  name?: string;
  website?: string;
  description?: string;
  category?: string;
}

export interface DeveloperRepository {
  create(data: CreateDeveloperInput): Promise<Developer>;
  findByUserId(userId: string): Promise<Developer | null>;
  findById(id: number): Promise<Developer | null>;
  update(id: number, data: UpdateDeveloperInput): Promise<Developer>;
  listApis(developerId: number): Promise<Api[]>;
}

export class InMemoryDeveloperRepository implements DeveloperRepository {
  private developers: Map<number, Developer> = new Map();
  private apis: Map<number, Api> = new Map();
  private nextId = 1;
  private nextApiId = 1;

  async create(data: CreateDeveloperInput): Promise<Developer> {
    const now = new Date();
    const developer: Developer = {
      id: this.nextId++,
      user_id: data.user_id,
      name: data.name ?? null,
      website: data.website ?? null,
      description: data.description ?? null,
      category: data.category ?? null,
      created_at: now,
      updated_at: now,
    };

    this.developers.set(developer.id, developer);
    return { ...developer };
  }

  async findByUserId(userId: string): Promise<Developer | null> {
    for (const developer of this.developers.values()) {
      if (developer.user_id === userId) {
        return { ...developer };
      }
    }
    return null;
  }

  async findById(id: number): Promise<Developer | null> {
    const developer = this.developers.get(id);
    return developer ? { ...developer } : null;
  }

  async update(id: number, data: UpdateDeveloperInput): Promise<Developer> {
    const developer = await this.findById(id);
    if (!developer) {
      throw new NotFoundError(`Developer with id ${id} not found`);
    }

    const updated: Developer = {
      ...developer,
      name: data.name !== undefined ? data.name : developer.name,
      website: data.website !== undefined ? data.website : developer.website,
      description: data.description !== undefined ? data.description : developer.description,
      category: data.category !== undefined ? data.category : developer.category,
      updated_at: new Date(),
    };

    this.developers.set(id, updated);
    return { ...updated };
  }

  async listApis(developerId: number): Promise<Api[]> {
    const developer = await this.findById(developerId);
    if (!developer) {
      throw new NotFoundError(`Developer with id ${developerId} not found`);
    }

    const apis: Api[] = [];
    for (const api of this.apis.values()) {
      if (api.developer_id === developerId) {
        apis.push({ ...api });
      }
    }

    // Sort by created_at DESC
    return apis.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }

  // Helper method for testing - add an API
  addApi(api: Api): void {
    this.apis.set(api.id, api);
  }
}
