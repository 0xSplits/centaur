import type { Chat, Logger } from "chat";
import type { GatewayCapableAdapter } from "./types";

/**
 * One year. `startGatewayListener` treats `durationMs` as a self-destruct timer; within that
 * window discord.js maintains a single Gateway session with native RESUME, so a very large value
 * gives us one long-lived connection rather than a re-IDENTIFY loop (which would burn the
 * 1000/24h IDENTIFY budget). If the connection ends before this elapses it's a fatal/login error
 * and we let the process exit so Kubernetes restarts the pod.
 */
const LONG_RUNNING_MS = 365 * 24 * 60 * 60 * 1000;

export type GatewayController = {
  /** True once the listener has started and the connection has not ended. */
  isActive(): boolean;
  /** Initialize the chat instance and open the single long-lived Gateway connection. */
  start(chat: Chat, adapter: GatewayCapableAdapter): Promise<void>;
  /** Stop accepting Gateway work and wait for the connection to close. */
  shutdown(): Promise<void>;
};

type GatewayControllerDeps = {
  logger: Logger;
  /** Override for tests — defaults to `process.exit`. */
  onFatalEnd?: () => void;
};

export function createGatewayController(
  deps: GatewayControllerDeps,
): GatewayController {
  const { logger } = deps;
  const onFatalEnd = deps.onFatalEnd ?? (() => process.exit(1));
  const abort = new AbortController();
  let active = false;
  let shuttingDown = false;
  let monitor: Promise<void> | undefined;

  return {
    isActive: () => active,

    async start(chat, adapter) {
      // Adapters initialize lazily (normally on the first webhook). Direct-mode Gateway
      // processing needs the adapter wired to the chat instance up front.
      await chat.initialize();

      const tracked: Array<Promise<unknown>> = [];
      // Direct mode: no webhookUrl, so MessageCreate is dispatched through Chat in-process.
      await adapter.startGatewayListener(
        {
          waitUntil: (promise) =>
            tracked.push(Promise.resolve(promise).catch(() => undefined)),
        },
        LONG_RUNNING_MS,
        abort.signal,
        undefined,
      );
      active = true;
      logger.info("discordbot_gateway_started");

      monitor = Promise.all(tracked)
        .then(() => undefined)
        .finally(() => {
          active = false;
          if (shuttingDown) {
            logger.info("discordbot_gateway_stopped");
            return;
          }
          // A single long-lived connection ended on its own — almost always a fatal error
          // (invalid token / disallowed intents). Exit so k8s restarts with backoff.
          logger.error("discordbot_gateway_ended_unexpectedly");
          onFatalEnd();
        });
    },

    async shutdown() {
      shuttingDown = true;
      abort.abort();
      if (monitor) await monitor;
    },
  };
}
