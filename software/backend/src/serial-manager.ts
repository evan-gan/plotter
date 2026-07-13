// Owns THE connection to the plotter (serial is exclusive — one owner).
// The connection is optional by design: the server runs fine with no board
// attached (queue/uploads/ETA still work), reconnects on demand, and swaps
// in the simulator when PLOTTER_SIMULATE=1.

import { BaseConnection } from "./connection";
import { SerialConnection, resolvePort } from "./serial-connection";
import { SimulatedConnection } from "./simulated-connection";
import { EventBus } from "./events";

export class SerialManager {
  private connection: BaseConnection | null = null;
  private connecting: Promise<BaseConnection> | null = null;
  private simulate: boolean;
  private preferredPort: string;
  private bus: EventBus;

  constructor(options: { simulate: boolean; preferredPort: string; bus: EventBus }) {
    this.simulate = options.simulate;
    this.preferredPort = options.preferredPort;
    this.bus = options.bus;
  }

  get isConnected(): boolean {
    return this.connection !== null;
  }

  get portDescription(): string {
    return this.connection?.description ?? (this.simulate ? "simulator (not started)" : "disconnected");
  }

  /** Get the live connection, opening it if needed. Throws a clear error when
   *  no board can be reached — callers surface that to the UI as-is. */
  async ensure(): Promise<BaseConnection> {
    if (this.connection) return this.connection;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try {
      this.connection = await this.connecting;
      this.bus.broadcast({ type: "serial", connected: true, port: this.connection.description });
      this.bus.log(`Serial connected: ${this.connection.description}`);
      return this.connection;
    } finally {
      this.connecting = null;
    }
  }

  private async open(): Promise<BaseConnection> {
    if (this.simulate) return new SimulatedConnection();
    const portPath = await resolvePort(this.preferredPort || undefined);
    try {
      return await SerialConnection.open(portPath);
    } catch (error) {
      throw new Error(`Can't open ${portPath}: ${(error as Error).message}. Is another program using the port?`);
    }
  }

  /** Drop a connection that started erroring so the next call reconnects. */
  async drop(reason: string): Promise<void> {
    if (!this.connection) return;
    const stale = this.connection;
    this.connection = null;
    this.bus.broadcast({ type: "serial", connected: false, port: null });
    this.bus.log(`Serial disconnected (${reason}).`);
    try {
      await stale.close();
    } catch {
      /* already gone */
    }
  }

  async close(): Promise<void> {
    await this.drop("server shutdown");
  }
}
