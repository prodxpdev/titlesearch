/** Resolves a host name to every A and AAAA address it has. */
export interface Resolver {
  /**
   * Returns all addresses for `name`, IPv4 and IPv6. Returns an empty list
   * when the name doesn't exist. Throws when the lookup can't be completed,
   * including when only one address family could be looked up; a partial
   * answer would let an unchecked address through.
   */
  resolveHost(name: string, signal?: AbortSignal): Promise<string[]>;
}
