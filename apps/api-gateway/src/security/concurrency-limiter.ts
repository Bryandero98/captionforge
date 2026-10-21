export type Release = () => void;

export type LimiterOptions = {
  /** Máximo de huecos ocupados a la vez en total. 0 = sin límite. */
  total: number;
  /** Máximo por clave (p. ej. la IP del cliente). 0 = sin límite. */
  perKey: number;
};

export type Denied = "total" | "key";

/**
 * Limita cuántas operaciones largas (subidas, flujos SSE) corren a la vez. El límite por minuto no basta:
 * cuenta cuántas empiezan, no cuántas siguen vivas, y una subida o un flujo pueden durar horas.
 *
 * Cada hueco devuelve un `release` idempotente. Con `ttlMs` el hueco se libera solo al vencer, para que un
 * `release` que nunca llegue (la petición murió antes de registrar su limpieza) no lo pierda para siempre.
 */
export class ConcurrencyLimiter {
  private inUse = 0;
  private readonly perKeyInUse = new Map<string, number>();

  constructor(private readonly options: LimiterOptions) {}

  get active(): number {
    return this.inUse;
  }

  tryAcquire(key = "", ttlMs?: number): { release: Release } | { denied: Denied } {
    const { total, perKey } = this.options;
    if (total > 0 && this.inUse >= total) return { denied: "total" };
    if (perKey > 0 && (this.perKeyInUse.get(key) ?? 0) >= perKey) return { denied: "key" };

    this.inUse += 1;
    this.perKeyInUse.set(key, (this.perKeyInUse.get(key) ?? 0) + 1);

    let released = false;
    let timer: NodeJS.Timeout | undefined;
    const release: Release = () => {
      if (released) return;
      released = true;
      if (timer) clearTimeout(timer);
      this.inUse -= 1;
      const left = (this.perKeyInUse.get(key) ?? 1) - 1;
      if (left <= 0) this.perKeyInUse.delete(key);
      else this.perKeyInUse.set(key, left);
    };
    if (ttlMs !== undefined && ttlMs > 0) {
      timer = setTimeout(release, ttlMs);
      timer.unref();
    }
    return { release };
  }
}
