import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Import the migrate module (we'll test it by running it from the project root)
const migrationSQLPath = path.join(process.cwd(), 'migrations', '0000_initial_apis_tables.sql');

describe('Migration Runner Tests', () => {
  let testDbPath: string;
  let migrationSQL: string;

  beforeAll(() => {
    // Read migration SQL once
    migrationSQL = fs.readFileSync(migrationSQLPath, 'utf8');
  });

  beforeEach(() => {
    // Create a unique test database for each test
    testDbPath = path.join(process.cwd(), `test_migration_${Date.now()}.db`);
  });

  afterEach(() => {
    // Clean up test database
    try {
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    } catch (error) {
      console.warn('Failed to clean up test database:', error);
    }
  });

  describe('Empty Database Migration', () => {
    it('should apply migrations cleanly on empty database', () => {
      // Arrange
      const db = new Database(testDbPath);
      
      try {
        // Act - Apply migration
        db.exec('BEGIN TRANSACTION');
        
        const statements = migrationSQL.split(';').filter(stmt => stmt.trim());
        for (const statement of statements) {
          if (statement.trim()) {
            db.exec(statement);
          }
        }
        
        db.exec('COMMIT');

        // Assert - Check that tables were created
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name: string}>;
        const tableNames = tables.map(t => t.name);
        
        expect(tableNames).toContain('apis');
        expect(tableNames).toContain('api_endpoints');
        
        // Check table schemas
        const apisSchema = db.prepare("PRAGMA table_info(apis)").all() as Array<{name: string, type: string, notnull: number, pk: number}>;
        const apiEndpointsSchema = db.prepare("PRAGMA table_info(api_endpoints)").all() as Array<{name: string, type: string, notnull: number, pk: number}>;
        
        // Verify apis table structure
        const apisColumns = apisSchema.map(col => col.name);
        expect(apisColumns).toContain('id');
        expect(apisColumns).toContain('developer_id');
        expect(apisColumns).toContain('name');
        expect(apisColumns).toContain('description');
        expect(apisColumns).toContain('base_url');
        expect(apisColumns).toContain('logo_url');
        expect(apisColumns).toContain('category');
        expect(apisColumns).toContain('status');
        expect(apisColumns).toContain('created_at');
        expect(apisColumns).toContain('updated_at');
        
        // Verify api_endpoints table structure
        const apiEndpointsColumns = apiEndpointsSchema.map(col => col.name);
        expect(apiEndpointsColumns).toContain('id');
        expect(apiEndpointsColumns).toContain('api_id');
        expect(apiEndpointsColumns).toContain('path');
        expect(apiEndpointsColumns).toContain('method');
        expect(apiEndpointsColumns).toContain('price_per_call_usdc');
        expect(apiEndpointsColumns).toContain('description');
        expect(apiEndpointsColumns).toContain('created_at');
        expect(apiEndpointsColumns).toContain('updated_at');
        
        // Check that indexes were created
        const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{name: string}>;
        const indexNames = indexes.map(i => i.name);
        
        expect(indexNames).toContain('idx_api_endpoints_api_id');
        expect(indexNames).toContain('idx_apis_developer_id');
        expect(indexNames).toContain('idx_apis_status');
        
      } finally {
        db.close();
      }
    });

    it('should create tables with correct constraints and defaults', () => {
      // Arrange
      const db = new Database(testDbPath);
      
      try {
        // Act
        db.exec('BEGIN TRANSACTION');
        
        const statements = migrationSQL.split(';').filter(stmt => stmt.trim());
        for (const statement of statements) {
          if (statement.trim()) {
            db.exec(statement);
          }
        }
        
        db.exec('COMMIT');

        // Assert - Test constraints and defaults
        const apisSchema = db.prepare("PRAGMA table_info(apis)").all() as Array<{name: string, type: string, notnull: number, dflt_value: any, pk: number}>;
        const apiEndpointsSchema = db.prepare("PRAGMA table_info(api_endpoints)").all() as Array<{name: string, type: string, notnull: number, dflt_value: any, pk: number}>;
        
        // Check apis table constraints
        const idColumn = apisSchema.find(col => col.name === 'id');
        expect(idColumn?.pk).toBe(1); // Primary key
        expect(idColumn?.notnull).toBe(1); // Not null
        
        const developerIdColumn = apisSchema.find(col => col.name === 'developer_id');
        expect(developerIdColumn?.notnull).toBe(1); // Not null
        
        const statusColumn = apisSchema.find(col => col.name === 'status');
        expect(statusColumn?.notnull).toBe(1); // Not null
        expect(statusColumn?.dflt_value).toBe("'draft'"); // Default value
        
        const createdAtColumn = apisSchema.find(col => col.name === 'created_at');
        expect(createdAtColumn?.notnull).toBe(1); // Not null
        expect(createdAtColumn?.dflt_value).toBe('unixepoch()'); // Default value
        
        // Check api_endpoints table constraints
        const endpointIdColumn = apiEndpointsSchema.find(col => col.name === 'id');
        expect(endpointIdColumn?.pk).toBe(1); // Primary key
        expect(endpointIdColumn?.notnull).toBe(1); // Not null
        
        const apiIdColumn = apiEndpointsSchema.find(col => col.name === 'api_id');
        expect(apiIdColumn?.notnull).toBe(1); // Not null
        
        const methodColumn = apiEndpointsSchema.find(col => col.name === 'method');
        expect(methodColumn?.notnull).toBe(1); // Not null
        expect(methodColumn?.dflt_value).toBe("'GET'"); // Default value
        
      } finally {
        db.close();
      }
    });
  });

  describe('Migration Idempotency', () => {
    it('should handle re-running migrations gracefully', () => {
      // Arrange
      const db = new Database(testDbPath);
      
      try {
        // Act - Apply migration twice
        for (let run = 1; run <= 2; run++) {
          db.exec('BEGIN TRANSACTION');
          
          const statements = migrationSQL.split(';').filter(stmt => stmt.trim());
          for (const statement of statements) {
            if (statement.trim()) {
              try {
                db.exec(statement);
              } catch (error) {
                // Some statements might fail on re-run (like CREATE TABLE)
                // This is expected behavior
                const errorMessage = error instanceof Error ? error.message : String(error);
                expect(
                  errorMessage.includes('already exists') || 
                  errorMessage.includes('duplicate') ||
                  errorMessage.includes('no such table')
                ).toBe(true);
              }
            }
          }
          
          db.exec('COMMIT');
        }

        // Assert - Database should still be in a valid state
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name: string}>;
        const tableNames = tables.map(t => t.name);
        
        expect(tableNames).toContain('apis');
        expect(tableNames).toContain('api_endpoints');
        
        // Should be able to query tables
        const apisCount = db.prepare("SELECT COUNT(*) as count FROM apis").get() as {count: number};
        const endpointsCount = db.prepare("SELECT COUNT(*) as count FROM api_endpoints").get() as {count: number};
        
        expect(typeof apisCount.count).toBe('number');
        expect(typeof endpointsCount.count).toBe('number');
        
      } finally {
        db.close();
      }
    });

    it('should rollback on migration failure', () => {
      // Arrange
      const db = new Database(testDbPath);
      
      try {
        // Act - Try to run migration with a deliberate error
        const corruptedSQL = migrationSQL + '\nINVALID SQL STATEMENT;';
        
        try {
          db.exec('BEGIN TRANSACTION');
          
          const statements = corruptedSQL.split(';').filter(stmt => stmt.trim());
          for (const statement of statements) {
            if (statement.trim()) {
              db.exec(statement);
            }
          }
          
          db.exec('COMMIT');
          
          // If we get here, the migration didn't fail as expected
          fail('Expected migration to fail');
          
        } catch (error) {
          // Expected to fail - ensure rollback happened
          db.exec('ROLLBACK');
          
          // Assert - Database should be in a clean state
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name: string}>;
          const tableNames = tables.map(t => t.name);
          
          // Should not contain our tables due to rollback
          expect(tableNames).not.toContain('apis');
          expect(tableNames).not.toContain('api_endpoints');
        }
        
      } finally {
        db.close();
      }
    });
  });

  describe('Data Integrity', () => {
    it('should maintain foreign key relationships', () => {
      // Arrange
      const db = new Database(testDbPath);
      
      try {
        // Enable foreign key constraints
        db.exec('PRAGMA foreign_keys = ON');
        
        // Apply migration
        db.exec('BEGIN TRANSACTION');
        
        const statements = migrationSQL.split(';').filter(stmt => stmt.trim());
        for (const statement of statements) {
          if (statement.trim()) {
            db.exec(statement);
          }
        }
        
        db.exec('COMMIT');

        // Act & Assert - Test foreign key constraints
        // Insert a valid API
        const insertApi = db.prepare(`
          INSERT INTO apis (developer_id, name, base_url, status) 
          VALUES (1, 'Test API', 'https://api.example.com', 'draft')
        `);
        const apiResult = insertApi.run();
        
        // Insert a valid endpoint (should succeed)
        const insertEndpoint = db.prepare(`
          INSERT INTO api_endpoints (api_id, path, method, price_per_call_usdc) 
          VALUES (?, '/test', 'GET', '0.01')
        `);
        
        expect(() => {
          insertEndpoint.run(apiResult.lastInsertRowid);
        }).not.toThrow();
        
        // Try to insert an endpoint with invalid api_id (should fail)
        const insertInvalidEndpoint = db.prepare(`
          INSERT INTO api_endpoints (api_id, path, method, price_per_call_usdc) 
          VALUES (999, '/test', 'GET', '0.01')
        `);
        
        expect(() => {
          insertInvalidEndpoint.run();
        }).toThrow();
        
      } finally {
        db.close();
      }
    });

    it('should handle data operations correctly after migration', () => {
      // Arrange
      const db = new Database(testDbPath);
      
      try {
        // Apply migration
        db.exec('BEGIN TRANSACTION');
        
        const statements = migrationSQL.split(';').filter(stmt => stmt.trim());
        for (const statement of statements) {
          if (statement.trim()) {
            db.exec(statement);
          }
        }
        
        db.exec('COMMIT');

        // Act - Test CRUD operations
        // Create
        const insertApi = db.prepare(`
          INSERT INTO apis (developer_id, name, description, base_url, logo_url, category, status) 
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const apiResult = insertApi.run(
          1, 
          'Test API', 
          'A test API', 
          'https://api.example.com', 
          'https://example.com/logo.png', 
          'test', 
          'active'
        );
        
        // Read
        const selectApi = db.prepare("SELECT * FROM apis WHERE id = ?");
        const api = selectApi.get(apiResult.lastInsertRowid) as any;
        
        expect(api.name).toBe('Test API');
        expect(api.developer_id).toBe(1);
        expect(api.status).toBe('active');
        
        // Update
        const updateApi = db.prepare("UPDATE apis SET status = ? WHERE id = ?");
        updateApi.run('inactive', apiResult.lastInsertRowid);
        
        const updatedApi = selectApi.get(apiResult.lastInsertRowid) as any;
        expect(updatedApi.status).toBe('inactive');
        
        // Delete
        const deleteApi = db.prepare("DELETE FROM apis WHERE id = ?");
        deleteApi.run(apiResult.lastInsertRowid);
        
        const deletedApi = selectApi.get(apiResult.lastInsertRowid);
        expect(deletedApi).toBeUndefined();
        
      } finally {
        db.close();
      }
    });
  });

  describe('Performance and Indexes', () => {
    it('should create indexes for performance', () => {
      // Arrange
      const db = new Database(testDbPath);
      
      try {
        // Apply migration
        db.exec('BEGIN TRANSACTION');
        
        const statements = migrationSQL.split(';').filter(stmt => stmt.trim());
        for (const statement of statements) {
          if (statement.trim()) {
            db.exec(statement);
          }
        }
        
        db.exec('COMMIT');

        // Assert - Check that indexes exist
        const indexes = db.prepare(`
          SELECT name, tbl_name, sql 
          FROM sqlite_master 
          WHERE type = 'index' AND name LIKE 'idx_%'
        `).all() as Array<{name: string, tbl_name: string, sql: string}>;
        
        const indexNames = indexes.map(i => i.name);
        
        expect(indexNames).toContain('idx_api_endpoints_api_id');
        expect(indexNames).toContain('idx_apis_developer_id');
        expect(indexNames).toContain('idx_apis_status');
        
        // Verify index structures
        const apiEndpointsIndex = indexes.find(i => i.name === 'idx_api_endpoints_api_id');
        expect(apiEndpointsIndex?.tbl_name).toBe('api_endpoints');
        expect(apiEndpointsIndex?.sql).toContain('api_id');
        
        const apisDeveloperIndex = indexes.find(i => i.name === 'idx_apis_developer_id');
        expect(apisDeveloperIndex?.tbl_name).toBe('apis');
        expect(apisDeveloperIndex?.sql).toContain('developer_id');
        
        const apisStatusIndex = indexes.find(i => i.name === 'idx_apis_status');
        expect(apisStatusIndex?.tbl_name).toBe('apis');
        expect(apisStatusIndex?.sql).toContain('status');
        
      } finally {
        db.close();
      }
    });
  });
});
