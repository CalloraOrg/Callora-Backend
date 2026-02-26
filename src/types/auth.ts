export interface AuthenticatedUser {
  id: string;
}

export interface AuthenticatedRequestContext {
  user: AuthenticatedUser;
}
