// Un proveedor de inicio de sesión falso (hace de GitHub): autoriza, canjea códigos con PKCE de verdad y sirve el perfil.
// Así las pruebas ejercitan todo el flujo sin depender de GitHub ni de Google ni de sus credenciales.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

export interface FakeProfile {
  id: number;
  login: string;
  name?: string | null;
  emails?: { email: string; primary: boolean; verified: boolean }[];
}

interface Grant {
  challenge: string;
  profile: FakeProfile;
  used: boolean;
}

export class FakeProvider {
  readonly clientId = "test-client-id";
  readonly clientSecret = "test-client-secret";
  private readonly grants = new Map<string, Grant>();
  private readonly tokens = new Map<string, FakeProfile>();
  private server!: http.Server;
  url = "";
  /** Si no es null, `/authorize` aprueba solo con este perfil y vuelve al API (para pruebas con navegador). */
  autoApprove: FakeProfile | null = null;
  /** Si no es null, `/user/emails` responde con este estado de error (límite de GitHub, caída). */
  failEmails: number | null = null;
  /** Peticiones de canje que recibió, para comprobar lo que el API envía. */
  readonly tokenRequests: URLSearchParams[] = [];

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Configuración del API apuntando a este proveedor. */
  get config() {
    return {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      endpoints: { authorize: `${this.url}/authorize`, token: `${this.url}/token`, profile: `${this.url}/user`, emails: `${this.url}/user/emails` },
    };
  }

  /** La persona «aprueba»: devuelve el código que el proveedor mandaría de vuelta, atado al desafío PKCE de su petición. */
  approve(challenge: string, profile: FakeProfile): string {
    const code = `code-${randomBytes(8).toString("hex")}`;
    this.grants.set(code, { challenge, profile, used: false });
    return code;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const path = (request.url ?? "").split("?")[0];
    if (request.method === "GET" && path === "/authorize" && this.autoApprove !== null) {
      // Pantalla de consentimiento que aprueba sola: lo que un navegador real recorre al pulsar «Continuar con GitHub».
      const query = new URL(request.url ?? "", this.url).searchParams;
      const code = this.approve(query.get("code_challenge") ?? "", this.autoApprove);
      const back = new URL(query.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", query.get("state") ?? "");
      response.writeHead(302, { location: back.toString() });
      return void response.end();
    }
    if (request.method === "POST" && path === "/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      this.tokenRequests.push(form);
      const grant = this.grants.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const pkceOk = grant !== undefined && createHash("sha256").update(verifier).digest("base64url") === grant.challenge;
      if (form.get("client_id") !== this.clientId || form.get("client_secret") !== this.clientSecret || grant === undefined || grant.used || !pkceOk) {
        return send(400, { error: "bad_verification_code" });
      }
      grant.used = true;
      const token = `token-${randomBytes(8).toString("hex")}`;
      this.tokens.set(token, grant.profile);
      return send(200, { access_token: token, token_type: "bearer" });
    }
    const profile = this.tokens.get((request.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (profile === undefined) return send(401, { message: "Bad credentials" });
    if (path === "/user") return send(200, { id: profile.id, login: profile.login, name: profile.name ?? null });
    if (path === "/user/emails") return this.failEmails === null ? send(200, profile.emails ?? []) : send(this.failEmails, { message: "fallo provocado por la prueba" });
    send(404, {});
  }
}
