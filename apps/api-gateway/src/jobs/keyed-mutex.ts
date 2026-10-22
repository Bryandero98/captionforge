/**
 * Exclusión mutua por clave dentro de UN proceso: las tareas con la misma clave corren de una en una y en orden de
 * llegada; las de claves distintas no se esperan. Sirve para que «leer el ETag, comparar y escribir» de los subtítulos
 * de un trabajo sea atómico frente a otras peticiones del mismo API.
 *
 * Límite conocido: si hay varias réplicas del API, cada una tiene su propio mutex. Entonces haría falta una escritura
 * condicional en S3 (`If-Match`) o un bloqueo en PostgreSQL; con un solo proceso esto es suficiente.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Un fallo de la tarea anterior no debe impedir las siguientes.
    const result = previous.catch(() => undefined).then(task);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      // Sin cola pendiente se olvida la clave: el mapa no crece con cada trabajo editado.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
