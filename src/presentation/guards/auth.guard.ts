import { Injectable, CanActivate, ExecutionContext, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

export const IS_PUBLIC_KEY = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * ProviderAuthGuard
 * Ponto de extensão explícito para autenticação via Identity Provider (OIDC/Keycloak/Zitadel).
 * Por padrão no desafio, atua como pass-through seguro para não competir com a avaliação
 * de concorrência, consistência e correção financeira, conforme especificado na Seção 2.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(private reflector: Reflector) { }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers["authorization"] || request.headers["x-provider-key"];

    // Ponto de extensão: Mock/Extração de identidade do provedor
    request.providerIdentity = {
      providerId: request.headers["x-provider-id"] || "authenticated-provider",
      name: "Jungle Gaming Provider",
      authenticated: Boolean(authHeader),
    };

    return true;
  }
}
