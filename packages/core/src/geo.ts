// BR-25: photos far from the site or with a skewed device clock are flagged for review, never blocked.
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
export interface PhotoCheck {
  lat: number; lng: number; accuracyM?: number | null; takenAtDevice: Date; serverNow: Date;
  site?: { lat: number | null; lng: number | null; geofenceM: number } | null;
  clockSkewMinutes?: number;
}
export function photoFlags(c: PhotoCheck): string[] {
  const flags: string[] = [];
  const skew = c.clockSkewMinutes ?? 10;
  if (Math.abs(c.serverNow.getTime() - c.takenAtDevice.getTime()) > skew * 60_000) flags.push('clock_skew');
  if (c.site && c.site.lat != null && c.site.lng != null) {
    if (haversineM(c.lat, c.lng, c.site.lat, c.site.lng) > c.site.geofenceM) flags.push('outside_geofence');
    if (c.accuracyM != null && c.accuracyM > c.site.geofenceM) flags.push('low_gps_accuracy');
  }
  return flags;
}
