import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valida el id del trabajo y lo normaliza a minúsculas. PostgreSQL trata el uuid sin distinguir
 * mayúsculas, pero el contrato (Uuid) y los ids de BullMQ sí: "ABC…" encontraba la fila y luego no
 * encontraba el trabajo en la cola ni pasaba la validación del mensaje de cancelación.
 */
@Injectable()
export class JobIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== "string" || !UUID.test(value)) {
      throw new BadRequestException("El id del trabajo no es un UUID válido.");
    }
    return value.toLowerCase();
  }
}
