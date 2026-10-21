import { isIPv6 } from "node:net";

/**
 * Clave con la que se agrupa a un cliente en los límites. IPv4 tal cual (las IPv4 mapeadas en IPv6 se
 * desenvuelven); IPv6 por /64, porque una sola conexión residencial recibe 2^64 direcciones y, sin agrupar,
 * rotar la parte baja daría un cupo nuevo en cada petición.
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!isIPv6(ip)) return ip;

  const [head = "", tail] = ip.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = tail === undefined ? 0 : 8 - front.length - back.length;
  const hextets = [...front, ...Array<string>(Math.max(missing, 0)).fill("0"), ...back];
  return `${hextets.slice(0, 4).map((h) => parseInt(h || "0", 16).toString(16)).join(":")}::/64`;
}
