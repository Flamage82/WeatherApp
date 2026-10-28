/// <reference lib="webworker" />
import type { LevelField } from "../../shared/decodeFrame";
import { MAX_FLOW_GAP_MS } from "../../shared/config";
import { computeFlow, type FlowField } from "./flow";

type Req = { id: number; a: Uint8Array; b: Uint8Array; gapMs: number };
export type FlowReply = { id: number; flow: FlowField };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Req>) => void) | null;
  postMessage(msg: FlowReply, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const { id, a, b, gapMs } = e.data;
  const field = (data: Uint8Array): LevelField => ({ width: 512, height: 512, data });
  // Fresh zero grid for large gaps and on error (never transfer the shared ZERO_FLOW buffer).
  let flow: FlowField = { gw: 1, gh: 1, data: new Float32Array(2) };
  try {
    if (gapMs <= MAX_FLOW_GAP_MS) flow = computeFlow(field(a), field(b));
  } catch (err) {
    console.error("computeFlow failed; replying with a zero flow", err);
  }
  ctx.postMessage({ id, flow }, flow.valid ? [flow.data.buffer, flow.valid.buffer] : [flow.data.buffer]);
};
