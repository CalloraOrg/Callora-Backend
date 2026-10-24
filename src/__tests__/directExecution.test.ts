import { checkDirectExecution } from "../index.js";

describe("checkDirectExecution mode detection", () => {
  it("detects direct execution when invoked as index.ts or index.js", () => {
    expect(checkDirectExecution("/home/user/project/src/index.ts", {})).toBe(true);
    expect(checkDirectExecution("/home/user/project/dist/src/index.js", {})).toBe(true);
  });

  it("does not detect direct execution for .mjs bundles (e.g. index.mjs on Vercel)", () => {
    expect(checkDirectExecution("/var/task/deploy/api/index.mjs", {})).toBe(false);
    expect(checkDirectExecution("index.mjs", {})).toBe(false);
    expect(checkDirectExecution("/app/bundle.mjs", {})).toBe(false);
  });

  it("does not detect direct execution when VERCEL environment is present", () => {
    expect(
      checkDirectExecution("/path/to/src/index.ts", { VERCEL: "1" }),
    ).toBe(false);
  });

  it("returns false for undefined argv1 or unrelated entrypoints", () => {
    expect(checkDirectExecution(undefined, {})).toBe(false);
    expect(checkDirectExecution("", {})).toBe(false);
    expect(checkDirectExecution("/path/to/server.ts", {})).toBe(false);
    expect(checkDirectExecution("/path/to/app.js", {})).toBe(false);
  });
});
