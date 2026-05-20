import { describe, expect, it } from 'vitest';
import { isHistoricalTrip } from './tripStatus';
import type { Trip } from '../types/travel';

function createTrip(endAt: string): Trip {
  return {
    id: 'trip-1',
    name: '',
    locationId: '',
    location: '',
    startAt: '',
    endAt,
    stayName: '',
    stayAddress: '',
    notes: '',
    travelLegs: [],
    checklistItems: [],
    packingListIds: [],
    customPackingItems: [],
    packedItemKeys: [],
    excludedPackingItemKeys: [],
    packingSnapshotItems: null
  };
}

describe('isHistoricalTrip', () => {
  const now = new Date('2026-05-20T12:00:00');

  it('treats trips with past end dates as historical', () => {
    expect(isHistoricalTrip(createTrip('2026-05-20T11:59'), now)).toBe(true);
  });

  it('keeps trips without a passed end date active', () => {
    expect(isHistoricalTrip(createTrip(''), now)).toBe(false);
    expect(isHistoricalTrip(createTrip('2026-05-20T12:00'), now)).toBe(false);
    expect(isHistoricalTrip(createTrip('2026-05-20T12:01'), now)).toBe(false);
  });
});
