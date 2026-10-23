import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";

import type { Role } from "../generated/prisma/enums.js";

export type { Role };

/** Orden de menor a mayor poder: cada rol puede todo lo del anterior (ADR 0019). */
const RANK: Readonly<Record<Role, number>> = { VIEWER: 1, EDITOR: 2, OWNER: 3 };
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const MIN_ROLE = "captionforge:min-role";

/** Rutas que piden más que el mínimo por método (p. ej. gestionar claves de API pide Dueño). */
export const MinRole = (role: Role) => SetMetadata(MIN_ROLE, role);

/**
 * Rol mínimo de una ruta: el declarado con @MinRole, y si no, por método HTTP: leer pide Lector y todo lo que modifica pide Editor.
 * Es fail-closed: una ruta nueva que modifica datos exige Editor aunque nadie se acuerde de declararla.
 */
export function requiredRole(method: string, declared: Role | undefined): Role {
  return declared ?? (SAFE_METHODS.has(method.toUpperCase()) ? "VIEWER" : "EDITOR");
}

export const satisfies = (actual: Role, required: Role): boolean => RANK[actual] >= RANK[required];

declare module "fastify" {
  interface FastifyRequest {
    /** Rol con el que actúa la petición en su tenant: el de la persona (sesión) o Editor fijo (clave de API). Lo pone TenantAuthGuard. */
    role?: Role;
  }
}

/**
 * Autorización por rol (ADR 0019). Va DESPUÉS de TenantAuthGuard, que ya fijó `request.tenantId` y `request.role`. Una ruta
 * protegida sin rol resuelto es un fallo de configuración y se niega (403), nunca se deja pasar.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (request.tenantId === undefined) return true; // ruta pública: TenantAuthGuard ya rechazó (401) toda ruta protegida sin identidad
    const required = requiredRole(request.method, this.reflector.getAllAndOverride<Role | undefined>(MIN_ROLE, [context.getHandler(), context.getClass()]));
    const actual = request.role;
    if (actual === undefined || !satisfies(actual, required)) {
      // `code` estable: la interfaz decide el texto por código, nunca por el mensaje (que viene en español y puede cambiar).
      throw new ForbiddenException({ statusCode: 403, error: "Forbidden", code: "role_forbidden", message: "Tu rol en este espacio de trabajo no permite esta operación." });
    }
    return true;
  }
}
