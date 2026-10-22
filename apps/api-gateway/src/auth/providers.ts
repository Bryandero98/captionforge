// Proveedores de inicio de sesión (ADR 0016). GitHub usa OAuth2 (no es OIDC); Google usa OIDC, pero para saber quién es la
// persona basta pedir su perfil con el token de acceso recién obtenido por TLS directamente al proveedor: no se valida
// ningún id_token. Los dos reciben el flujo de código con PKCE y `state`.

export type ProviderId = "github" | "google";
export const PROVIDER_IDS: readonly ProviderId[] = ["github", "google"];
export const isProviderId = (value: string): value is ProviderId => (PROVIDER_IDS as readonly string[]).includes(value);

export interface ProviderEndpoints {
  authorize: string;
  token: string;
  profile: string;
  /** Solo GitHub: el correo verificado no viene en el perfil. */
  emails?: string;
}

/** Quién es la persona según el proveedor. `subject` es el identificador estable (nunca el correo ni el nombre de usuario). */
export interface Profile {
  subject: string;
  email: string | null;
  name: string | null;
}

export interface ProviderDefinition {
  id: ProviderId;
  scope: string;
  endpoints: ProviderEndpoints;
  /** Convierte lo que devolvió el proveedor en un Profile; null si no trae un identificador utilizable. */
  parseProfile(profile: unknown, emails: unknown): Profile | null;
}

const text = (value: unknown, max = 200): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null);

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  github: {
    id: "github",
    scope: "read:user user:email",
    endpoints: {
      authorize: "https://github.com/login/oauth/authorize",
      token: "https://github.com/login/oauth/access_token",
      profile: "https://api.github.com/user",
      emails: "https://api.github.com/user/emails",
    },
    parseProfile(profile, emails) {
      const user = (profile ?? {}) as { id?: unknown; login?: unknown; name?: unknown };
      if (typeof user.id !== "number" && typeof user.id !== "string") return null;
      const list = Array.isArray(emails) ? (emails as { email?: unknown; primary?: unknown; verified?: unknown }[]) : [];
      // Solo un correo VERIFICADO identifica a alguien: uno sin verificar lo puede declarar cualquiera.
      const primary = list.find((entry) => entry.primary === true && entry.verified === true) ?? list.find((entry) => entry.verified === true);
      return { subject: String(user.id), email: text(primary?.email)?.toLowerCase() ?? null, name: text(user.name) ?? text(user.login) };
    },
  },
  google: {
    id: "google",
    scope: "openid email profile",
    endpoints: {
      authorize: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
      profile: "https://openidconnect.googleapis.com/v1/userinfo",
    },
    parseProfile(profile) {
      const user = (profile ?? {}) as { sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown };
      const subject = text(user.sub);
      if (subject === null) return null;
      return { subject, email: user.email_verified === true ? (text(user.email)?.toLowerCase() ?? null) : null, name: text(user.name) };
    },
  },
};
