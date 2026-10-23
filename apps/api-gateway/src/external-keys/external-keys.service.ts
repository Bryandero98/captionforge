import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CURRENT_KEY_VERSION, ExternalKeyCipher, type ExternalProvider, isExternalProvider, keyHint } from "./external-key-crypto.js";
import { normalizeExternalKey } from "./external-key-format.js";

/** Lo único que sale de aquí hacia la interfaz: jamás la clave ni su cifrado. */
export interface ExternalKeyView {
  provider: ExternalProvider;
  last4: string;
  createdAt: string;
  rotatedAt: string | null;
}

/** Error con `code` estable: la interfaz decide el texto por el código, no por el mensaje (como `role_forbidden`). */
const coded = (Exception: typeof BadRequestException | typeof NotFoundException, status: number, error: string, code: string, message: string) =>
  new Exception({ statusCode: status, error, code, message });

/**
 * Claves externas propias del espacio de trabajo (ADR 0020). Todo se filtra por el espacio de la petición; la clave se cifra antes
 * de tocar la base y nada de lo que se registra o se devuelve la contiene.
 */
@Injectable()
export class ExternalKeysService {
  private readonly logger = new Logger(ExternalKeysService.name);
  private readonly cipher: ExternalKeyCipher | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.cipher = config.byok.appSecret === undefined ? undefined : new ExternalKeyCipher(config.byok.appSecret);
  }

  /** Sin APP_SECRET la función está apagada: 404, nunca un cifrado con un valor por defecto. */
  private requireCipher(): ExternalKeyCipher {
    if (this.cipher === undefined) throw coded(NotFoundException, 404, "Not Found", "byok_disabled", "Las claves externas propias no están activadas en este servidor.");
    return this.cipher;
  }

  private provider(raw: string): ExternalProvider {
    if (!isExternalProvider(raw)) throw coded(BadRequestException, 400, "Bad Request", "invalid_provider", "Proveedor no admitido.");
    return raw;
  }

  async list(tenantId: string): Promise<{ keys: ExternalKeyView[] }> {
    this.requireCipher();
    const rows = await this.prisma.tenantExternalKey.findMany({
      where: { tenantId },
      orderBy: { provider: "asc" },
      select: { provider: true, last4: true, createdAt: true, rotatedAt: true }, // sin `ciphertext`: ni siquiera sale de la base
    });
    return { keys: rows.map(toView) };
  }

  async put(tenantId: string, userId: string, rawProvider: string, body: unknown): Promise<ExternalKeyView> {
    const cipher = this.requireCipher();
    const provider = this.provider(rawProvider);
    const raw = typeof body === "object" && body !== null ? (body as { key?: unknown }).key : undefined;
    const key = normalizeExternalKey(provider, raw);
    // El mensaje no repite lo recibido: una clave mal pegada sigue siendo una clave.
    if (key === undefined) throw coded(BadRequestException, 400, "Bad Request", "invalid_key_format", "La clave no tiene el formato de ese proveedor.");

    const ciphertext = cipher.encrypt(key, { tenantId, provider, keyVersion: CURRENT_KEY_VERSION });
    const last4 = keyHint(key);
    const now = new Date();
    const row = await this.prisma.tenantExternalKey.upsert({
      where: { tenantId_provider: { tenantId, provider } },
      create: { id: randomUUID(), tenantId, provider, ciphertext, keyVersion: CURRENT_KEY_VERSION, last4, createdBy: userId },
      update: { ciphertext, keyVersion: CURRENT_KEY_VERSION, last4, createdBy: userId, rotatedAt: now },
      select: { provider: true, last4: true, createdAt: true, rotatedAt: true },
    });
    this.logger.log(`Clave externa ${provider} guardada: espacio ${tenantId}, por ${userId}`);
    return toView(row);
  }

  async remove(tenantId: string, rawProvider: string): Promise<void> {
    this.requireCipher();
    const provider = this.provider(rawProvider);
    const { count } = await this.prisma.tenantExternalKey.deleteMany({ where: { tenantId, provider } });
    if (count === 0) throw coded(NotFoundException, 404, "Not Found", "external_key_not_found", "No hay una clave guardada para ese proveedor.");
    this.logger.log(`Clave externa ${provider} borrada: espacio ${tenantId}`);
  }
}

const toView = (row: { provider: ExternalProvider; last4: string; createdAt: Date; rotatedAt: Date | null }): ExternalKeyView => ({
  provider: row.provider,
  last4: row.last4,
  createdAt: row.createdAt.toISOString(),
  rotatedAt: row.rotatedAt === null ? null : row.rotatedAt.toISOString(),
});
