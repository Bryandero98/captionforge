import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CURRENT_KEY_VERSION, ExternalKeyCipher, type ExternalProvider, isExternalProvider, keyHint } from "./external-key-crypto.js";
import { parseBaseUrl } from "./base-url.js";
import { normalizeExternalKey } from "./external-key-format.js";

/** Lo único que sale de aquí hacia la interfaz: jamás la clave ni su cifrado. */
export interface ExternalKeyView {
  provider: ExternalProvider;
  last4: string;
  createdAt: string;
  rotatedAt: string | null;
  /** Solo el host de la URL base propia (ADR 0022); nunca la URL completa. Nulo = el host fijo del proveedor. */
  baseUrlHost: string | null;
}

/** No hay clave guardada para ese espacio y proveedor (la entrega al worker lo traduce a 404). */
export class ExternalKeyNotFoundError extends Error {
  constructor() {
    super("No hay una clave guardada para ese proveedor.");
    this.name = "ExternalKeyNotFoundError";
  }
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
    if (this.cipher === undefined) this.logger.warn("APP_SECRET no está definido: las claves externas propias están desactivadas.");
  }

  /** ¿Está activa la función (hay APP_SECRET)? */
  get enabled(): boolean {
    return this.cipher !== undefined;
  }

  /**
   * Descifra la clave de un espacio para ENTREGARLA al worker por el canal interno. Es el único sitio donde la clave sale de la base en
   * claro: quien llama (internal-server) ya comprobó el token y que el trabajo está en curso y es de ese espacio y proveedor.
   */
  async reveal(tenantId: string, provider: ExternalProvider): Promise<{ key: string; baseUrl?: string }> {
    const cipher = this.requireCipher();
    const row = await this.prisma.tenantExternalKey.findUnique({
      where: { tenantId_provider: { tenantId, provider } },
      select: { ciphertext: true, keyVersion: true, baseUrlCiphertext: true },
    });
    if (row === null) throw new ExternalKeyNotFoundError();
    const context = { tenantId, provider, keyVersion: row.keyVersion };
    const key = cipher.decrypt(row.ciphertext, context);
    // La URL base (ADR 0022) se descifra con su propósito: un cifrado de la clave, o de otra fila, no sirve como URL.
    if (row.baseUrlCiphertext === null) return { key };
    return { key, baseUrl: cipher.decrypt(row.baseUrlCiphertext, { ...context, purpose: "base-url" }) };
  }

  /** ¿Tiene el espacio una clave guardada para ese proveedor? (no la descifra). Falla rápido al crear un trabajo, antes de encolarlo. */
  async has(tenantId: string, provider: ExternalProvider): Promise<boolean> {
    if (this.cipher === undefined) return false;
    return (await this.prisma.tenantExternalKey.count({ where: { tenantId, provider } })) > 0;
  }

  /** Sin APP_SECRET la función está apagada: 404, nunca un cifrado con un valor por defecto. */
  private requireCipher(): ExternalKeyCipher {
    if (this.cipher === undefined) throw coded(NotFoundException, 404, "Not Found", "byok_disabled", "Las claves externas propias no están activadas en este servidor.");
    return this.cipher;
  }

  /**
   * `baseUrl` (ADR 0022) es opcional; ausente, null o vacía significa «el host fijo del proveedor». Solo los proveedores de IA de texto
   * la admiten (ElevenLabs no). El mensaje de error no repite lo recibido.
   */
  private parseBaseUrlField(provider: ExternalProvider, body: unknown): ReturnType<typeof parseBaseUrl> {
    const raw = typeof body === "object" && body !== null ? (body as { baseUrl?: unknown }).baseUrl : undefined;
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return undefined;
    const parsed = provider === "openai" ? parseBaseUrl(raw) : undefined;
    if (parsed === undefined) {
      throw coded(BadRequestException, 400, "Bad Request", "invalid_base_url", "La URL base no es válida: debe ser una dirección https de un servidor público y solo se admite con OpenAI.");
    }
    return parsed;
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
      select: { provider: true, last4: true, createdAt: true, rotatedAt: true, baseUrlHost: true }, // sin `ciphertext`: ni siquiera sale de la base
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

    const baseUrl = this.parseBaseUrlField(provider, body);
    const context = { tenantId, provider, keyVersion: CURRENT_KEY_VERSION };
    const ciphertext = cipher.encrypt(key, context);
    // Un reemplazo es completo: sin baseUrl en el cuerpo, la URL guardada se borra (no se hereda sin que la persona la vea).
    const baseUrlCiphertext = baseUrl === undefined ? null : cipher.encrypt(baseUrl.url, { ...context, purpose: "base-url" });
    const baseUrlHost = baseUrl?.host ?? null;
    const last4 = keyHint(key);
    const now = new Date();
    const row = await this.prisma.tenantExternalKey.upsert({
      where: { tenantId_provider: { tenantId, provider } },
      create: { id: randomUUID(), tenantId, provider, ciphertext, keyVersion: CURRENT_KEY_VERSION, last4, baseUrlCiphertext, baseUrlHost, createdBy: userId },
      // createdBy no se toca: es quien la guardó primero. Quién la reemplazó queda en el registro.
      update: { ciphertext, keyVersion: CURRENT_KEY_VERSION, last4, baseUrlCiphertext, baseUrlHost, rotatedAt: now },
      select: { provider: true, last4: true, createdAt: true, rotatedAt: true, baseUrlHost: true },
    });
    // Quién la guardó o la reemplazó; de la URL solo se dice si la hay, nunca cuál.
    this.logger.log(`Clave externa ${provider} guardada: espacio ${tenantId}, por ${userId}${baseUrl === undefined ? "" : ", con URL base propia"}`);
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

const toView = (row: { provider: ExternalProvider; last4: string; createdAt: Date; rotatedAt: Date | null; baseUrlHost: string | null }): ExternalKeyView => ({
  provider: row.provider,
  last4: row.last4,
  baseUrlHost: row.baseUrlHost,
  createdAt: row.createdAt.toISOString(),
  rotatedAt: row.rotatedAt === null ? null : row.rotatedAt.toISOString(),
});
