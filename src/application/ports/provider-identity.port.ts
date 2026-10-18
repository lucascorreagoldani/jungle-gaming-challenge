export interface ProviderIdentity {
  providerId: string;
  name: string;
  roles: string[];
}

export interface IProviderIdentityPort {
  authenticate(tokenOrKey?: string): Promise<ProviderIdentity | null>;
}
