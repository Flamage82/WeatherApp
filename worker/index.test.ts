import { beforeEach, describe, expect, it, vi } from "vitest";

const close = vi.fn(async () => {});
vi.mock("./ftp", () => ({ openBomFtp: vi.fn(async () => ({ list: vi.fn(), retrieve: vi.fn(), close })) }));
const runIngest = vi.fn();
vi.mock("./ingest", () => ({ runIngest: (deps: unknown) => runIngest(deps) }));
import worker from "./index";

const report = (n: number) => ({ added: { IDR503: n }, errors: [] });

async function scheduled() {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  await worker.scheduled!({ cron: "* * * * *", scheduledTime: Date.UTC(2026, 9, 27, 3, 5) } as ScheduledController, { BUCKET: {} } as never, ctx as never);
  await Promise.all(waits);
}

describe("scheduled", () => {
  beforeEach(() => {
    runIngest.mockReset();
    close.mockClear();
  });

  it("runs both radars in one call, each on its own FTP connection", async () => {
    runIngest.mockResolvedValue(report(2));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await scheduled();
    expect(runIngest.mock.calls.map((c) => c[0].radar).sort()).toEqual(["marburg", "stapylton"]);
    expect(close).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toBe("marburg +2 | stapylton +2");
    log.mockRestore();
  });

  it("one radar failing does not stop the other", async () => {
    runIngest.mockImplementation(async (d: { radar: string }) => {
      if (d.radar === "marburg") throw new Error("boom");
      return report(1);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await scheduled();
    expect(runIngest).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]![0]).toBe("marburg ingest failed: boom | stapylton +1");
    log.mockRestore();
  });
});
