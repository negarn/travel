import type { Trip } from '../types/travel';

export function isHistoricalTrip(trip: Trip, now = new Date()) {
  if (!trip.endAt) {
    return false;
  }

  const endDate = new Date(trip.endAt);

  if (Number.isNaN(endDate.getTime())) {
    return false;
  }

  return endDate.getTime() < now.getTime();
}
