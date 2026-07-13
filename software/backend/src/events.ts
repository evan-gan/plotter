// Server-Sent-Events fan-out. Every browser tab subscribes to /api/events;
// services publish typed events here and the HTTP layer forwards them.

import { ServerResponse } from "http";

export interface BusEvent {
  type: string;
  [key: string]: unknown;
}

export class EventBus {
  private clients = new Set<ServerResponse>();
  private history: BusEvent[] = []; // recent log lines for late joiners
  private static readonly HISTORY_LIMIT = 200;

  addClient(response: ServerResponse, snapshot: BusEvent[]): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write("\n");
    for (const event of snapshot) response.write(`data: ${JSON.stringify(event)}\n\n`);
    for (const event of this.history) response.write(`data: ${JSON.stringify(event)}\n\n`);
    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));
  }

  broadcast(event: BusEvent): void {
    if (event.type === "log") {
      this.history.push(event);
      if (this.history.length > EventBus.HISTORY_LIMIT) this.history.shift();
    }
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  log(text: string): void {
    this.broadcast({ type: "log", text, at: Date.now() });
  }

  /** Keep proxies/browsers from dropping quiet connections. */
  startHeartbeat(intervalMs = 25000): NodeJS.Timeout {
    const timer = setInterval(() => {
      for (const client of this.clients) client.write(": ping\n\n");
    }, intervalMs);
    timer.unref();
    return timer;
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
