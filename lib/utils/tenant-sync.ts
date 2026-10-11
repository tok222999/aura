/**
 * Guards client activity responses while recovery or tenant switching is in
 * progress. A response is usable only when it belongs to the current tenant
 * and to the newest request for that tenant.
 */
export function shouldAcceptTenantActivityResponse(
  requestId: number,
  latestRequestId: number,
  responseTenant: string,
  requestedTenant: string,
  currentTenant: string,
): boolean {
  return requestId === latestRequestId &&
    Boolean(responseTenant) &&
    responseTenant === requestedTenant &&
    responseTenant === currentTenant
}
