import {
  CLIENT_METHODS,
  ClientSideConnection,
  type Agent,
  type AnyMessage,
  type Client,
  type Stream,
} from "@agentclientprotocol/sdk";

// Notifications the SDK routes to typed Client methods; every other inbound
// notification reaches Client.extNotification.
const TYPED_CLIENT_NOTIFICATIONS: ReadonlySet<string> = new Set([
  CLIENT_METHODS.session_update,
  CLIENT_METHODS.elicitation_complete,
]);

// Upper bound on holding the stream for one extension notification; delivery
// normally takes a few microtasks.
const EXTENSION_NOTIFICATION_DELIVERY_TIMEOUT_MS = 1000;

export function createACPConnection(
  toClient: (agent: Agent) => Client,
  transport: Stream,
): ClientSideConnection {
  const gate = new ExtensionNotificationGate();
  const connection = new ClientSideConnection(
    (agent) => gate.wrap(toClient(agent)),
    gate.stream(transport),
  );
  void connection.closed.finally(() => gate.close());
  return connection;
}

function isExtensionNotification(message: AnyMessage): boolean {
  return (
    "method" in message &&
    !("id" in message && message.id != null) &&
    !TYPED_CLIENT_NOTIFICATIONS.has(message.method)
  );
}

/**
 * Keeps extension notifications in order with the session updates around them.
 *
 * The SDK dispatches every inbound message concurrently, walking its handler
 * chain with an await per handler. Typed handlers sit near the front of the
 * chain and the extension-notification fallback at the very end, so a burst
 * of messages delivers each extension notification several session updates
 * late. That breaks helper notifications whose position in the stream
 * matters: camber/acp/session_replay_started, sent just before a live-attach
 * snapshot, would discard the snapshot's first events (the conversation's
 * initial prompt) instead of the live updates that preceded it.
 *
 * The gate holds the inbound stream after each extension notification until
 * the client has received it, so later messages enter the SDK only afterwards.
 */
class ExtensionNotificationGate {
  private waiting: Array<() => void> = [];
  private closed = false;
  // Without an extNotification handler the SDK drops extension notifications
  // unseen, so there is nothing to wait for.
  private enabled = false;

  stream(transport: Stream): Stream {
    const gate = this;
    return {
      writable: transport.writable,
      readable: transport.readable.pipeThrough(
        new TransformStream<AnyMessage, AnyMessage>({
          async transform(message, controller) {
            if (!gate.enabled || gate.closed || !isExtensionNotification(message)) {
              controller.enqueue(message);
              return;
            }
            let release!: () => void;
            const delivered = new Promise<void>((resolve) => {
              release = resolve;
              gate.waiting.push(resolve);
            });
            controller.enqueue(message);
            // Bounded so a notification the SDK drops before the client (a
            // malformed message, a handler error) can never stall the stream.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timedOut = new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                gate.waiting = gate.waiting.filter((waiter) => waiter !== release);
                resolve();
              }, EXTENSION_NOTIFICATION_DELIVERY_TIMEOUT_MS);
            });
            await Promise.race([delivered, timedOut]);
            clearTimeout(timer);
          },
        }),
      ),
    };
  }

  wrap(client: Client): Client {
    const extNotification = client.extNotification?.bind(client);
    if (!extNotification) return client;
    this.enabled = true;
    client.extNotification = (method, params) => {
      // Extension notifications reach the client in stream order, so the
      // oldest waiter is this notification's.
      this.waiting.shift()?.();
      return extNotification(method, params);
    };
    return client;
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}
