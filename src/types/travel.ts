export type TravelReturnType = 'roundtrip' | 'different';
export type TravelMode = 'DRIVE' | 'BICYCLE' | 'FLIGHT';

export type TravelReturnLeg = {
  from: string;
  to: string;
  mode: TravelMode;
  durationMinutes: number | null;
  notes: string;
};

export type TravelLeg = {
  id: string;
  from: string;
  to: string;
  mode: TravelMode;
  durationMinutes: number | null;
  notes: string;
  returnType: TravelReturnType;
  returnLeg: TravelReturnLeg;
};

export type TripPackingItem = {
  id: string;
  label: string;
  packed: boolean;
};

export type TripChecklistItem = {
  id: string;
  label: string;
  done: boolean;
};

export type Trip = {
  id: string;
  name: string;
  locationId: string;
  location: string;
  startAt: string;
  endAt: string;
  stayName: string;
  stayAddress: string;
  notes: string;
  travelLegs: TravelLeg[];
  checklistItems: TripChecklistItem[];
  packingListIds: string[];
  customPackingItems: TripPackingItem[];
  packedItemKeys: string[];
  excludedPackingItemKeys: string[];
  packingSnapshotItems: TripPackingSummaryItem[] | null;
};

export type TravelLocation = {
  id: string;
  name: string;
  notes: string;
  travelLegs: TravelLeg[];
};

export type TravelSettings = {
  homeAddress: string;
};

export type PackingListItem = {
  id: string;
  label: string;
};

export type PackingList = {
  id: string;
  name: string;
  items: PackingListItem[];
};

export type TravelAppState = {
  trips: Trip[];
  locations: TravelLocation[];
  packingLists: PackingList[];
  settings: TravelSettings;
  selectedTripId: string;
  selectedLocationId: string;
};

export type TripPackingSummaryItem = {
  key: string;
  label: string;
  source: string;
  packed: boolean;
};
