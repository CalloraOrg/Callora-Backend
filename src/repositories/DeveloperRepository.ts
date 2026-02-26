import { Repository } from 'typeorm';
import { Developer } from '../models/Developer';
import { Api } from '../models/Api';
import { CreateDeveloperInput, UpdateDeveloperInput } from '../types/database';
import { NotFoundError, DatabaseError } from '../errors/RepositoryError';

export class DeveloperRepository {
  constructor(
    private developerRepo: Repository<Developer>,
    private apiRepo: Repository<Api>
  ) {}

  async create(data: CreateDeveloperInput): Promise<Developer> {
    try {
      const developer = this.developerRepo.create({
        user_id: data.user_id,
      });
      return await this.developerRepo.save(developer);
    } catch (error) {
      throw new DatabaseError('Failed to create developer', error);
    }
  }

  async findByUserId(userId: string): Promise<Developer | null> {
    try {
      return await this.developerRepo.findOne({
        where: { user_id: userId },
      });
    } catch (error) {
      throw new DatabaseError('Failed to find developer by user_id', error);
    }
  }

  async findById(id: string): Promise<Developer | null> {
    try {
      return await this.developerRepo.findOne({
        where: { id },
      });
    } catch (error) {
      throw new DatabaseError('Failed to find developer by id', error);
    }
  }

  async update(id: string, data: UpdateDeveloperInput): Promise<Developer> {
    try {
      const developer = await this.findById(id);
      if (!developer) {
        throw new NotFoundError('Developer', id);
      }

      if (data.user_id !== undefined) {
        developer.user_id = data.user_id;
      }

      return await this.developerRepo.save(developer);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw new DatabaseError('Failed to update developer', error);
    }
  }

  async listApis(developerId: string): Promise<Api[]> {
    try {
      const developer = await this.findById(developerId);
      if (!developer) {
        throw new NotFoundError('Developer', developerId);
      }

      return await this.apiRepo.find({
        where: { developer_id: developerId },
        order: { created_at: 'DESC' },
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw new DatabaseError('Failed to list APIs for developer', error);
    }
  }
}
