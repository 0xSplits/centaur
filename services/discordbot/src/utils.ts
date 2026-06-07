import type { Logger } from "chat";
import type { DiscordbotOptions, DiscordbotTrace, JsonObject } from "./types";

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

export function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Math.round(nowMs() - startedAtMs));
}

export function traceLog(
  options: DiscordbotOptions,
  event: string,
  trace?: DiscordbotTrace,
  fields: JsonObject = {},
): void {
  const logger = options.logger ?? noopLogger;
  logger.info(event, {
    ...(trace
      ? {
          elapsed_ms: elapsedMs(trace.startedAtMs),
          include_context: trace.includeContext,
          message_id: trace.messageId,
          mode: trace.mode,
          open_stream: trace.openStream,
          thread_id: trace.threadId,
        }
      : {}),
    ...fields,
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function* toAsyncIterable<T>(
  source: Iterable<T>,
): AsyncIterable<T> {
  for await (const item of source) {
    yield item;
  }
}

/**
 * Single-consumer async queue bridging a producer loop to an AsyncIterable
 * consumer (e.g. the chat SDK's streaming post). push() never blocks; end()
 * lets the consumer drain the remaining items and finish.
 */
export class AsyncTextQueue implements AsyncIterable<string> {
  private readonly values: string[] = [];
  private done = false;
  private wake: (() => void) | null = null;

  push(value: string): void {
    this.values.push(value);
    this.wake?.();
  }

  end(): void {
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      const value = this.values.shift();
      if (value !== undefined) {
        yield value;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null;
          resolve();
        };
      });
    }
  }
}
