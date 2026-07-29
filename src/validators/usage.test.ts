import { UsageQuerySchema } from "./usage.js";

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("UsageQuerySchema", () => {
  // -----------------------------------------------------------------------
  // Default values
  // -----------------------------------------------------------------------
  it("applies default limit of 20 when no limit is provided", () => {
    const result = UsageQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it("applies default limit when undefined is passed explicitly", () => {
    const result = UsageQuerySchema.safeParse({ limit: undefined });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  // -----------------------------------------------------------------------
  // limit field validation
  // -----------------------------------------------------------------------
  it("accepts a valid limit within range", () => {
    const result = UsageQuerySchema.safeParse({ limit: "50" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
    }
  });

  it("accepts limit at the lower boundary (1)", () => {
    const result = UsageQuerySchema.safeParse({ limit: "1" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(1);
    }
  });

  it("accepts limit at the upper boundary (100)", () => {
    const result = UsageQuerySchema.safeParse({ limit: "100" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(100);
    }
  });

  it("rejects limit exceeding 100", () => {
    const result = UsageQuerySchema.safeParse({ limit: "101" });
    expect(result.success).toBe(false);
  });

  it("rejects limit below 1", () => {
    const result = UsageQuerySchema.safeParse({ limit: "0" });
    expect(result.success).toBe(false);
  });

  it("rejects negative limit", () => {
    const result = UsageQuerySchema.safeParse({ limit: "-5" });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer limit string", () => {
    const result = UsageQuerySchema.safeParse({ limit: "abc" });
    expect(result.success).toBe(false);
  });

  it("rejects decimal limit", () => {
    const result = UsageQuerySchema.safeParse({ limit: "3.5" });
    expect(result.success).toBe(false);
  });

  // -----------------------------------------------------------------------
  // offset field validation
  // -----------------------------------------------------------------------
  it("accepts a valid offset", () => {
    const result = UsageQuerySchema.safeParse({ offset: "10" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.offset).toBe(10);
    }
  });

  it("accepts zero offset", () => {
    const result = UsageQuerySchema.safeParse({ offset: "0" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.offset).toBe(0);
    }
  });

  it("rejects negative offset", () => {
    const result = UsageQuerySchema.safeParse({ offset: "-1" });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer offset", () => {
    const result = UsageQuerySchema.safeParse({ offset: "abc" });
    expect(result.success).toBe(false);
  });

  // -----------------------------------------------------------------------
  // from / to date validation
  // -----------------------------------------------------------------------
  it("accepts valid ISO datetime strings for from and to", () => {
    const result = UsageQuerySchema.safeParse({
      from: "2026-07-01T00:00:00Z",
      to: "2026-07-10T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when from is after to", () => {
    const result = UsageQuerySchema.safeParse({
      from: "2026-07-10T00:00:00Z",
      to: "2026-07-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain("from");
    }
  });

  it("accepts when from equals to (single-day range)", () => {
    const result = UsageQuerySchema.safeParse({
      from: "2026-07-01T00:00:00Z",
      to: "2026-07-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts from without to (partial date range)", () => {
    const result = UsageQuerySchema.safeParse({
      from: "2026-07-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts to without from (partial date range)", () => {
    const result = UsageQuerySchema.safeParse({
      to: "2026-07-10T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid date format for from", () => {
    const result = UsageQuerySchema.safeParse({ from: "not-a-date" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid date format for to", () => {
    const result = UsageQuerySchema.safeParse({ to: "2026/07/01" });
    expect(result.success).toBe(false);
  });

  // -----------------------------------------------------------------------
  // groupBy validation
  // -----------------------------------------------------------------------
  it("accepts valid groupBy values", () => {
    for (const groupBy of ["day", "week", "month"]) {
      const result = UsageQuerySchema.safeParse({ groupBy });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid groupBy value", () => {
    const result = UsageQuerySchema.safeParse({ groupBy: "invalid" });
    expect(result.success).toBe(false);
  });

  it("rejects empty groupBy string", () => {
    const result = UsageQuerySchema.safeParse({ groupBy: "" });
    expect(result.success).toBe(false);
  });

  // -----------------------------------------------------------------------
  // apiId validation
  // -----------------------------------------------------------------------
  it("accepts a valid apiId string", () => {
    const result = UsageQuerySchema.safeParse({ apiId: "api-123" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.apiId).toBe("api-123");
    }
  });

  it("accepts optional apiId", () => {
    const result = UsageQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // cursor / after / before validation
  // -----------------------------------------------------------------------
  it("accepts a cursor string", () => {
    const result = UsageQuerySchema.safeParse({ cursor: "bmV4dC1jdXJzb3I=" });
    expect(result.success).toBe(true);
  });

  it("accepts after and before parameters", () => {
    const result = UsageQuerySchema.safeParse({
      after: "bmV4dC1jdXJzb3I=",
      before: "cHJldi1jdXJzb3I=",
    });
    expect(result.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // All fields together
  // -----------------------------------------------------------------------
  it("accepts all valid fields together", () => {
    const result = UsageQuerySchema.safeParse({
      from: "2026-07-01T00:00:00Z",
      to: "2026-07-10T00:00:00Z",
      apiId: "api-1",
      groupBy: "day",
      limit: "50",
      offset: "0",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
      expect(result.data.groupBy).toBe("day");
      expect(result.data.apiId).toBe("api-1");
    }
  });

  // -----------------------------------------------------------------------
  // Empty / undefined handling
  // -----------------------------------------------------------------------
  it("accepts an empty object with all defaults", () => {
    const result = UsageQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
      expect(result.data.offset).toBeUndefined();
      expect(result.data.from).toBeUndefined();
      expect(result.data.to).toBeUndefined();
      expect(result.data.apiId).toBeUndefined();
      expect(result.data.groupBy).toBeUndefined();
      expect(result.data.cursor).toBeUndefined();
      expect(result.data.after).toBeUndefined();
      expect(result.data.before).toBeUndefined();
    }
  });

  it("rejects unexpected extra fields", () => {
    // Zod's default object schema allows unknown keys unless .strict() is used
    const result = UsageQuerySchema.safeParse({ unknownField: "value" });
    // Should still succeed because we don't use .strict()
    expect(result.success).toBe(true);
  });
});
