import { expect, vi } from "vitest";

/** A WebSocket stand-in that records sent messages and opens on request. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.(new CloseEvent("close", { code: 1000 }));
  }
}

/** {@link FakeWebSocket} as the `webSocketConstructor` of a Convex client. */
export const webSocketConstructor =
  FakeWebSocket as unknown as typeof WebSocket;

/** Fires the open event on the one fake socket and returns it. */
export async function openSocket(): Promise<FakeWebSocket> {
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  socket.onopen?.(new Event("open"));
  return socket;
}

/** The message types a fake socket sent, in order. */
export function sentTypes(socket: FakeWebSocket): unknown[] {
  return socket.sent.map((m) => (JSON.parse(m) as { type: unknown }).type);
}
