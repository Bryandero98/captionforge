import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";

import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { MetricsService } from "../observability/metrics.service.js";
import { CSRF_HEADER, CSRF_VALUE } from "../tenancy/tenant-auth.guard.js";
import { AuthService } from "./auth.service.js";
import { OAUTH_COOKIE, SESSION_COOKIE, clearCookie, cookieName, readCookie, setCookie } from "./cookies.js";
import { isProviderId } from "./providers.js";

const OAUTH_ATTEMPT_SECONDS = 600;

/** Códigos que la interfaz traduce (`/?login_error=<código>`); nunca texto del proveedor. */
type LoginError = "denied" | "state" | "provider" | "unavailable";

/**
 * Inicio de sesión (ADR 0016): GET /auth/:proveedor/start redirige al proveedor; GET /auth/:proveedor/callback recibe la
 * vuelta, abre la sesión y devuelve a la persona a la interfaz. Rutas públicas por definición (TenantAuthGuard las deja pasar).
 */
@Controller("auth")
export class AuthController {
  private readonly secure: boolean;

  constructor(
    private readonly auth: AuthService,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.secure = config.auth.publicUrl.startsWith("https:");
  }

  /** Qué proveedores están configurados y si la instalación es local (sin inicio de sesión): lo que la interfaz necesita para decidir qué mostrar. */
  @Get("providers")
  providers(): { providers: string[]; localMode: boolean } {
    return { providers: this.auth.enabledProviders(), localMode: this.config.auth.localMode && this.config.security.webApiKey !== undefined };
  }

  @Get(":provider/start")
  start(@Param("provider") provider: string, @Res() reply: FastifyReply): void {
    const attempt = isProviderId(provider) ? this.auth.begin(provider) : null;
    if (attempt === null) return this.fail(reply, "unavailable");
    reply
      .header("Set-Cookie", setCookie(cookieName(OAUTH_COOKIE, this.secure), `${attempt.state}.${attempt.verifier}`, { maxAgeSeconds: OAUTH_ATTEMPT_SECONDS, secure: this.secure }))
      .header("Cache-Control", "no-store")
      .redirect(attempt.url, 302);
  }

  @Get(":provider/callback")
  async callback(
    @Param("provider") provider: string,
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") providerError: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!isProviderId(provider) || this.config.auth.providers[provider] === undefined) return this.fail(reply, "unavailable");
    // La cookie del intento se consume SIEMPRE, salga bien o mal: un callback no se puede repetir.
    const attempt = readCookie(request.headers.cookie, cookieName(OAUTH_COOKIE, this.secure));
    reply.header("Set-Cookie", clearCookie(cookieName(OAUTH_COOKIE, this.secure), this.secure));
    if (providerError !== undefined) {
      this.metrics.logins.inc({ provider, result: "denied" });
      return this.fail(reply, "denied");
    }

    const dot = attempt?.indexOf(".") ?? -1;
    const expectedState = attempt === undefined || dot < 1 ? undefined : attempt.slice(0, dot);
    const verifier = attempt === undefined || dot < 1 ? undefined : attempt.slice(dot + 1);
    if (typeof state !== "string" || typeof code !== "string" || code === "" || expectedState === undefined || verifier === undefined || !sameText(state, expectedState)) {
      this.metrics.logins.inc({ provider, result: "state" });
      return this.fail(reply, "state");
    }

    try {
      const profile = await this.auth.exchange(provider, code, verifier);
      const { userId } = await this.auth.login(provider, profile);
      const session = await this.auth.openSession(userId);
      this.metrics.logins.inc({ provider, result: "ok" });
      reply
        .header("Set-Cookie", [
          clearCookie(cookieName(OAUTH_COOKIE, this.secure), this.secure),
          setCookie(cookieName(SESSION_COOKIE, this.secure), session.token, { maxAgeSeconds: session.maxAgeSeconds, secure: this.secure }),
        ])
        .header("Cache-Control", "no-store")
        .redirect("/", 302);
    } catch (error) {
      this.metrics.logins.inc({ provider, result: "provider_error" });
      this.auth.failure(error);
      this.fail(reply, "provider");
    }
  }

  /** Cierra la sesión actual. Pide la cabecera de la interfaz: sin ella, una página ajena podría cerrar la sesión de alguien. */
  @Post("logout")
  @HttpCode(204)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    if (request.headers[CSRF_HEADER] !== CSRF_VALUE) {
      reply.status(403);
      return;
    }
    const token = readCookie(request.headers.cookie, cookieName(SESSION_COOKIE, this.secure));
    if (token !== undefined) await this.auth.closeSession(token);
    reply.header("Set-Cookie", clearCookie(cookieName(SESSION_COOKIE, this.secure), this.secure)).header("Cache-Control", "no-store");
  }

  private fail(reply: FastifyReply, code: LoginError): void {
    reply.header("Cache-Control", "no-store").redirect(`/?login_error=${code}`, 302);
  }
}

/** Comparación en tiempo constante de dos textos (el `state` es un secreto de un solo uso). */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
