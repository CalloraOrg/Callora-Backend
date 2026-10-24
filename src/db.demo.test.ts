import { Pool } from "pg";
import { config } from "./config/index.js";
import { closePgPool, pool, readQuery, writeQuery } from "./db.js";

jest.mock("pg", () => ({
  Pool: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
}));

describe("lazy PostgreSQL pool", () => {
  afterEach(() => jest.restoreAllMocks());

  test("does not construct or connect a PostgreSQL pool in demo mode", async () => {
    jest.replaceProperty(config, "demoMode", true);
    expect(Pool).not.toHaveBeenCalled();
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);
    expect(pool.waitingCount).toBe(0);
    expect(() => pool.query("SELECT 1")).toThrow("unavailable in demo mode");
    expect(() => pool.connect()).toThrow("unavailable in demo mode");
    expect(() => readQuery("SELECT 1")).toThrow("unavailable in demo mode");
    expect(() => writeQuery("SELECT 1")).toThrow("unavailable in demo mode");
    await closePgPool();
    expect(Pool).not.toHaveBeenCalled();
  });

  test("constructs one shared pool on first standard-mode use", async () => {
    jest.replaceProperty(config, "demoMode", false);
    expect(Pool).not.toHaveBeenCalled();
    expect(await pool.query("SELECT 1")).toEqual({ rows: [] });
    expect(await pool.query("SELECT 2")).toEqual({ rows: [] });
    expect(Pool).toHaveBeenCalledTimes(1);
    const spy = jest.spyOn(pool, "query").mockResolvedValue({ rows: [] } as never);
    await pool.query("SELECT 3");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
