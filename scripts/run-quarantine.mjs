#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultTimeoutMs = 120_000;

export function matchesFilter(suite, filter) {
  return !filter || suite.includes(filter);
}

export function classifyResult({ timedOut, exitCode, error }) {
  if (timedOut) return "TIMEOUT";
  return !error && exitCode === 0 ? "PASS" : "FAIL";
}

export function formatReport(results) {
  const rows = results.map(({ suite, status, durationMs }) => [
    suite,
    status,
    `${Math.round(durationMs)}ms`,
  ]);
  const widths = [
    Math.max("Suite".length, ...rows.map(([suite]) => suite.length)),
    Math.max("Status".length, ...rows.map(([, status]) => status.length)),
    Math.max("Duration".length, ...rows.map(([, , duration]) => duration.length)),
  ];
  const formatRow = (values) =>
    `| ${values.map((value, index) => value.padEnd(widths[index])).join(" | ")} |`;
  const divider = `|-${widths.map((width) => "-".repeat(width)).join("-|-")}-|`;
  const table = [
    formatRow(["Suite", "Status", "Duration"]),
    divider,
    ...rows.map(formatRow),
  ].join("\n");
  const counts = results.reduce(
    (summary, { status }) => {
      summary[status] = (summary[status] ?? 0) + 1;
      return summary;
    },
    {},
  );
  const summary = `Summary: ${counts.PASS ?? 0} passed, ${counts.FAIL ?? 0} failed, ${
    counts.TIMEOUT ?? 0
  } timed out, ${counts.SKIP ?? 0} skipped (${results.length} suites)`;

  return `${table}\n${summary}`;
}

function parseArgs(args) {
  const timeoutFromEnv = process.env.QUARANTINE_SUITE_TIMEOUT_MS;
  const options = {
    timeoutMs: timeoutFromEnv === undefined ? defaultTimeoutMs : Number(timeoutFromEnv),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--filter" || arg === "--json" || arg === "--timeout-ms") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--filter") options.filter = value;
      if (arg === "--json") options.jsonFile = value;
      if (arg === "--timeout-ms") options.timeoutMs = Number(value);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms and QUARANTINE_SUITE_TIMEOUT_MS must be a positive integer");
  }
  return options;
}

function killProcessTree(child) {
  if (process.platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => child.kill("SIGKILL"));
    return;
  }

  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function runSuite(suite, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(command, ["jest", "--runInBand", "--forceExit", suite], {
      cwd: rootDir,
      env: { ...process.env, JEST_RUN_QUARANTINED: "1" },
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    let spawnError;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        suite,
        status: classifyResult({ timedOut, exitCode, error: spawnError }),
        durationMs: performance.now() - startedAt,
        ...(exitCode === null ? {} : { exitCode }),
        ...(spawnError ? { error: spawnError.message } : {}),
      });
    };

    child.once("error", (error) => {
      spawnError = error;
      finish(null);
    });
    child.once("close", (exitCode) => finish(exitCode));
  });
}

async function main(args) {
  const options = parseArgs(args);
  const quarantineFile = path.join(rootDir, "jest.quarantine.json");
  const entries = JSON.parse(readFileSync(quarantineFile, "utf8"));
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
    throw new Error("jest.quarantine.json must contain an array of suite paths");
  }

  const suites = entries.filter((suite) => matchesFilter(suite, options.filter));
  const results = [];
  for (const suite of suites) {
    if (!existsSync(path.resolve(rootDir, suite))) {
      results.push({ suite, status: "SKIP", durationMs: 0, error: "File not found" });
      continue;
    }
    results.push(await runSuite(suite, options.timeoutMs));
  }

  console.log(formatReport(results));
  if (options.jsonFile) {
    const reportFile = path.resolve(options.jsonFile);
    mkdirSync(path.dirname(reportFile), { recursive: true });
    writeFileSync(
      reportFile,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          timeoutMs: options.timeoutMs,
          filter: options.filter ?? null,
          summary: results.reduce(
            (counts, { status }) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }),
            {},
          ),
          suites: results,
        },
        null,
        2,
      )}\n`,
    );
  }

  if (options.strict && results.some(({ status }) => status !== "PASS")) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Quarantine runner failed: ${error.message}`);
    process.exitCode = 1;
  });
}
