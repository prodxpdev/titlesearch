// Minimal types for the Workers TCP sockets API, so this package doesn't need
// @cloudflare/workers-types.
declare module "cloudflare:sockets" {
  interface Socket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    closed: Promise<void>;
    close(): Promise<void>;
  }
  export function connect(address: { hostname: string; port: number }): Socket;
}
