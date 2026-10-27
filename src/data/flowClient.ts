import { MAX_FLOW_GAP_MS } from "../../shared/config";
import type { LevelField } from "../../shared/decodeFrame";
import type { FlowField } from "../motion/flow";
import type { FlowReply } from "../motion/flow.worker";

/** A request the worker hasn't answered within this long resolves with a zero flow. */
export const FLOW_TIMEOUT_MS = 5000;

/** The part of `Worker` the client uses (a fake in tests). */
export type FlowWorkerLike = {
  postMessage(msg: { id: number; a: Uint8Array; b: Uint8Array; gapMs: number }): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<FlowReply>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
};

/** A fresh zero grid each time (callers may hand it to the GPU; never share one buffer). */
const zeroFlow = (): FlowField => ({ gw: 1, gh: 1, data: new Float32Array(2) });

const defaultWorker = (): FlowWorkerLike =>
  new Worker(new URL("../motion/flow.worker.ts", import.meta.url), { type: "module" }) as unknown as FlowWorkerLike;

type Job = { id: number; a: LevelField; b: LevelField; gapMs: number; resolve: (f: FlowField) => void };

/**
 * Client for `flow.worker.ts`. Requests are sent one at a time in the order made, so each request's
 * timeout runs only while the worker is actually working on it (a long queue never times out).
 * Never rejects: a timeout or worker error gives a zero flow (which renders as a plain crossfade),
 * and a timeout also replaces the worker in case it is stuck. Frame buffers are copied, not
 * transferred, because the store keeps them.
 */
export function createFlowClient(makeWorker: () => FlowWorkerLike = defaultWorker, timeoutMs = FLOW_TIMEOUT_MS) {
  let worker: FlowWorkerLike | null = null;
  let nextId = 1;
  const queue: Job[] = [];
  let current: Job | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = (flow: FlowField) => {
    const job = current;
    if (!job) return;
    current = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    job.resolve(flow);
    pump();
  };

  const ensureWorker = (): FlowWorkerLike => {
    if (worker) return worker;
    const w = makeWorker();
    w.onmessage = (e) => {
      if (w === worker && current && e.data.id === current.id) finish(e.data.flow);
    };
    w.onerror = () => {
      if (w === worker) finish(zeroFlow());
    };
    worker = w;
    return w;
  };

  function pump() {
    if (current || queue.length === 0) return;
    const job = queue.shift()!;
    current = job;
    timer = setTimeout(() => {
      console.warn(`flow: no reply within ${timeoutMs} ms; using zero flow and restarting the worker`);
      worker?.terminate();
      worker = null;
      finish(zeroFlow());
    }, timeoutMs);
    ensureWorker().postMessage({ id: job.id, a: job.a.data, b: job.b.data, gapMs: job.gapMs });
  }

  return {
    compute(a: LevelField, b: LevelField, gapMs: number): Promise<FlowField> {
      if (gapMs > MAX_FLOW_GAP_MS) return Promise.resolve(zeroFlow());
      return new Promise<FlowField>((resolve) => {
        queue.push({ id: nextId++, a, b, gapMs, resolve });
        pump();
      });
    },
    /** Stops the worker; pending requests resolve with zero flows. */
    terminate(): void {
      worker?.terminate();
      worker = null;
      for (const job of queue.splice(0)) job.resolve(zeroFlow());
      finish(zeroFlow());
    },
  };
}

export type FlowClient = ReturnType<typeof createFlowClient>;
