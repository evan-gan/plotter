// Real USB-serial transport (XIAO RP2040 @ 115200). serialport is loaded
// lazily so simulate-mode development works even where the native module
// isn't built (e.g. CI).

import { BaseConnection, delay } from "./connection";

export const BAUD = 115200;
const USB_PORT_PATTERN = /usbmodem|usbserial|ttyACM|ttyUSB/i;

interface SerialPortLike {
  write(data: string | Uint8Array): void;
  pipe(parser: NodeJS.EventEmitter): NodeJS.EventEmitter;
  flush(): void;
  close(callback: () => void): void;
  isOpen: boolean;
}

function loadSerialport(): {
  SerialPort: new (opts: { path: string; baudRate: number }, cb: (err: Error | null) => void) => SerialPortLike;
  ReadlineParser: new (opts: { delimiter: string }) => NodeJS.EventEmitter;
  list(): Promise<{ path: string }[]>;
} {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("serialport");
    return { SerialPort: mod.SerialPort, ReadlineParser: mod.ReadlineParser, list: () => mod.SerialPort.list() };
  } catch (error) {
    throw new Error(
      `The serialport module is unavailable (${(error as Error).message}). ` +
        "Run `pnpm install` in software/, or set PLOTTER_SIMULATE=1 to run without hardware."
    );
  }
}

/** Pick the plotter's serial device: explicit override, else USB autodetect. */
export async function resolvePort(preferred?: string): Promise<string> {
  if (preferred) return preferred;
  const ports = await loadSerialport().list();
  const candidates = ports
    .map((entry) => entry.path)
    .filter((portPath) => USB_PORT_PATTERN.test(portPath))
    // macOS: prefer the cu.* call-out node over the tty.* dial-in node.
    .map((portPath) => (process.platform === "darwin" ? portPath.replace("/dev/tty.", "/dev/cu.") : portPath));
  if (candidates.length === 0) {
    throw new Error(
      "No plotter serial port found. Plug the board in (running firmware, not the RPI-RP2 bootloader), " +
        "set PLOTTER_SERIAL, or set PLOTTER_SIMULATE=1."
    );
  }
  return candidates[0];
}

export class SerialConnection extends BaseConnection {
  readonly description: string;
  private port: SerialPortLike;

  private constructor(port: SerialPortLike, portPath: string) {
    super();
    this.port = port;
    this.description = portPath;
  }

  /** Open + settle (RP2040 USB CDC needs a beat before accepting input). */
  static async open(portPath: string, baud = BAUD): Promise<SerialConnection> {
    const { SerialPort, ReadlineParser } = loadSerialport();
    const port = await new Promise<SerialPortLike>((resolve, reject) => {
      const candidate: SerialPortLike = new SerialPort({ path: portPath, baudRate: baud }, (err) =>
        err ? reject(err) : resolve(candidate)
      );
    });
    const connection = new SerialConnection(port, portPath);
    const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
    parser.on("data", (raw: string) => connection.receiveLine(raw));
    await delay(500);
    port.flush();
    return connection;
  }

  sendRaw(data: string | Uint8Array): void {
    this.port.write(data);
  }

  sendLineRaw(line: string): void {
    this.port.write(line + "\n");
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.port.isOpen) this.port.close(() => resolve());
      else resolve();
    });
  }
}
