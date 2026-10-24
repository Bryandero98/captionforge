// Escáner de fugas de claves externas (ADR 0020): busca un secreto, y las formas triviales en que un descuido lo dejaría, en los sitios
// donde no debe estar. Lo comparten la prueba canario y la E2E de traducir/doblar.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Redis } from "ioredis";

export interface Haystack {
  where: string;
  text: string;
}

export interface Needle {
  name: string;
  value: string;
}

/** El secreto completo y sus formas triviales: trozo central, sufijo, base64 (con los tres desfases), URL codificada y hexadecimal. */
export function needlesFor(secret: string): Needle[] {
  return [
    { name: "clave completa", value: secret },
    { name: "trozo central", value: secret.slice(3, 28) },
    { name: "sufijo", value: secret.slice(-16) },
    { name: "base64", value: Buffer.from(secret).toString("base64").replace(/=+$/, "") },
    { name: "base64 con desfase 1", value: Buffer.from(`x${secret}`).toString("base64").slice(2).replace(/=+$/, "") },
    { name: "base64 con desfase 2", value: Buffer.from(`xx${secret}`).toString("base64").slice(3).replace(/=+$/, "") },
    { name: "URL codificada", value: encodeURIComponent(secret) },
    { name: "hexadecimal", value: Buffer.from(secret).toString("hex") },
  ];
}

/** Devuelve cada lugar donde aparece alguna de las formas del secreto. Vacío = cero fugas. */
export function findLeaks(haystacks: Haystack[], needles: Needle[]): string[] {
  const leaks: string[] = [];
  for (const { where, text } of haystacks) {
    for (const needle of needles) {
      if (text.includes(needle.value)) leaks.push(`${where} contiene ${needle.name}`);
    }
  }
  return leaks;
}

/** Todas las claves de Redis serializadas con DUMP (sirve para cualquier tipo: cadena, hash, lista, flujo, conjunto ordenado). */
export async function redisHaystacks(redis: Redis): Promise<Haystack[]> {
  const names: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "COUNT", 500);
    names.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  const found: Haystack[] = [];
  for (const name of names) {
    const dump = (await redis.callBuffer("DUMP", name)) as Buffer | null;
    found.push({ where: `redis:${name}`, text: Buffer.concat([Buffer.from(name), dump ?? Buffer.alloc(0)]).toString("latin1") });
  }
  return found;
}

/** Nombres y contenido de todos los archivos bajo `root`. */
export function dirHaystacks(root: string): Haystack[] {
  const found: Haystack[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      found.push({ where: `work:${path.slice(root.length)}`, text: path.slice(root.length) });
      if (statSync(path).isDirectory()) walk(path);
      else found.push({ where: `work:${path.slice(root.length)}`, text: readFileSync(path).toString("latin1") });
    }
  };
  walk(root);
  return found;
}
