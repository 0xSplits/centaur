import { AsyncLocalStorage } from "node:async_hooks";

export type GithubbotRequestContext = {
  retryableErrors: unknown[];
  waitUntil(promise: Promise<unknown>): void;
};

type WaitUntilContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export const requestContext = new AsyncLocalStorage<GithubbotRequestContext>();

/**
 * Attach a fire-and-forget promise to the in-flight request's keep-alive budget
 * when one is active, so the background turn outlives the webhook ack. Outside a
 * request (startup tasks) it just runs detached with a swallowed rejection.
 */
export function backgroundWaitUntil(promise: Promise<unknown>): void {
  const context = requestContext.getStore();
  if (context) {
    context.waitUntil(promise);
    return;
  }
  void promise.catch(() => undefined);
}

export function waitUntil(
  c: { executionCtx: WaitUntilContext },
  promise: Promise<unknown>,
): void {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    void promise.catch(() => undefined);
  }
}
