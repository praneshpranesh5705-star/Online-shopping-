// Shared client/server constants.

// Session cookie name is per-app (derived from APP_SLUG) so two apps served on
// the same host cannot clobber each other's session cookie (DESIGN #13). The
// server owns the authoritative value via env; this helper keeps client/server
// in agreement.
export function sessionCookieName(slug: string): string {
  return `app_session_${slug}`;
}

// ShopSphere adds a third role: `staff` may manage catalogue and orders but not
// customers, roles or destructive deletes. `admin` is the full back office.
export const USER_ROLES = ["user", "staff", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Roles allowed into the admin dashboard at all. */
export const STAFF_ROLES: UserRole[] = ["staff", "admin"];

export function isStaff(role: string | null | undefined): boolean {
  return role === "staff" || role === "admin";
}
