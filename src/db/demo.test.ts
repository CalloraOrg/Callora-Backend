import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import {
  bootstrapDemoDb,
  getMigrationDialect,
} from "./demo.js";
import * as embeddedAssets from "../lib/embeddedAssets.js";

describe("src/db/demo.ts", () => {
  describe("getMigrationDialect", () => {
    it("extracts dialect from header comment", () => {
      expect(getMigrationDialect("test.sql", "-- dialect: postgres\nCREATE TABLE x (id serial);")).toBe("postgres");
      expect(getMigrationDialect("test.sql", "-- dialect: sqlite\nCREATE TABLE x (id integer);")).toBe("sqlite");
      expect(getMigrationDialect("test.sql", "-- dialect: both\nCREATE TABLE x (id text);")).toBe("both");
      expect(getMigrationDialect("test.sql", "-- DIALECT: POSTGRES\nSELECT 1;")).toBe("postgres");
    });

    it("falls back to manifest for known migration files", () => {
      expect(getMigrationDialect("0000_initial_apis_tables.sql", "SELECT 1;")).toBe("both");
      expect(getMigrationDialect("0001_create_api_keys_and_vaults.up.sql", "SELECT 1;")).toBe("postgres");
    });

    it("defaults to 'both' for unclassified files without header comments", () => {
      expect(getMigrationDialect("9999_custom.sql", "SELECT 1;")).toBe("both");
    });
  });

  describe("bootstrapDemoDb", () => {
    let tmpDir: string;
    let sqlite: Database.Database;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-bootstrap-test-"));
      sqlite = new Database(":memory:");
      jest.spyOn(embeddedAssets, "getEmbeddedAssets").mockReturnValue(undefined);
    });

    afterEach(() => {
      sqlite.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      jest.restoreAllMocks();
    });

    it("applies SQLite migrations without executing PostgreSQL quote and cache migrations", () => {
      // 0000: SQLite table
      fs.writeFileSync(
        path.join(tmpDir, "0000_apis.sql"),
        `CREATE TABLE developers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          website TEXT NOT NULL,
          description TEXT NOT NULL,
          category TEXT NOT NULL
        );
        CREATE TABLE apis (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          developer_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          base_url TEXT NOT NULL,
          category TEXT NOT NULL,
          status TEXT NOT NULL
        );
        CREATE TABLE api_endpoints (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          api_id INTEGER NOT NULL,
          path TEXT NOT NULL,
          method TEXT NOT NULL,
          price_per_call_usdc TEXT NOT NULL,
          description TEXT NOT NULL
        );`,
      );

      // 0001: Postgres-only with header comment
      fs.writeFileSync(
        path.join(tmpDir, "0001_pg_only.sql"),
        `-- dialect: postgres
        THIS IS INVALID SQLITE SYNTAX THAT WOULD FAIL IF EXECUTED;`,
      );

      for (const file of [
        "0033_idempotency_response_headers.sql",
        "0034_fee_abstraction_quotes.sql",
      ]) {
        fs.copyFileSync(path.join(process.cwd(), "migrations", file), path.join(tmpDir, file));
      }


      bootstrapDemoDb(sqlite, tmpDir);


      const dev = sqlite.prepare("SELECT * FROM developers WHERE user_id = 'demo-dev'").get() as { id: number };
      expect(dev).toBeDefined();

      const apis = sqlite.prepare("SELECT * FROM apis").all();
      expect(apis.length).toBe(3);
      expect(sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('fee_abstraction_quotes', 'idempotency_store')",
      ).all()).toEqual([]);
    });

    it("Scenario 5: Broken SQLite-applicable migration fails bootstrap naming the file", () => {
      fs.writeFileSync(
        path.join(tmpDir, "0001_broken_sqlite.sql"),
        `-- dialect: sqlite
        BROKEN SYNTAX HERE;`,
      );

      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      expect(() => bootstrapDemoDb(sqlite, tmpDir)).toThrow(
        /Failed to apply SQLite-applicable migration "0001_broken_sqlite\.sql"/,
      );

      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to apply SQLite-applicable migration 0001_broken_sqlite.sql"),
        expect.anything(),
      );
    });

    it("Scenario 6: Seed run twice produces no duplicate APIs and preserves correct developer_id", () => {
      // Create tables
      sqlite.exec(`
        CREATE TABLE developers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          website TEXT NOT NULL,
          description TEXT NOT NULL,
          category TEXT NOT NULL
        );
        CREATE TABLE apis (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          developer_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          base_url TEXT NOT NULL,
          category TEXT NOT NULL,
          status TEXT NOT NULL
        );
        CREATE TABLE api_endpoints (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          api_id INTEGER NOT NULL,
          path TEXT NOT NULL,
          method TEXT NOT NULL,
          price_per_call_usdc TEXT NOT NULL,
          description TEXT NOT NULL
        );
      `);

      // Pre-insert a developer with custom non-1 id
      sqlite.exec(`INSERT INTO developers (id, user_id, name, website, description, category)
        VALUES (42, 'demo-dev', 'Callora Demo Labs', 'https://callora.example', 'Demo developer', 'data');`);

      // Empty migration folder
      bootstrapDemoDb(sqlite, tmpDir);

      let apis = sqlite.prepare("SELECT * FROM apis").all() as Array<{ developer_id: number }>;
      expect(apis.length).toBe(3);
      expect(apis.every((a) => a.developer_id === 42)).toBe(true);

      // Run seed second time
      bootstrapDemoDb(sqlite, tmpDir);

      apis = sqlite.prepare("SELECT * FROM apis").all() as Array<{ developer_id: number }>;
      expect(apis.length).toBe(3);
      expect(apis.every((a) => a.developer_id === 42)).toBe(true);

      const endpoints = sqlite.prepare("SELECT * FROM api_endpoints").all();
      expect(endpoints.length).toBe(4);
    });

    it("supports embedded assets when available", () => {
      jest.spyOn(embeddedAssets, "getEmbeddedAssets").mockReturnValue({
        migrations: {
          "0000_apis.sql": `
            CREATE TABLE developers (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL,
              website TEXT NOT NULL,
              description TEXT NOT NULL,
              category TEXT NOT NULL
            );
            CREATE TABLE apis (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              developer_id INTEGER NOT NULL,
              name TEXT NOT NULL,
              description TEXT NOT NULL,
              base_url TEXT NOT NULL,
              category TEXT NOT NULL,
              status TEXT NOT NULL
            );
            CREATE TABLE api_endpoints (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              api_id INTEGER NOT NULL,
              path TEXT NOT NULL,
              method TEXT NOT NULL,
              price_per_call_usdc TEXT NOT NULL,
              description TEXT NOT NULL
            );
          `,
          "0001_pg.sql": "-- dialect: postgres\nINVALID;",
        },
      });

      bootstrapDemoDb(sqlite, "/unused/path");

      const apis = sqlite.prepare("SELECT * FROM apis").all();
      expect(apis.length).toBe(3);
    });

    it("runs all actual project migrations cleanly in demo mode", () => {
      const realMigrationDir = path.resolve(process.cwd(), "migrations");
      bootstrapDemoDb(sqlite, realMigrationDir);

      const apis = sqlite.prepare("SELECT * FROM apis").all();
      expect(apis.length).toBe(3);
    });
  });
});
