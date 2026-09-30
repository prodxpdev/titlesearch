// Validation of RDAP domain responses (RFC 9083). A 200 counts as
// "registered" only when the body really is the domain object asked for.

import * as z from "zod";

const Entity = z.object({
  roles: z.array(z.string()).optional(),
  vcardArray: z.tuple([z.literal("vcard"), z.array(z.array(z.unknown()))]).optional(),
});

export const RdapDomainSchema = z.object({
  objectClassName: z.literal("domain"),
  ldhName: z.string(),
  events: z.array(z.object({ eventAction: z.string(), eventDate: z.string() })).optional(),
  entities: z.array(Entity).optional(),
});

export type RdapDomainParse =
  | { ok: true; registrar?: string; created?: string }
  | { ok: false; reason: string };

export function parseRdapDomain(body: unknown, domain: string): RdapDomainParse {
  const parsed = RdapDomainSchema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: "The response isn't an RDAP domain object." };
  if (parsed.data.ldhName.toLowerCase().replace(/\.$/, "") !== domain) {
    return { ok: false, reason: "The response describes a different domain." };
  }
  const created = parsed.data.events?.find((e) => e.eventAction === "registration")?.eventDate;
  let registrar: string | undefined;
  for (const entity of parsed.data.entities ?? []) {
    if (!entity.roles?.includes("registrar") || !entity.vcardArray) continue;
    const fn = entity.vcardArray[1].find((p) => Array.isArray(p) && p[0] === "fn");
    const value = fn?.[3];
    if (typeof value === "string" && value.trim() !== "") registrar = value.trim();
  }
  return {
    ok: true,
    ...(registrar ? { registrar } : {}),
    ...(created ? { created } : {}),
  };
}
