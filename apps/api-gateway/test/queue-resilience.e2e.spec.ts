// Redis caído o colgado no debe dejar peticiones esperando minutos (auditoría v1.0-RC, hallazgo 3): la cola falla rápido y el llamador
// lo traduce a 503. Se usa un proxy TCP delante del Redis real para provocar los dos modos: conexión cortada y conexión viva que no responde.
import { randomUUID } from "node:crypto";
import net from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { QueueService, REDIS_COMMAND_TIMEOUT_MS } from "../src/queue/queue.service.js";

const config = loadConfig();
let proxy: net.Server;
let proxyPort = 0;
let forwarding = true;
const sockets = new Set<net.Socket>();
let queue: QueueService;

const timed = async (action: () => Promise<unknown>): Promise<{ ms: number; error: Error | null }> => {
  const started = Date.now();
  try {
    await action();
    return { ms: Date.now() - started, error: null };
  } catch (error) {
    return { ms: Date.now() - started, error: error as Error };
  }
};

beforeAll(async () => {
  proxy = net.createServer((client) => {
    const upstream = net.connect(config.redis.port, config.redis.host);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
    }
    client.on("data", (chunk) => forwarding && upstream.write(chunk));
    upstream.on("data", (chunk) => forwarding && client.write(chunk));
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyPort = (proxy.address() as net.AddressInfo).port;
  queue = new QueueService({ ...config, redis: { ...config.redis, host: "127.0.0.1", port: proxyPort } });
  await queue.ping(); // con Redis sano todo funciona
  expect(await queue.exists("TRANSCRIBE", randomUUID())).toBe(false);
}, 30_000);

afterAll(async () => {
  forwarding = true;
  for (const socket of sockets) socket.destroy();
  if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await queue?.onModuleDestroy().catch(() => undefined);
});

describe("la cola con Redis en problemas", () => {
  it("COLGADO (la conexión sigue abierta pero no responde): se rinde al plazo del comando, no a los minutos", async () => {
    forwarding = false;
    try {
      const ping = await timed(() => queue.ping());
      expect(ping.error, "ping debe fallar").not.toBeNull();
      expect(ping.ms).toBeGreaterThanOrEqual(REDIS_COMMAND_TIMEOUT_MS - 500);
      expect(ping.ms).toBeLessThan(REDIS_COMMAND_TIMEOUT_MS + 2500);

      const exists = await timed(() => queue.exists("TRANSCRIBE", randomUUID()));
      expect(exists.error, "consultar la cola debe fallar").not.toBeNull();
      expect(exists.ms).toBeLessThan(REDIS_COMMAND_TIMEOUT_MS + 2500);
    } finally {
      forwarding = true;
    }
  }, 40_000);

  it("CAÍDO (conexiones cortadas y puerto cerrado): falla al instante, sin cola de espera ni reintentos largos", async () => {
    const closed = new Promise<void>((resolve) => proxy.close(() => resolve())); // termina cuando se cierran las conexiones
    for (const socket of sockets) socket.destroy();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 300)); // ioredis nota el corte

    const ping = await timed(() => queue.ping());
    expect(ping.error, "ping debe fallar").not.toBeNull();
    expect(ping.ms, `ping tardó ${ping.ms} ms; con la cola offline activa esperaría decenas de segundos`).toBeLessThan(2000);

    const exists = await timed(() => queue.exists("BURN", randomUUID()));
    expect(exists.error, "consultar la cola debe fallar").not.toBeNull();
    expect(exists.ms).toBeLessThan(2000);

    const cancel = await timed(() => queue.requestCancel(randomUUID()));
    expect(cancel.error, "avisar la cancelación debe fallar").not.toBeNull();
    expect(cancel.ms).toBeLessThan(2000);
  }, 30_000);
});
