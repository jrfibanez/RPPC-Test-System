import { actions } from '@/lib/actions';
import { P } from '@rppc/core';
import { masters } from '@rppc/db';
// POST /admin/masters/-/zone | truck | employee | import-clients | import-employees ; /admin/masters/:zoneId/zone-rate
export const POST = actions({
  zone: { perm: P.SETTINGS, run: (b, a, tx, c) => masters.createZone(tx, a, b, c) },
  'zone-rate': { perm: P.RATES_MANAGE, run: (b, a, tx, c, id) => masters.setZoneRate(tx, a, id, b.feePerTrip, b.estTripCost ?? null, b.effectiveFrom, c) },
  truck: { perm: P.SETTINGS, run: (b, a, tx, c) => masters.createTruck(tx, a, b.plateNo, b.capacity ?? 240, c) },
  employee: { perm: P.USERS_MANAGE, run: (b, a, tx, c) => masters.createEmployee(tx, a, b, c) },
  'import-clients': { perm: P.CLIENT_WRITE, run: (b, a, tx, c) => masters.importClientsCsv(tx, a, b.csv, c) },
  'import-employees': { perm: P.USERS_MANAGE, run: (b, a, tx, c) => masters.importEmployeesCsv(tx, a, b.csv, c) },
});
