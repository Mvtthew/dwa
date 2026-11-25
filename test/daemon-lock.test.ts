import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeLock } from "../src/daemon/main.ts";

let dir: string;
let lock: string;
let socket: string;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dwa-lock-"));
  lock = join(dir, "daemon.lock");
  socket = join(dir, "d.sock");
});
afterEach(() => {
  server?.stop(true);
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("the daemon's lock", () => {
  test("the first daemon takes it and writes its pid", async () => {
    expect(await takeLock(lock, socket)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  });

  test("a lock left by a daemon that is gone is taken over", async () => {
    // No process has this pid: the highest allowed is far below it.
    writeFileSync(lock, "999999999");
    expect(await takeLock(lock, socket)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  });

  test("a second daemon leaves when the first one answers on the socket", async () => {
    server = Bun.serve({ unix: socket, fetch: () => new Response("{}") });
    // The owner is alive (the test runner's parent) and the socket answers.
    writeFileSync(lock, String(process.ppid));
    expect(await takeLock(lock, socket)).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(String(process.ppid));
  });

  test("a live process that is not a daemon does not keep the lock", async () => {
    writeFileSync(lock, String(process.ppid));
    expect(await takeLock(lock, socket)).toBe(true);
  }, 10000);
});
