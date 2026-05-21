import type {
  PackingList,
  PackingListItem,
  TravelAppState,
  TravelLeg,
  TravelLocation,
  TravelMode,
  TravelReturnLeg,
  TravelReturnType,
  TravelSettings,
  Trip,
  TripChecklistItem,
  TripPackingItem,
  TripPackingSummaryItem
} from '../types/travel';

export const emptyTravelAppState: TravelAppState = {
  selectedTripId: '',
  selectedLocationId: '',
  settings: {
    homeAddress: ''
  },
  trips: [],
  locations: [],
  packingLists: []
};

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeArray<T>(
  value: unknown,
  normalizeItem: (item: unknown) => T | null
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const normalizedItem = normalizeItem(item);
    return normalizedItem ? [normalizedItem] : [];
  });
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function selectExistingId<T extends { id: string }>(
  items: T[],
  selectedId: string
): string {
  if (items.some((item) => item.id === selectedId)) {
    return selectedId;
  }

  return items[0]?.id ?? '';
}

function normalizeTravelReturnType(value: unknown): TravelReturnType {
  return value === 'different' ? 'different' : 'roundtrip';
}

export function normalizeTravelMode(value: unknown): TravelMode {
  const normalizedMode = normalizeString(value).toLocaleUpperCase();

  return ['DRIVE', 'BICYCLE', 'FLIGHT'].includes(normalizedMode)
    ? (normalizedMode as TravelMode)
    : 'DRIVE';
}

function normalizeTravelReturnLeg(value: unknown): TravelReturnLeg {
  if (!isRecordLike(value)) {
    return {
      from: '',
      to: '',
      mode: 'DRIVE',
      durationMinutes: null,
      notes: ''
    };
  }

  return {
    from: normalizeString(value.from),
    to: normalizeString(value.to),
    mode: normalizeTravelMode(value.mode),
    durationMinutes: normalizeNumber(value.durationMinutes),
    notes: normalizeString(value.notes)
  };
}

function normalizeTravelLeg(value: unknown): TravelLeg | null {
  if (!isRecordLike(value)) {
    return null;
  }

  const id = normalizeString(value.id);

  if (!id) {
    return null;
  }

  return {
    id,
    from: normalizeString(value.from),
    to: normalizeString(value.to),
    mode: normalizeTravelMode(value.mode),
    durationMinutes: normalizeNumber(value.durationMinutes),
    notes: normalizeString(value.notes),
    returnType: normalizeTravelReturnType(value.returnType),
    returnLeg: normalizeTravelReturnLeg(value.returnLeg)
  };
}

function normalizeTripPackingItem(value: unknown): TripPackingItem | null {
  if (!isRecordLike(value)) {
    return null;
  }

  const id = normalizeString(value.id);
  const label = normalizeString(value.label);

  if (!id || !label) {
    return null;
  }

  return {
    id,
    label,
    packed: value.packed === true
  };
}

function normalizeTripChecklistItem(value: unknown): TripChecklistItem | null {
  if (!isRecordLike(value)) {
    return null;
  }

  const id = normalizeString(value.id);
  const label = normalizeString(value.label);

  if (!id || !label) {
    return null;
  }

  return {
    id,
    label,
    done: value.done === true
  };
}

function normalizeTripPackingSummaryItem(
  value: unknown
): TripPackingSummaryItem | null {
  if (!isRecordLike(value)) {
    return null;
  }

  const key = normalizeString(value.key);

  if (!key) {
    return null;
  }

  return {
    key,
    label: normalizeString(value.label),
    source: normalizeString(value.source),
    packed: value.packed === true
  };
}

function normalizeTrip(value: unknown): Trip | null {
  if (!isRecordLike(value)) {
    return null;
  }

  const id = normalizeString(value.id);

  if (!id) {
    return null;
  }

  return {
    id,
    name: normalizeString(value.name),
    locationId: normalizeString(value.locationId),
    location: normalizeString(value.location),
    startAt: normalizeString(value.startAt),
    endAt: normalizeString(value.endAt),
    stayName: normalizeString(value.stayName),
    stayAddress: normalizeString(value.stayAddress),
    notes: normalizeString(value.notes),
    travelLegs: normalizeArray(value.travelLegs, normalizeTravelLeg),
    checklistItems: normalizeArray(
      value.checklistItems,
      normalizeTripChecklistItem
    ),
    packingListIds: normalizeStringArray(value.packingListIds),
    customPackingItems: normalizeArray(
      value.customPackingItems,
      normalizeTripPackingItem
    ),
    packedItemKeys: normalizeStringArray(value.packedItemKeys),
    excludedPackingItemKeys: normalizeStringArray(value.excludedPackingItemKeys),
    packingSnapshotItems: Array.isArray(value.packingSnapshotItems)
      ? normalizeArray(value.packingSnapshotItems, normalizeTripPackingSummaryItem)
      : null
  };
}

function normalizeTravelLocation(value: unknown): TravelLocation | null {
  if (!isRecordLike(value)) {
    return null;
  }

  const id = normalizeString(value.id);

  if (!id) {
    return null;
  }

  return {
    id,
    name: normalizeString(value.name),
    notes: normalizeString(value.notes),
    travelLegs: normalizeArray(value.travelLegs, normalizeTravelLeg)
  };
}

function normalizeTravelSettings(value: unknown): TravelSettings {
  if (!isRecordLike(value)) {
    return emptyTravelAppState.settings;
  }

  return {
    homeAddress: normalizeString(value.homeAddress)
  };
}

function normalizePackingListItem(value: unknown): PackingListItem | null {
  if (!isRecordLike(value)) {
    return null;
  }

  const id = normalizeString(value.id);
  const label = normalizeString(value.label);

  if (!id || !label) {
    return null;
  }

  return { id, label };
}

function normalizePackingList(value: unknown): PackingList | null {
  if (!isRecordLike(value)) {
    return null;
  }

  const id = normalizeString(value.id);

  if (!id) {
    return null;
  }

  return {
    id,
    name: normalizeString(value.name),
    items: normalizeArray(value.items, normalizePackingListItem)
  };
}

export function normalizeTravelAppState(value: unknown): TravelAppState {
  if (!isRecordLike(value)) {
    return emptyTravelAppState;
  }

  const trips = normalizeArray(value.trips, normalizeTrip);
  const locations = normalizeArray(value.locations, normalizeTravelLocation);
  const packingLists = normalizeArray(value.packingLists, normalizePackingList);
  const settings = normalizeTravelSettings(value.settings);
  const selectedTripId = normalizeString(value.selectedTripId);
  const selectedLocationId = normalizeString(value.selectedLocationId);

  return {
    trips,
    locations,
    packingLists,
    settings,
    selectedTripId: selectExistingId(trips, selectedTripId),
    selectedLocationId: selectExistingId(locations, selectedLocationId)
  };
}

export function isTravelAppStateEmpty(state: TravelAppState): boolean {
  return (
    state.trips.length === 0 &&
    state.locations.length === 0 &&
    state.packingLists.length === 0
  );
}
