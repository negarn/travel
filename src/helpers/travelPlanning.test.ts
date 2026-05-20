import { describe, expect, it } from 'vitest';
import {
  countPackedItems,
  deriveTripPackingItems,
  formatDuration,
  sortPackedItemsLast
} from './travelPlanning';
import type { PackingList, Trip } from '../types/travel';

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(25)).toBe('25 min');
    expect(formatDuration(60)).toBe('1 hr');
    expect(formatDuration(135)).toBe('2 hr 15 min');
  });

  it('handles missing or invalid durations', () => {
    expect(formatDuration(0)).toBe('Add duration');
    expect(formatDuration(null)).toBe('Add duration');
    expect(formatDuration(Number.NaN)).toBe('Add duration');
  });
});

describe('deriveTripPackingItems', () => {
  const trip: Trip = {
    id: 'trip-1',
    name: 'Long weekend',
    locationId: 'location-1',
    location: 'Montreal',
    startAt: '',
    endAt: '',
    stayName: '',
    stayAddress: '',
    notes: '',
    travelLegs: [],
    checklistItems: [],
    packingListIds: ['list-1'],
    customPackingItems: [{ id: 'custom-1', label: 'Museum pass', packed: true }],
    packedItemKeys: ['list:list-1:item-2'],
    excludedPackingItemKeys: [],
    packingSnapshotItems: null
  };

  const packingLists: PackingList[] = [
    {
      id: 'list-1',
      name: 'Cold weather',
      items: [
        { id: 'item-1', label: 'Gloves' },
        { id: 'item-2', label: 'Scarf' }
      ]
    },
    {
      id: 'list-2',
      name: 'Ignored',
      items: [{ id: 'item-3', label: 'Sandals' }]
    }
  ];

  it('combines selected reusable lists with custom trip items', () => {
    expect(deriveTripPackingItems(trip, packingLists)).toEqual([
      {
        key: 'list:list-1:item-1',
        label: 'Gloves',
        source: 'Cold weather',
        packed: false
      },
      {
        key: 'list:list-1:item-2',
        label: 'Scarf',
        source: 'Cold weather',
        packed: true
      },
      {
        key: 'custom:custom-1',
        label: 'Museum pass',
        source: 'Trip items',
        packed: true
      }
    ]);
  });

  it('counts packed items', () => {
    expect(countPackedItems(deriveTripPackingItems(trip, packingLists))).toBe(2);
  });

  it('omits reusable list items removed from the trip', () => {
    expect(
      deriveTripPackingItems(
        {
          ...trip,
          excludedPackingItemKeys: ['list:list-1:item-1']
        },
        packingLists
      )
    ).toEqual([
      {
        key: 'list:list-1:item-2',
        label: 'Scarf',
        source: 'Cold weather',
        packed: true
      },
      {
        key: 'custom:custom-1',
        label: 'Museum pass',
        source: 'Trip items',
        packed: true
      }
    ]);
  });

  it('moves checked items to the bottom while preserving group order', () => {
    expect(
      sortPackedItemsLast([
        { key: 'packed-1', label: 'Packed 1', source: 'Trip', packed: true },
        { key: 'open-1', label: 'Open 1', source: 'Trip', packed: false },
        { key: 'packed-2', label: 'Packed 2', source: 'Trip', packed: true },
        { key: 'open-2', label: 'Open 2', source: 'Trip', packed: false }
      ])
    ).toEqual([
      { key: 'open-1', label: 'Open 1', source: 'Trip', packed: false },
      { key: 'open-2', label: 'Open 2', source: 'Trip', packed: false },
      { key: 'packed-1', label: 'Packed 1', source: 'Trip', packed: true },
      { key: 'packed-2', label: 'Packed 2', source: 'Trip', packed: true }
    ]);
  });
});
