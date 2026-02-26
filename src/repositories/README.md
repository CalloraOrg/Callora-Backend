# Developer Repository

TypeORM-based repository for managing developers and their APIs.

## Features

- Full CRUD operations for developers
- Link developers to users via `user_id`
- List all APIs belonging to a developer
- Consistent error handling with custom error classes
- 100% test coverage

## Methods

### `create(data: CreateDeveloperInput): Promise<Developer>`
Creates a new developer.

```typescript
const developer = await repository.create({ user_id: 'user-123' });
```

### `findByUserId(userId: string): Promise<Developer | null>`
Finds a developer by their user ID.

```typescript
const developer = await repository.findByUserId('user-123');
```

### `findById(id: string): Promise<Developer | null>`
Finds a developer by their ID.

```typescript
const developer = await repository.findById('dev-123');
```

### `update(id: string, data: UpdateDeveloperInput): Promise<Developer>`
Updates a developer. Throws `NotFoundError` if developer doesn't exist.

```typescript
const updated = await repository.update('dev-123', { user_id: 'user-456' });
```

### `listApis(developerId: string): Promise<Api[]>`
Lists all APIs for a developer, ordered by creation date (newest first). Throws `NotFoundError` if developer doesn't exist.

```typescript
const apis = await repository.listApis('dev-123');
```

## Error Handling

- `NotFoundError`: Thrown when a developer is not found
- `DatabaseError`: Thrown when database operations fail

## Usage Example

```typescript
import { AppDataSource } from '../config/database';
import { DeveloperRepository } from './DeveloperRepository';
import { Developer } from '../models/Developer';
import { Api } from '../models/Api';

// Initialize data source
await AppDataSource.initialize();

// Create repository
const developerRepo = AppDataSource.getRepository(Developer);
const apiRepo = AppDataSource.getRepository(Api);
const repository = new DeveloperRepository(developerRepo, apiRepo);

// Use repository
const developer = await repository.create({ user_id: 'user-123' });
const apis = await repository.listApis(developer.id);
```

## Database Schema

### developers table
- `id` (uuid, primary key)
- `user_id` (varchar)
- `created_at` (timestamp)
- `updated_at` (timestamp)

### apis table
- `id` (uuid, primary key)
- `developer_id` (varchar, foreign key)
- `name` (varchar)
- `created_at` (timestamp)
- `updated_at` (timestamp)
