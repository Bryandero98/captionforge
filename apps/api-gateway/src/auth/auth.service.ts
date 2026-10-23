import { BadGatewayException, Inject, Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { APP_CONFIG, type AppConfig, type ProviderConfig } from "../config/config.js";
import { Prisma } from "../generated/prisma/client.js";
import type { Role } from "../generated/prisma/enums.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { hashApiKey } from "../tenancy/api-key.js";
import { PROVIDERS, type Profile, type ProviderId } from "./providers.js";

const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const sha256Base64Url = (value: string): string => createHash("sha256").update(value).digest("base64url");

/** Fallo de la conversación con el proveedor (código rechazado, red, respuesta rara). El detalle va al registro, no a quien llama. */
export class ProviderError extends Error {}

export interface BeginLogin {
  url: string;
  /** Lo que hay que recordar hasta que el proveedor devuelva a la persona: `state` y verificador PKCE. */
  state: string;
  verifier: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  enabledProviders(): ProviderId[] {
    return (Object.keys(this.config.auth.providers) as ProviderId[]).filter((id) => this.config.auth.providers[id] !== undefined);
  }

  redirectUri(provider: ProviderId): string {
    return `${this.config.auth.publicUrl}/auth/${provider}/callback`;
  }

  /** Arma la dirección de autorización con `state` y PKCE (S256). */
  begin(provider: ProviderId): BeginLogin | null {
    const settings = this.config.auth.providers[provider];
    if (settings === undefined) return null;
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const url = new URL(settings.endpoints.authorize);
    url.searchParams.set("client_id", settings.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri(provider));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", PROVIDERS[provider].scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", sha256Base64Url(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString(), state, verifier };
  }

  /** Canjea el código por un token de acceso y pide el perfil. El token se usa una vez y se descarta: no se guarda. */
  async exchange(provider: ProviderId, code: string, verifier: string): Promise<Profile> {
    const settings = this.config.auth.providers[provider] as ProviderConfig;
    const definition = PROVIDERS[provider];
    const token = await this.postForm(settings.endpoints.token, {
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      code,
      redirect_uri: this.redirectUri(provider),
      grant_type: "authorization_code",
      code_verifier: verifier,
    });
    const accessToken = (token as { access_token?: unknown }).access_token;
    if (typeof accessToken !== "string" || accessToken === "") throw new ProviderError("El proveedor no devolvió un token de acceso.");
    const profile = await this.getJson(settings.endpoints.profile, accessToken);
    const emails = settings.endpoints.emails === undefined ? null : await this.getJson(settings.endpoints.emails, accessToken).catch(() => null);
    const parsed = definition.parseProfile(profile, emails);
    if (parsed === null) throw new ProviderError("El perfil del proveedor no trae un identificador.");
    return parsed;
  }

  private async postForm(url: string, fields: Record<string, string>): Promise<unknown> {
    const response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      redirect: "error",
    }).catch((error: unknown) => {
      throw new ProviderError(`No se pudo contactar al proveedor: ${(error as Error).message}`);
    });
    return this.readJson(response, url);
  }

  private async getJson(url: string, accessToken: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}`, "User-Agent": "captionforge" },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      redirect: "error",
    }).catch((error: unknown) => {
      throw new ProviderError(`No se pudo contactar al proveedor: ${(error as Error).message}`);
    });
    return this.readJson(response, url);
  }

  private async readJson(response: Response, url: string): Promise<unknown> {
    const body = await response.text();
    if (body.length > MAX_PROVIDER_RESPONSE_BYTES) throw new ProviderError(`Respuesta demasiado grande de ${new URL(url).host}.`);
    if (!response.ok) throw new ProviderError(`${new URL(url).host} respondió ${response.status}.`);
    try {
      return JSON.parse(body);
    } catch {
      throw new ProviderError(`${new URL(url).host} no devolvió JSON.`);
    }
  }

  /**
   * Primer inicio de sesión: crea la persona y su tenant (uno por persona, ADR 0015); los siguientes la reconocen por
   * (proveedor, identificador). Dos proveedores con el mismo correo NO se fusionan (cuentas separadas): unirlas por correo
   * es una decisión de seguridad aparte. Si el correo ya es de otra cuenta, la nueva queda sin correo.
   */
  async login(provider: ProviderId, profile: Profile): Promise<{ userId: string; tenantId: string }> {
    const existing = await this.prisma.user.findUnique({ where: { provider_subject: { provider, subject: profile.subject } }, select: { id: true, tenantId: true } });
    if (existing) return { userId: existing.id, tenantId: existing.tenantId };

    const tenantId = randomUUID();
    const userId = randomUUID();
    const label = profile.name ?? profile.email ?? `${provider}:${profile.subject}`;
    const create = (email: string | null) =>
      this.prisma.$transaction([
        this.prisma.tenant.create({ data: { id: tenantId, name: label.slice(0, 100) } }),
        this.prisma.user.create({ data: { id: userId, tenantId, email, name: profile.name, provider, subject: profile.subject } }),
        // Dueña de su espacio desde el primer momento (ADR 0019); sin membresía no habría rol y toda ruta se negaría.
        this.prisma.membership.create({ data: { userId, tenantId, role: "OWNER" } }),
      ]);
    try {
      await create(profile.email);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      // Carrera con otro inicio de sesión de la misma persona, o correo ya usado por otra cuenta.
      const raced = await this.prisma.user.findUnique({ where: { provider_subject: { provider, subject: profile.subject } }, select: { id: true, tenantId: true } });
      if (raced) return { userId: raced.id, tenantId: raced.tenantId };
      await create(null);
    }
    return { userId, tenantId };
  }

  /** Abre una sesión: devuelve el token que va en la cookie (la base solo guarda su hash). También limpia las caducadas. */
  async openSession(userId: string): Promise<{ token: string; maxAgeSeconds: number }> {
    const token = randomBytes(32).toString("base64url");
    const ttl = this.config.auth.sessionTtlMs;
    await this.prisma.session.create({ data: { id: randomUUID(), userId, tokenHash: hashApiKey(token), expiresAt: new Date(Date.now() + ttl) } });
    this.prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch((error: unknown) => {
      this.logger.warn(`No se pudieron limpiar sesiones caducadas: ${(error as Error).message}`);
    });
    return { token, maxAgeSeconds: Math.floor(ttl / 1000) };
  }

  async closeSession(token: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash: hashApiKey(token) } });
  }

  /**
   * La sesión vigente de un token de cookie, con el espacio activo y el rol de la persona en él, o null. Espacio activo: el que
   * la sesión recuerda si la persona sigue siendo miembro; si no, el primero al que se unió. Sin ninguna membresía no hay
   * identidad utilizable (null): fail-closed.
   */
  async findSession(token: string): Promise<{ sessionId: string; userId: string; tenantId: string; role: Role } | null> {
    const row = await this.prisma.session.findUnique({
      where: { tokenHash: hashApiKey(token) },
      select: { id: true, expiresAt: true, tenantId: true, user: { select: { id: true, memberships: { select: { tenantId: true, role: true }, orderBy: { createdAt: "asc" } } } } },
    });
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    const active = row.user.memberships.find((membership) => membership.tenantId === row.tenantId) ?? row.user.memberships[0];
    return active === undefined ? null : { sessionId: row.id, userId: row.user.id, tenantId: active.tenantId, role: active.role };
  }

  failure(error: unknown): BadGatewayException {
    this.logger.warn(`Inicio de sesión fallido: ${(error as Error).message}`);
    return new BadGatewayException("No se pudo completar el inicio de sesión.");
  }
}
