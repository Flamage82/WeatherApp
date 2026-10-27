import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FLOW_GAP_MS } from "../../shared/config";
import type { LevelField } from "../../shared/decodeFrame";
import { createFlowClient, FLOW_TIMEOUT_MS, type FlowWorkerLike } from "./flowClient";

const field = (): LevelField => ({ width: 512, height: 512, data: new Uint8Array(4) });

/** A fake worker that records requests; the test replies by hand. */
function fakeWorker() {
  const w = {
    posted: [] as { id: number; gapMs: number }[],
    terminated: 0,
    onmessage: null as FlowWorkerLike["onmessage"],
    onerror: null as FlowWorkerLike["onerror"],
    postMessage(msg: { id: number; gapMs: number }) { w.posted.push(msg); },
    terminate() { w.terminated++; },
    reply(id: number, gw: number) {
      w.onmessage?.({ data: { id, flow: { gw, gh: 1, data: new Float32Array(2 * gw) } } } as MessageEvent);
    },
  };
  return w;
}

afterEach(() => vi.useRealTimers());

describe("flow client", () => {
  it("sends one request at a time and resolves each with its reply", async () => {
    const w = fakeWorker();
    const c = createFlowClient(() => w);
    const p1 = c.compute(field(), field(), 300_000);
    const p2 = c.compute(field(), field(), 300_000);
    expect(w.posted).toHaveLength(1);
    w.reply(w.posted[0]!.id, 31);
    expect((await p1).gw).toBe(31);
    expect(w.posted).toHaveLength(2);
    w.reply(w.posted[1]!.id, 7);
    expect((await p2).gw).toBe(7);
  });

  it("falls back to a zero flow after the timeout and restarts the worker", async () => {
    vi.useFakeTimers();
    const workers = [fakeWorker(), fakeWorker()];
    let made = 0;
    const c = createFlowClient(() => workers[made++]!);
    const p1 = c.compute(field(), field(), 300_000);
    const p2 = c.compute(field(), field(), 300_000);
    await vi.advanceTimersByTimeAsync(FLOW_TIMEOUT_MS + 1);
    const f1 = await p1;
    expect(f1.gw).toBe(1);
    expect(Array.from(f1.data)).toEqual([0, 0]);
    expect(workers[0]!.terminated).toBe(1);
    // The next request goes to a fresh worker and still works.
    expect(workers[1]!.posted).toHaveLength(1);
    workers[1]!.reply(workers[1]!.posted[0]!.id, 31);
    expect((await p2).gw).toBe(31);
    // A late reply from the dead worker is ignored.
    workers[0]!.reply(workers[0]!.posted[0]!.id, 99);
  });

  it("answers gaps over MAX_FLOW_GAP_MS with a fresh zero grid without asking the worker", async () => {
    const w = fakeWorker();
    const c = createFlowClient(() => w);
    const f = await c.compute(field(), field(), MAX_FLOW_GAP_MS + 1);
    expect(w.posted).toHaveLength(0);
    expect(f).toEqual({ gw: 1, gh: 1, data: new Float32Array(2) });
  });

  it("a worker error resolves the request with a zero flow", async () => {
    const w = fakeWorker();
    const c = createFlowClient(() => w);
    const p = c.compute(field(), field(), 300_000);
    w.onerror?.(new Event("error") as ErrorEvent);
    expect((await p).gw).toBe(1);
  });
});
