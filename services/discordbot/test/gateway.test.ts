import { describe, expect, it } from "bun:test";
import type { Chat, Logger } from "chat";
import { createGatewayController } from "../src/gateway";
import type { GatewayCapableAdapter } from "../src/types";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const fakeChat = { initialize: async () => undefined } as unknown as Chat;

/**
 * Fake adapter mirroring `startGatewayListener`'s contract: it registers a long-lived promise
 * via `waitUntil` and resolves it when the abort signal fires (graceful stop).
 */
function fakeAdapter(): {
  adapter: GatewayCapableAdapter;
  endListener: () => void;
} {
  let endListener!: () => void;
  const listenerPromise = new Promise<void>((resolve) => {
    endListener = resolve;
  });
  const adapter: GatewayCapableAdapter = {
    async startGatewayListener(options, _durationMs, abortSignal) {
      abortSignal?.addEventListener("abort", () => endListener());
      options.waitUntil(listenerPromise);
      return new Response("ok");
    },
  };
  return { adapter, endListener };
}

describe("createGatewayController", () => {
  it("marks active once started", async () => {
    const { adapter } = fakeAdapter();
    const controller = createGatewayController({
      logger: silentLogger,
      onFatalEnd: () => undefined,
    });
    expect(controller.isActive()).toBe(false);
    await controller.start(fakeChat, adapter);
    expect(controller.isActive()).toBe(true);
  });

  it("does not treat a shutdown-triggered end as fatal", async () => {
    let fatal = false;
    const { adapter } = fakeAdapter();
    const controller = createGatewayController({
      logger: silentLogger,
      onFatalEnd: () => {
        fatal = true;
      },
    });
    await controller.start(fakeChat, adapter);
    await controller.shutdown();
    expect(controller.isActive()).toBe(false);
    expect(fatal).toBe(false);
  });

  it("treats an unexpected connection end as fatal", async () => {
    let fatal = false;
    const { adapter, endListener } = fakeAdapter();
    const controller = createGatewayController({
      logger: silentLogger,
      onFatalEnd: () => {
        fatal = true;
      },
    });
    await controller.start(fakeChat, adapter);
    endListener(); // connection dropped without a shutdown request
    await Bun.sleep(5);
    expect(fatal).toBe(true);
    expect(controller.isActive()).toBe(false);
  });
});
