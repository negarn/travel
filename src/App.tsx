import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, TextareaHTMLAttributes } from 'react';
import { CloudSyncPanel } from './components/CloudSyncPanel';
import {
  countPackedItems,
  deriveTripPackingItems,
  formatDuration,
  sortPackedItemsLast
} from './helpers/travelPlanning';
import { isHistoricalTrip } from './helpers/tripStatus';
import { emptyTravelAppState } from './helpers/travelData';
import { travelApiPaths } from './helpers/travelApiRoutes';
import type {
  PackingList,
  PackingListItem,
  TravelAppState,
  TravelLeg,
  TravelLocation,
  TravelMode,
  TravelReturnLeg,
  TravelReturnType,
  Trip
} from './types/travel';

type ActiveTab = 'trips' | 'history' | 'locations' | 'lists' | 'settings';
type LegacyTrip = Omit<
  Trip,
  | 'locationId'
  | 'travelLegs'
  | 'stayName'
  | 'stayAddress'
  | 'checklistItems'
  | 'excludedPackingItemKeys'
  | 'packingSnapshotItems'
> & {
  locationId?: string;
  travelLegs?: TravelLeg[];
  stayName?: string;
  stayAddress?: string;
  checklistItems?: Trip['checklistItems'];
  excludedPackingItemKeys?: string[];
  packingSnapshotItems?: Trip['packingSnapshotItems'];
};

const tabs: Array<{ id: ActiveTab; label: string }> = [
  { id: 'locations', label: 'Locations' },
  { id: 'trips', label: 'Trips' },
  { id: 'lists', label: 'Packing lists' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' }
];
const travelModeOptions: Array<{ value: TravelMode; label: string }> = [
  { value: 'DRIVE', label: 'Drive' },
  { value: 'BICYCLE', label: 'Bicycle' },
  { value: 'FLIGHT', label: 'Flight' }
];
const activeTabStorageKey = 'travel-plans-active-tab';
const noteHeightStoragePrefix = 'travel-plans-note-height:';
const defaultActiveTab: ActiveTab = 'trips';
const googleMapsEmbedApiKey =
  import.meta.env.VITE_TRAVEL_GOOGLE_MAPS_EMBED_API_KEY?.trim() ?? '';

function isActiveTab(value: string | null): value is ActiveTab {
  return tabs.some((tab) => tab.id === value);
}

function loadActiveTab(): ActiveTab {
  if (typeof window === 'undefined') {
    return defaultActiveTab;
  }

  const storedTab = window.localStorage.getItem(activeTabStorageKey);
  return isActiveTab(storedTab) ? storedTab : defaultActiveTab;
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeLocationName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function findLocationByName(
  locations: TravelLocation[],
  name: string
): TravelLocation | undefined {
  const normalizedName = normalizeLocationName(name);

  return locations.find(
    (location) => normalizeLocationName(location.name) === normalizedName
  );
}

function getTripStartTime(trip: Trip): number {
  if (!trip.startAt) {
    return Number.POSITIVE_INFINITY;
  }

  const startTime = new Date(trip.startAt).getTime();

  return Number.isNaN(startTime) ? Number.POSITIVE_INFINITY : startTime;
}

function sortTripsByStartDate(trips: Trip[]): Trip[] {
  return [...trips].sort(
    (firstTrip, secondTrip) =>
      getTripStartTime(firstTrip) - getTripStartTime(secondTrip)
  );
}

function sortLocationsByName(locations: TravelLocation[]): TravelLocation[] {
  return [...locations].sort((firstLocation, secondLocation) =>
    firstLocation.name.localeCompare(secondLocation.name, undefined, {
      sensitivity: 'base'
    })
  );
}

function formatTripPreviewDate(value: string): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(date);
}

function formatTripDateRange(trip: Trip): string {
  const startDate = formatTripPreviewDate(trip.startAt);
  const endDate = formatTripPreviewDate(trip.endAt);

  if (startDate && endDate) {
    return startDate === endDate ? startDate : `${startDate} - ${endDate}`;
  }

  return startDate || endDate || 'No dates yet';
}

function reorderPackingItems(
  items: PackingListItem[],
  itemId: string,
  targetItemId: string
): PackingListItem[] {
  if (itemId === targetItemId) {
    return items;
  }

  const fromIndex = items.findIndex((item) => item.id === itemId);
  const toIndex = items.findIndex((item) => item.id === targetItemId);

  if (fromIndex === -1 || toIndex === -1) {
    return items;
  }

  const reorderedItems = [...items];
  const [movedItem] = reorderedItems.splice(fromIndex, 1);
  reorderedItems.splice(toIndex, 0, movedItem);

  return reorderedItems;
}

function createDefaultTravelLeg(to = ''): TravelLeg {
  return {
    id: createId('leg'),
    from: '',
    to,
    mode: 'DRIVE',
    durationMinutes: null,
    notes: '',
    returnType: 'roundtrip',
    returnLeg: createDefaultTravelReturnLeg()
  };
}

function createDefaultTravelReturnLeg(): TravelReturnLeg {
  return {
    from: '',
    to: '',
    mode: 'DRIVE',
    durationMinutes: null,
    notes: ''
  };
}

function updateTravelLegReturnType(
  returnType: TravelReturnType,
  currentLeg: TravelLeg
): TravelLeg {
  return {
    ...currentLeg,
    returnType,
    returnLeg:
      returnType === 'different'
        ? currentLeg.returnLeg
        : createDefaultTravelReturnLeg()
  };
}

function getMatchedLocationTravelLegs(
  trip: Trip,
  matchingLocation: TravelLocation | undefined
): TravelLeg[] {
  if (!matchingLocation) {
    return trip.travelLegs;
  }

  if (matchingLocation.id === trip.locationId) {
    return trip.travelLegs;
  }

  return matchingLocation.travelLegs;
}

function isTripShownInTab(
  trip: Trip,
  activeTab: ActiveTab,
  currentTime: Date
): boolean {
  const isHistorical = isHistoricalTrip(trip, currentTime);

  return activeTab === 'history' ? isHistorical : !isHistorical;
}

function removeListReferencesFromTrip(
  trip: Trip,
  listId: string,
  currentTime: Date
): Trip {
  if (isHistoricalTrip(trip, currentTime)) {
    return trip;
  }

  const listItemKeyPrefix = `list:${listId}:`;

  return {
    ...trip,
    packingListIds: trip.packingListIds.filter((id) => id !== listId),
    packedItemKeys: trip.packedItemKeys.filter(
      (key) => !key.startsWith(listItemKeyPrefix)
    ),
    excludedPackingItemKeys: trip.excludedPackingItemKeys.filter(
      (key) => !key.startsWith(listItemKeyPrefix)
    )
  };
}

function removePackingItemReferencesFromTrip(
  trip: Trip,
  itemKey: string,
  currentTime: Date
): Trip {
  if (isHistoricalTrip(trip, currentTime)) {
    return trip;
  }

  return {
    ...trip,
    packedItemKeys: trip.packedItemKeys.filter((key) => key !== itemKey),
    excludedPackingItemKeys: trip.excludedPackingItemKeys.filter(
      (key) => key !== itemKey
    )
  };
}

type PersistentNoteTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  storageKey: string;
};

function PersistentNoteTextarea({
  storageKey,
  ...props
}: PersistentNoteTextareaProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;

    if (!textarea || typeof window === 'undefined') {
      return;
    }

    const storedHeight = Number(
      window.localStorage.getItem(`${noteHeightStoragePrefix}${storageKey}`)
    );

    if (Number.isFinite(storedHeight) && storedHeight > 0) {
      textarea.style.height = `${storedHeight}px`;
    }
  }, [storageKey]);

  useEffect(() => {
    const textarea = textareaRef.current;

    if (
      !textarea ||
      typeof window === 'undefined' ||
      typeof ResizeObserver === 'undefined'
    ) {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      window.localStorage.setItem(
        `${noteHeightStoragePrefix}${storageKey}`,
        String(textarea.offsetHeight)
      );
    });

    observer.observe(textarea);

    return () => observer.disconnect();
  }, [storageKey]);

  return <textarea ref={textareaRef} {...props} />;
}

type RemoveIconButtonProps = {
  label: string;
  onClick: () => void;
};

function RemoveIconButton({
  label,
  onClick
}: RemoveIconButtonProps): JSX.Element {
  return (
    <button
      aria-label={label}
      className="remove-icon-button"
      title={label}
      type="button"
      onClick={onClick}
    >
      <span aria-hidden="true">×</span>
    </button>
  );
}

type RouteReturnToggleProps = {
  value: TravelReturnType;
  onChange: (returnType: TravelReturnType) => void;
};

function RouteReturnToggle({
  value,
  onChange
}: RouteReturnToggleProps): JSX.Element {
  return (
    <div
      aria-label="Return route type"
      className="route-return-toggle"
      role="group"
    >
      <button
        aria-pressed={value === 'roundtrip'}
        className={`route-toggle-button ${
          value === 'roundtrip' ? 'route-toggle-button-active' : ''
        }`}
        type="button"
        onClick={() => onChange('roundtrip')}
      >
        Round trip
      </button>
      <button
        aria-pressed={value === 'different'}
        className={`route-toggle-button ${
          value === 'different' ? 'route-toggle-button-active' : ''
        }`}
        type="button"
        onClick={() => onChange('different')}
      >
        Different return
      </button>
    </div>
  );
}

function TravelModeSelect({
  value,
  onChange
}: {
  value: TravelMode;
  onChange: (value: TravelMode) => void;
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const selectedOption =
    travelModeOptions.find((option) => option.value === value) ??
    travelModeOptions[0];

  function closeOptions() {
    setIsOpen(false);
  }

  function selectMode(nextValue: TravelMode) {
    onChange(nextValue);
    closeOptions();
  }

  return (
    <div className="location-picker">
      <button
        aria-expanded={isOpen}
        className="select-field mode-picker-button"
        type="button"
        onBlur={closeOptions}
        onClick={() => setIsOpen((currentValue) => !currentValue)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            closeOptions();
          }
        }}
      >
        <span>{selectedOption.label}</span>
        <span aria-hidden="true" className="mode-picker-caret" />
      </button>
      {isOpen ? (
        <div className="location-picker-menu">
          {travelModeOptions.map((option) => (
            <button
              className={
                option.value === value
                  ? 'location-picker-option location-picker-option-selected'
                  : 'location-picker-option'
              }
              key={option.value}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                selectMode(option.value);
              }}
            >
              <span className="picker-option-content">
                <span>{option.label}</span>
              </span>
              {option.value === value ? (
                <span className="selected-pill">Selected</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type AddressAutocompleteSuggestion = {
  id: string;
  label: string;
};

type RouteMapResult = {
  distanceMeters: number | null;
  durationMinutes: number | null;
  mapsUrl: string;
  travelMode: string;
};
type RouteMapEmbedProps = {
  destination: string;
  origin: string;
  travelMode: string;
};

type AddressAutocompleteInputProps = {
  value: string;
  homeAddress: string;
  placesAutocompleteEnabled: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
};

function AddressAutocompleteInput({
  value,
  homeAddress,
  placesAutocompleteEnabled,
  onChange,
  placeholder
}: AddressAutocompleteInputProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [sessionToken, setSessionToken] = useState('');
  const [suggestions, setSuggestions] = useState<AddressAutocompleteSuggestion[]>(
    []
  );
  const [isPlacesConfigured, setIsPlacesConfigured] = useState(true);
  const [placesError, setPlacesError] = useState('');
  const trimmedHomeAddress = homeAddress.trim();
  const showHomeOption =
    Boolean(trimmedHomeAddress) && trimmedHomeAddress !== value.trim();

  useEffect(() => {
    if (!isOpen) {
      setSuggestions([]);
      setPlacesError('');
      return undefined;
    }

    const input = value.trim();

    if (!placesAutocompleteEnabled || input.length < 3) {
      setSuggestions([]);
      setPlacesError('');
      setIsPlacesConfigured(true);
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(travelApiPaths.placesAutocomplete, {
        body: JSON.stringify({ input, sessionToken }),
        headers: {
          'Content-Type': 'application/json'
        },
        method: 'POST',
        signal: controller.signal
      })
        .then(async (response) => {
          const payload = (await response.json()) as {
            error?: string;
            isConfigured?: boolean;
            suggestions?: AddressAutocompleteSuggestion[];
          };

          if (!response.ok) {
            throw new Error(payload.error || 'Could not load address suggestions.');
          }

          return payload;
        })
        .then((payload) => {
          setIsPlacesConfigured(payload.isConfigured !== false);
          setPlacesError(payload.error ?? '');
          setSuggestions(payload.suggestions ?? []);
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            console.error(error);
            setPlacesError(
              error instanceof Error
                ? error.message
                : 'Could not load address suggestions.'
            );
            setSuggestions([]);
          }
        });
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [isOpen, placesAutocompleteEnabled, sessionToken, value]);

  function openSuggestions() {
    setIsOpen(true);

    if (!sessionToken) {
      setSessionToken(crypto.randomUUID());
    }
  }

  function closeSuggestions() {
    setIsOpen(false);
    setSessionToken('');
  }

  function selectAddress(address: string) {
    onChange(address);
    closeSuggestions();
  }

  const hasSuggestions =
    isOpen &&
    (showHomeOption ||
      suggestions.length > 0 ||
      !isPlacesConfigured ||
      Boolean(placesError));

  return (
    <div className="location-picker">
      <input
        value={value}
        onBlur={closeSuggestions}
        onChange={(event) => {
          onChange(event.target.value);
          openSuggestions();
        }}
        onFocus={openSuggestions}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            closeSuggestions();
          }
        }}
        placeholder={placeholder}
      />
      {hasSuggestions ? (
        <div className="location-picker-menu">
          {showHomeOption ? (
            <button
              className="location-picker-option"
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                selectAddress(trimmedHomeAddress);
              }}
            >
              <span className="picker-option-content">
                <span>Home</span>
                <small>{trimmedHomeAddress}</small>
              </span>
            </button>
          ) : null}
          {suggestions.map((suggestion) => (
            <button
              className="location-picker-option"
              key={suggestion.id}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                selectAddress(suggestion.label);
              }}
            >
              <span className="picker-option-content">
                <span>{suggestion.label}</span>
              </span>
            </button>
          ))}
          {!isPlacesConfigured ? (
            <p className="picker-empty">
              Set TRAVEL_GOOGLE_MAPS_API_KEY to enable Google address search.
            </p>
          ) : null}
          {placesError ? <p className="picker-empty">{placesError}</p> : null}
          {suggestions.length > 0 ? (
            <p className="picker-attribution">Powered by Google</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function createGoogleMapsEmbedDirectionsUrl({
  destination,
  origin,
  travelMode
}: RouteMapEmbedProps): string {
  const embedUrl = new URL('https://www.google.com/maps/embed/v1/directions');

  embedUrl.searchParams.set('key', googleMapsEmbedApiKey);
  embedUrl.searchParams.set('origin', origin);
  embedUrl.searchParams.set('destination', destination);
  embedUrl.searchParams.set('units', 'metric');

  if (travelMode === 'BICYCLE') {
    embedUrl.searchParams.set('mode', 'bicycling');
  } else if (travelMode === 'DRIVE') {
    embedUrl.searchParams.set('mode', 'driving');
  }

  return embedUrl.toString();
}

function RouteMapEmbed({
  destination,
  origin,
  travelMode
}: RouteMapEmbedProps): JSX.Element {
  const embedUrl = createGoogleMapsEmbedDirectionsUrl({
    destination,
    origin,
    travelMode
  });

  return (
    <iframe
      allowFullScreen
      className="route-map-embed"
      loading="lazy"
      referrerPolicy="no-referrer-when-downgrade"
      src={embedUrl}
      title={`Route map from ${origin} to ${destination}`}
    />
  );
}

function RouteMapPreview({
  currentDurationMinutes,
  destination,
  mapsEnabled,
  mode,
  onDurationMinutesChange,
  origin
}: {
  currentDurationMinutes: number | null;
  destination: string;
  mapsEnabled: boolean;
  mode: string;
  onDurationMinutesChange: (durationMinutes: number) => void;
  origin: string;
}): JSX.Element | null {
  const [route, setRoute] = useState<RouteMapResult | null>(null);
  const [error, setError] = useState('');
  const [isConfigured, setIsConfigured] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const trimmedOrigin = origin.trim();
  const trimmedDestination = destination.trim();

  useEffect(() => {
    if (
      !mapsEnabled ||
      mode === 'FLIGHT' ||
      !trimmedOrigin ||
      !trimmedDestination
    ) {
      setRoute(null);
      setError('');
      setIsConfigured(true);
      setIsLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setIsLoading(true);

      void fetch(travelApiPaths.mapsRoute, {
        body: JSON.stringify({
          destination: trimmedDestination,
          mode,
          origin: trimmedOrigin
        }),
        headers: {
          'Content-Type': 'application/json'
        },
        method: 'POST',
        signal: controller.signal
      })
        .then(async (response) => {
          const payload = (await response.json()) as {
            error?: string;
            isConfigured?: boolean;
            route?: RouteMapResult | null;
          };

          if (!response.ok) {
            throw new Error(payload.error || 'Could not calculate this route.');
          }

          return payload;
        })
        .then((payload) => {
          const nextRoute = payload.route ?? null;

          setIsConfigured(payload.isConfigured !== false);
          setError(payload.error ?? '');
          setRoute(nextRoute);

          if (
            nextRoute?.durationMinutes &&
            nextRoute.durationMinutes !== currentDurationMinutes
          ) {
            onDurationMinutesChange(nextRoute.durationMinutes);
          }
        })
        .catch((fetchError) => {
          if (!controller.signal.aborted) {
            console.error(fetchError);
            setError(
              fetchError instanceof Error
                ? fetchError.message
                : 'Could not calculate this route.'
            );
            setRoute(null);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setIsLoading(false);
          }
        });
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [destination, mapsEnabled, mode, origin]);

  if (!mapsEnabled || (!route && !error && isConfigured && !isLoading)) {
    return null;
  }

  if (!isConfigured) {
    return (
      <p className="empty-state">
        Set TRAVEL_GOOGLE_MAPS_API_KEY to render route maps.
      </p>
    );
  }

  if (error) {
    return <p className="empty-state">{error}</p>;
  }

  if (!route) {
    return <p className="route-preview-status">Calculating route...</p>;
  }

  return (
    <div className="route-preview">
      {googleMapsEmbedApiKey ? (
        <RouteMapEmbed
          destination={trimmedDestination}
          origin={trimmedOrigin}
          travelMode={route.travelMode}
        />
      ) : (
        <div className="route-map-status" role="status">
          Set VITE_TRAVEL_GOOGLE_MAPS_EMBED_API_KEY to render route maps.
        </div>
      )}
      <div className="route-preview-footer">
        <a href={route.mapsUrl} rel="noreferrer" target="_blank">
          Open in Google Maps
        </a>
      </div>
    </div>
  );
}

function normalizeTrip(trip: LegacyTrip, locations: TravelLocation[]): Trip {
  const matchingLocation =
    locations.find((location) => location.id === trip.locationId) ??
    findLocationByName(locations, trip.location);

  return {
    ...trip,
    locationId: matchingLocation?.id ?? trip.locationId ?? '',
    location: trip.location || matchingLocation?.name || '',
    stayName: trip.stayName ?? '',
    stayAddress: trip.stayAddress ?? '',
    checklistItems: trip.checklistItems ?? [],
    excludedPackingItemKeys: trip.excludedPackingItemKeys ?? [],
    packingSnapshotItems: trip.packingSnapshotItems ?? null,
    travelLegs: trip.travelLegs ?? matchingLocation?.travelLegs ?? []
  };
}

function syncTripLocation(
  current: TravelAppState,
  tripId: string,
  options: { shouldCreateLocation: boolean }
): TravelAppState {
  const trip = current.trips.find((currentTrip) => currentTrip.id === tripId);

  if (!trip) {
    return current;
  }

  const locationName = trip.location.trim();

  if (!locationName) {
    return {
      ...current,
      trips: current.trips.map((currentTrip) =>
        currentTrip.id === trip.id
          ? { ...currentTrip, location: '', locationId: '' }
          : currentTrip
      )
    };
  }

  const matchingLocation =
    current.locations.find((location) => location.id === trip.locationId) ??
    findLocationByName(current.locations, locationName);

  if (matchingLocation) {
    const syncedTravelLegs =
      trip.travelLegs.length > 0 ? trip.travelLegs : matchingLocation.travelLegs;

    return {
      ...current,
      selectedLocationId: matchingLocation.id,
      locations: current.locations.map((location) =>
        location.id === matchingLocation.id
          ? {
              ...location,
              name: locationName,
              travelLegs: syncedTravelLegs
            }
          : location
      ),
      trips: current.trips.map((currentTrip) =>
        currentTrip.id === trip.id
          ? {
              ...currentTrip,
              location: locationName,
              locationId: matchingLocation.id,
              travelLegs: syncedTravelLegs
            }
          : currentTrip
      )
    };
  }

  if (!options.shouldCreateLocation) {
    return {
      ...current,
      trips: current.trips.map((currentTrip) =>
        currentTrip.id === trip.id
          ? { ...currentTrip, location: locationName, locationId: '' }
          : currentTrip
      )
    };
  }

  const locationId = createId('location');
  const newLocation: TravelLocation = {
    id: locationId,
    name: locationName,
    notes: '',
    travelLegs: trip.travelLegs
  };

  return {
    ...current,
    selectedLocationId: locationId,
    locations: [...current.locations, newLocation],
    trips: current.trips.map((currentTrip) =>
      currentTrip.id === trip.id
        ? { ...currentTrip, location: locationName, locationId }
        : currentTrip
    )
  };
}

function resolveInitialLocations(
  storedLocations: TravelLocation[] | undefined,
  migratedLocations: TravelLocation[],
  fallbackLocations: TravelLocation[]
): TravelLocation[] {
  if (storedLocations) {
    return storedLocations;
  }

  if (migratedLocations.length > 0) {
    return migratedLocations;
  }

  return fallbackLocations;
}

function normalizeStoredState(
  storedState: Partial<TravelAppState>,
  fallbackState: TravelAppState
): TravelAppState {
  const rawTrips = (storedState.trips ?? fallbackState.trips) as LegacyTrip[];
  const packingLists = storedState.packingLists ?? fallbackState.packingLists;
  const settings = storedState.settings ?? fallbackState.settings;
  const migratedLocations = rawTrips
    .filter((trip) => trip.location.trim())
    .map((trip) => ({
      id: createId('location'),
      name: trip.location,
      notes: '',
      travelLegs: trip.travelLegs ?? []
    }));
  const locations = resolveInitialLocations(
    storedState.locations,
    migratedLocations,
    fallbackState.locations
  );
  const trips = rawTrips.map((trip) => normalizeTrip(trip, locations));
  const storedSelectedTripId = storedState.selectedTripId ?? '';
  const storedSelectedLocationId = storedState.selectedLocationId ?? '';
  const selectedTripId = trips.some((trip) => trip.id === storedSelectedTripId)
    ? storedSelectedTripId
    : trips[0]?.id ?? '';
  const selectedLocationId = locations.some(
    (location) => location.id === storedSelectedLocationId
  )
    ? storedSelectedLocationId
    : locations[0]?.id ?? '';

  return {
    trips,
    packingLists,
    locations,
    settings,
    selectedTripId,
    selectedLocationId
  };
}

function App({
  initialState
}: {
  initialState?: TravelAppState;
}): JSX.Element {
  const isServerBacked = initialState === undefined;
  const [appState, setAppState] = useState<TravelAppState>(
    initialState ?? emptyTravelAppState
  );
  const [activeTab, setActiveTab] = useState<ActiveTab>(loadActiveTab);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isMobileItemSwitcherOpen, setIsMobileItemSwitcherOpen] =
    useState(false);
  const [highlightedMobileTab, setHighlightedMobileTab] =
    useState<ActiveTab | null>(null);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [selectedPackingListId, setSelectedPackingListId] = useState(
    appState.packingLists[0]?.id ?? ''
  );
  const [newListItem, setNewListItem] = useState('');
  const [newChecklistItem, setNewChecklistItem] = useState('');
  const [newTripItem, setNewTripItem] = useState('');
  const [packingListQuery, setPackingListQuery] = useState('');
  const [isPackingListPickerOpen, setIsPackingListPickerOpen] = useState(false);
  const [draggedPackingItemId, setDraggedPackingItemId] = useState<string | null>(
    null
  );
  const [dragTargetPackingItemId, setDragTargetPackingItemId] = useState<
    string | null
  >(null);
  const [isLocationPickerOpen, setIsLocationPickerOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(isServerBacked);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasLoadedServerData, setHasLoadedServerData] = useState(!isServerBacked);

  useEffect(() => {
    window.localStorage.setItem(activeTabStorageKey, activeTab);
  }, [activeTab]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentTime(new Date());
    }, 60_000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isMobileItemSwitcherOpen) {
      return;
    }

    function closeMobileItemSwitcher(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsMobileItemSwitcherOpen(false);
      }
    }

    window.addEventListener('keydown', closeMobileItemSwitcher);

    return () => {
      window.removeEventListener('keydown', closeMobileItemSwitcher);
    };
  }, [isMobileItemSwitcherOpen]);

  useEffect(() => {
    window.addEventListener('dragend', clearPackingItemDrag);
    window.addEventListener('drop', clearPackingItemDrag);

    return () => {
      window.removeEventListener('dragend', clearPackingItemDrag);
      window.removeEventListener('drop', clearPackingItemDrag);
    };
  }, []);

  useEffect(() => {
    if (!isServerBacked) {
      return undefined;
    }

    let isCurrent = true;

    async function loadTravelData() {
      try {
        const response = await fetch(travelApiPaths.data);

        if (!response.ok) {
          throw new Error('Could not load travel data.');
        }

        const parsedResponse = (await response.json()) as { travelData?: unknown };

        if (!isCurrent) {
          return;
        }

        setAppState(normalizeStoredState(parsedResponse.travelData ?? {}, emptyTravelAppState));
        setLoadError(null);
      } catch (error) {
        console.error(error);

        if (isCurrent) {
          setLoadError('Could not load travel data from disk.');
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false);
          setHasLoadedServerData(true);
        }
      }
    }

    void loadTravelData();

    function handleCloudRefresh() {
      void loadTravelData();
    }

    window.addEventListener('travel-cloud-sync-app-data-refresh', handleCloudRefresh);

    return () => {
      isCurrent = false;
      window.removeEventListener('travel-cloud-sync-app-data-refresh', handleCloudRefresh);
    };
  }, [isServerBacked]);

  useEffect(() => {
    if (!isServerBacked || !hasLoadedServerData) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(travelApiPaths.data, {
        body: JSON.stringify({ travelData: appState }),
        headers: {
          'Content-Type': 'application/json'
        },
        method: 'PUT',
        signal: controller.signal
      }).catch((error) => {
        if (!controller.signal.aborted) {
          console.error(error);
          setLoadError('Could not save travel data to disk.');
        }
      });
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [appState, hasLoadedServerData, isServerBacked]);

  useEffect(() => {
    setAppState((current) => {
      let changed = false;
      const trips = current.trips.map((trip) => {
        if (
          !isHistoricalTrip(trip, currentTime) ||
          trip.packingSnapshotItems !== null
        ) {
          return trip;
        }

        changed = true;

        return {
          ...trip,
          packingSnapshotItems: deriveTripPackingItems(
            trip,
            current.packingLists
          )
        };
      });

      return changed ? { ...current, trips } : current;
    });
  }, [appState.packingLists, appState.trips, currentTime]);

  const activeTrips = useMemo(
    () =>
      sortTripsByStartDate(
        appState.trips.filter((trip) => !isHistoricalTrip(trip, currentTime))
      ),
    [appState.trips, currentTime]
  );
  const historicalTrips = useMemo(
    () =>
      sortTripsByStartDate(
        appState.trips.filter((trip) => isHistoricalTrip(trip, currentTime))
      ),
    [appState.trips, currentTime]
  );
  const shownTrips = activeTab === 'history' ? historicalTrips : activeTrips;
  const selectedTrip =
    shownTrips.find((trip) => trip.id === appState.selectedTripId) ??
    shownTrips[0];
  const selectedTripIsHistorical = selectedTrip
    ? isHistoricalTrip(selectedTrip, currentTime)
    : false;
  const activeTabLabel =
    tabs.find((tab) => tab.id === activeTab)?.label ?? 'Trips';
  const mobileMenuTabs = tabs.filter((tab) => tab.id !== activeTab);

  const selectedLocation =
    appState.locations.find(
      (location) => location.id === appState.selectedLocationId
    ) ?? appState.locations[0];
  const sortedLocations = useMemo(
    () => sortLocationsByName(appState.locations),
    [appState.locations]
  );

  const selectedPackingList =
    appState.packingLists.find((list) => list.id === selectedPackingListId) ??
    appState.packingLists[0];
  const previewPackingListItems = useMemo(() => {
    if (!selectedPackingList) {
      return [];
    }

    if (!draggedPackingItemId || !dragTargetPackingItemId) {
      return selectedPackingList.items;
    }

    return reorderPackingItems(
      selectedPackingList.items,
      draggedPackingItemId,
      dragTargetPackingItemId
    );
  }, [dragTargetPackingItemId, draggedPackingItemId, selectedPackingList]);

  const tripPackingItems = useMemo(
    () => {
      if (!selectedTrip) {
        return [];
      }

      if (
        selectedTripIsHistorical &&
        selectedTrip.packingSnapshotItems !== null
      ) {
        return sortPackedItemsLast(selectedTrip.packingSnapshotItems);
      }

      return deriveTripPackingItems(selectedTrip, appState.packingLists);
    },
    [appState.packingLists, selectedTrip, selectedTripIsHistorical]
  );
  const packedCount = countPackedItems(tripPackingItems);
  const filteredPackingLists = useMemo(() => {
    if (!selectedTrip) {
      return [];
    }

    const query = packingListQuery.trim().toLocaleLowerCase();

    return appState.packingLists.filter((list) =>
      query ? list.name.toLocaleLowerCase().includes(query) : true
    );
  }, [appState.packingLists, packingListQuery, selectedTrip]);
  const filteredTripLocations = useMemo(() => {
    const query = selectedTrip?.location.trim().toLocaleLowerCase() ?? '';

    if (!query) {
      return appState.locations;
    }

    return appState.locations.filter((location) =>
      location.name.toLocaleLowerCase().includes(query)
    );
  }, [appState.locations, selectedTrip?.location]);

  function updateTrip(tripId: string, updater: (trip: Trip) => Trip) {
    setAppState((current) => ({
      ...current,
      trips: current.trips.map((trip) =>
        trip.id === tripId ? updater(trip) : trip
      )
    }));
  }

  function updateSelectedTrip(updater: (trip: Trip) => Trip) {
    if (!selectedTrip) {
      return;
    }

    updateTrip(selectedTrip.id, updater);
  }

  function updateLocation(
    locationId: string,
    updater: (location: TravelLocation) => TravelLocation
  ) {
    setAppState((current) => {
      const locations = current.locations.map((location) =>
        location.id === locationId ? updater(location) : location
      );
      const updatedLocation = locations.find(
        (location) => location.id === locationId
      );

      return {
        ...current,
        locations,
        trips: updatedLocation
          ? current.trips.map((trip) =>
              trip.locationId === updatedLocation.id
                ? {
                    ...trip,
                    location: updatedLocation.name,
                    travelLegs: updatedLocation.travelLegs
                  }
                : trip
            )
          : current.trips
      };
    });
  }

  function updateSelectedLocation(
    updater: (location: TravelLocation) => TravelLocation
  ) {
    if (!selectedLocation) {
      return;
    }

    updateLocation(selectedLocation.id, updater);
  }

  function updatePackingList(
    packingListId: string,
    updater: (packingList: PackingList) => PackingList
  ) {
    setAppState((current) => ({
      ...current,
      packingLists: current.packingLists.map((packingList) =>
        packingList.id === packingListId ? updater(packingList) : packingList
      )
    }));
  }

  function updateHomeAddress(homeAddress: string) {
    setAppState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        homeAddress
      }
    }));
  }

  function addTrip() {
    const id = createId('trip');

    setAppState((current) => ({
      ...current,
      selectedTripId: id,
      trips: [
        ...current.trips,
        {
          id,
          name: '',
          locationId: '',
          location: '',
          startAt: '',
          endAt: '',
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
        }
      ]
    }));
    setActiveTab('trips');
  }

  function deleteSelectedTrip() {
    if (!selectedTrip) {
      return;
    }

    setAppState((current) => {
      const trips = current.trips.filter((trip) => trip.id !== selectedTrip.id);
      const remainingShownTrips = trips.filter((trip) =>
        isTripShownInTab(trip, activeTab, currentTime)
      );

      return {
        ...current,
        trips,
        selectedTripId: remainingShownTrips[0]?.id ?? ''
      };
    });
  }

  function setTripLocationName(tripId: string, locationName: string) {
    setAppState((current) => {
      const matchingLocation = findLocationByName(current.locations, locationName);
      const nextState = {
        ...current,
        selectedLocationId: matchingLocation?.id ?? current.selectedLocationId,
        trips: current.trips.map((trip) => {
          if (trip.id !== tripId) {
            return trip;
          }

          return {
            ...trip,
            location: locationName,
            locationId: matchingLocation?.id ?? '',
            travelLegs: getMatchedLocationTravelLegs(trip, matchingLocation)
          };
        })
      };

      return matchingLocation
        ? syncTripLocation(nextState, tripId, { shouldCreateLocation: false })
        : nextState;
    });
  }

  function commitTripLocation(tripId: string) {
    setAppState((current) =>
      syncTripLocation(current, tripId, { shouldCreateLocation: true })
    );
  }

  function addTripTravelLeg() {
    if (!selectedTrip) {
      return;
    }

    setAppState((current) => {
      const nextState = {
        ...current,
        trips: current.trips.map((trip) =>
          trip.id === selectedTrip.id
            ? {
                ...trip,
                travelLegs: [
                  ...trip.travelLegs,
                  createDefaultTravelLeg()
                ]
              }
            : trip
        )
      };

      return syncTripLocation(nextState, selectedTrip.id, {
        shouldCreateLocation: true
      });
    });
  }

  function updateTripTravelLeg(
    legId: string,
    updater: (travelLeg: TravelLeg) => TravelLeg
  ) {
    if (!selectedTrip) {
      return;
    }

    setAppState((current) => {
      const nextState = {
        ...current,
        trips: current.trips.map((trip) =>
          trip.id === selectedTrip.id
            ? {
                ...trip,
                travelLegs: trip.travelLegs.map((leg) =>
                  leg.id === legId ? updater(leg) : leg
                )
              }
            : trip
        )
      };

      return syncTripLocation(nextState, selectedTrip.id, {
        shouldCreateLocation: true
      });
    });
  }

  function removeTripTravelLeg(legId: string) {
    if (!selectedTrip) {
      return;
    }

    setAppState((current) => {
      const nextState = {
        ...current,
        trips: current.trips.map((trip) =>
          trip.id === selectedTrip.id
            ? {
                ...trip,
                travelLegs: trip.travelLegs.filter((leg) => leg.id !== legId)
              }
            : trip
        )
      };

      return syncTripLocation(nextState, selectedTrip.id, {
        shouldCreateLocation: true
      });
    });
  }

  function addLocation() {
    const id = createId('location');

    setAppState((current) => ({
      ...current,
      selectedLocationId: id,
      locations: [
        ...current.locations,
        {
          id,
          name: '',
          notes: '',
          travelLegs: []
        }
      ]
    }));
    setActiveTab('locations');
  }

  function deleteSelectedLocation() {
    if (!selectedLocation) {
      return;
    }

    setAppState((current) => {
      const locations = current.locations.filter(
        (location) => location.id !== selectedLocation.id
      );

      return {
        ...current,
        locations,
        selectedLocationId: locations[0]?.id ?? '',
        trips: current.trips.map((trip) =>
          trip.locationId === selectedLocation.id
            ? { ...trip, locationId: '' }
            : trip
        )
      };
    });
  }

  function addTravelLeg() {
    updateSelectedLocation((location) => ({
      ...location,
      travelLegs: [
        ...location.travelLegs,
        createDefaultTravelLeg()
      ]
    }));
  }

  function updateTravelLeg(
    legId: string,
    updater: (travelLeg: TravelLeg) => TravelLeg
  ) {
    updateSelectedLocation((location) => ({
      ...location,
      travelLegs: location.travelLegs.map((leg) =>
        leg.id === legId ? updater(leg) : leg
      )
    }));
  }

  function removeTravelLeg(legId: string) {
    updateSelectedLocation((location) => ({
      ...location,
      travelLegs: location.travelLegs.filter((leg) => leg.id !== legId)
    }));
  }

  function addPackingList() {
    const id = createId('list');

    setAppState((current) => ({
      ...current,
      packingLists: [
        ...current.packingLists,
        {
          id,
          name: '',
          items: []
        }
      ]
    }));
    setSelectedPackingListId(id);
    setActiveTab('lists');
  }

  function deletePackingList(listId: string) {
    setAppState((current) => {
      const packingLists = current.packingLists.filter((list) => list.id !== listId);

      return {
        ...current,
        packingLists,
        trips: current.trips.map((trip) =>
          removeListReferencesFromTrip(trip, listId, currentTime)
        )
      };
    });
    setSelectedPackingListId(
      appState.packingLists.find((list) => list.id !== listId)?.id ?? ''
    );
  }

  function addItemToPackingList() {
    const label = newListItem.trim();

    if (!selectedPackingList || !label) {
      return;
    }

    const item: PackingListItem = {
      id: createId('item'),
      label
    };

    updatePackingList(selectedPackingList.id, (list) => ({
      ...list,
      items: [...list.items, item]
    }));
    setNewListItem('');
  }

  function updatePackingListItemLabel(
    listId: string,
    itemId: string,
    label: string
  ) {
    updatePackingList(listId, (list) => ({
      ...list,
      items: list.items.map((item) =>
        item.id === itemId ? { ...item, label } : item
      )
    }));
  }

  function removeItemFromPackingList(listId: string, itemId: string) {
    updatePackingList(listId, (list) => ({
      ...list,
      items: list.items.filter((item) => item.id !== itemId)
    }));
    setAppState((current) => ({
      ...current,
      trips: current.trips.map((trip) =>
        removePackingItemReferencesFromTrip(
          trip,
          `list:${listId}:${itemId}`,
          currentTime
        )
      )
    }));
  }

  function clearPackingItemDrag() {
    setDraggedPackingItemId(null);
    setDragTargetPackingItemId(null);
  }

  function movePackingListItem(
    listId: string,
    itemId: string,
    targetItemId: string
  ) {
    if (itemId === targetItemId) {
      return;
    }

    updatePackingList(listId, (list) => {
      return {
        ...list,
        items: reorderPackingItems(list.items, itemId, targetItemId)
      };
    });
  }

  function handlePackingItemDragStart(
    event: DragEvent<HTMLSpanElement>,
    itemId: string
  ) {
    const dragPreview = document.createElement('canvas');
    dragPreview.width = 1;
    dragPreview.height = 1;
    event.dataTransfer.setDragImage(dragPreview, 0, 0);

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', itemId);
    setDraggedPackingItemId(itemId);
    setDragTargetPackingItemId(itemId);
  }

  function handlePackingItemDragOver(
    event: DragEvent<HTMLDivElement>,
    targetItemId: string
  ) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    if (
      !selectedPackingList ||
      !draggedPackingItemId ||
      targetItemId === draggedPackingItemId
    ) {
      return;
    }

    setDragTargetPackingItemId(targetItemId);
  }

  function handlePackingItemDrop(
    event: DragEvent<HTMLDivElement>,
    targetItemId: string
  ) {
    event.preventDefault();
    event.stopPropagation();

    if (!selectedPackingList) {
      clearPackingItemDrag();
      return;
    }

    const itemId =
      event.dataTransfer.getData('text/plain') || draggedPackingItemId;
    const targetItemIdForDrop = dragTargetPackingItemId || targetItemId;

    if (!itemId) {
      clearPackingItemDrag();
      return;
    }

    clearPackingItemDrag();
    movePackingListItem(selectedPackingList.id, itemId, targetItemIdForDrop);
  }

  function addChecklistItem() {
    const label = newChecklistItem.trim();

    if (!label) {
      return;
    }

    updateSelectedTrip((trip) => ({
      ...trip,
      checklistItems: [
        ...trip.checklistItems,
        {
          id: createId('check'),
          label,
          done: false
        }
      ]
    }));
    setNewChecklistItem('');
  }

  function toggleChecklistItem(itemId: string) {
    updateSelectedTrip((trip) => ({
      ...trip,
      checklistItems: trip.checklistItems.map((item) =>
        item.id === itemId ? { ...item, done: !item.done } : item
      )
    }));
  }

  function removeChecklistItem(itemId: string) {
    updateSelectedTrip((trip) => ({
      ...trip,
      checklistItems: trip.checklistItems.filter((item) => item.id !== itemId)
    }));
  }

  function attachTripPackingList(listId: string) {
    updateSelectedTrip((trip) => {
      if (trip.packingListIds.includes(listId)) {
        return trip;
      }

      return {
        ...trip,
        packingListIds: [...trip.packingListIds, listId]
      };
    });
  }

  function removeTripPackingList(listId: string) {
    updateSelectedTrip((trip) => {
      return {
        ...trip,
        packingListIds: trip.packingListIds.filter((id) => id !== listId),
        packedItemKeys: trip.packedItemKeys.filter(
          (key) => !key.startsWith(`list:${listId}:`)
        ),
        excludedPackingItemKeys: trip.excludedPackingItemKeys.filter(
          (key) => !key.startsWith(`list:${listId}:`)
        )
      };
    });
  }

  function addCustomTripItem() {
    const label = newTripItem.trim();

    if (!label) {
      return;
    }

    updateSelectedTrip((trip) => ({
      ...trip,
      customPackingItems: [
        ...trip.customPackingItems,
        {
          id: createId('custom'),
          label,
          packed: false
        }
      ]
    }));
    setNewTripItem('');
  }

  function togglePackingItem(key: string) {
    if (key.startsWith('custom:')) {
      const itemId = key.replace('custom:', '');

      updateSelectedTrip((trip) => ({
        ...trip,
        customPackingItems: trip.customPackingItems.map((item) =>
          item.id === itemId ? { ...item, packed: !item.packed } : item
        )
      }));
      return;
    }

    updateSelectedTrip((trip) => ({
      ...trip,
      packedItemKeys: trip.packedItemKeys.includes(key)
        ? trip.packedItemKeys.filter((itemKey) => itemKey !== key)
        : [...trip.packedItemKeys, key]
    }));
  }

  function removeCustomTripItem(itemId: string) {
    updateSelectedTrip((trip) => ({
      ...trip,
      customPackingItems: trip.customPackingItems.filter(
        (item) => item.id !== itemId
      )
    }));
  }

  function updateCustomTripItemLabel(itemId: string, label: string) {
    updateSelectedTrip((trip) => ({
      ...trip,
      customPackingItems: trip.customPackingItems.map((item) =>
        item.id === itemId ? { ...item, label } : item
      )
    }));
  }

  function removeTripPackingItem(key: string) {
    if (key.startsWith('custom:')) {
      removeCustomTripItem(key.replace('custom:', ''));
      return;
    }

    updateSelectedTrip((trip) => ({
      ...trip,
      packedItemKeys: trip.packedItemKeys.filter((itemKey) => itemKey !== key),
      excludedPackingItemKeys: trip.excludedPackingItemKeys.includes(key)
        ? trip.excludedPackingItemKeys
        : [...trip.excludedPackingItemKeys, key]
    }));
  }

  function selectTab(tabId: ActiveTab) {
    setActiveTab(tabId);
    setIsMobileMenuOpen(false);
    setIsMobileItemSwitcherOpen(false);
    setHighlightedMobileTab(null);
  }

  return (
    <main className="min-h-dvh bg-app-bg text-app-ink">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <nav className="tab-bar" aria-label="Travel planning sections">
          {tabs.map((tab) => (
            <button
              className={
                activeTab === tab.id ? 'tab-button tab-button-active' : 'tab-button'
              }
              key={tab.id}
              type="button"
              onClick={() => selectTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <nav className="mobile-tab-nav" aria-label="Travel planning sections">
          <button
            aria-expanded={isMobileMenuOpen}
            className="mobile-tab-trigger"
            type="button"
            onClick={() => setIsMobileMenuOpen((isOpen) => !isOpen)}
          >
            <span className="hamburger-icon" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>{activeTabLabel}</span>
          </button>
          {isMobileMenuOpen ? (
            <div className="mobile-tab-menu">
              {mobileMenuTabs.map((tab) => (
                <button
                  className={
                    highlightedMobileTab === tab.id
                      ? 'mobile-tab-option mobile-tab-option-highlighted'
                      : 'mobile-tab-option'
                  }
                  key={tab.id}
                  type="button"
                  onBlur={() => setHighlightedMobileTab(null)}
                  onFocus={() => setHighlightedMobileTab(tab.id)}
                  onClick={() => selectTab(tab.id)}
                  onMouseEnter={() => setHighlightedMobileTab(tab.id)}
                  onMouseLeave={() =>
                    setHighlightedMobileTab((currentTab) =>
                      currentTab === tab.id ? null : currentTab
                    )
                  }
                  onMouseMove={() => setHighlightedMobileTab(tab.id)}
                  onMouseOver={() => setHighlightedMobileTab(tab.id)}
                  onPointerCancel={() => setHighlightedMobileTab(null)}
                  onPointerDown={() => setHighlightedMobileTab(tab.id)}
                  onPointerEnter={() => setHighlightedMobileTab(tab.id)}
                  onPointerLeave={() =>
                    setHighlightedMobileTab((currentTab) =>
                      currentTab === tab.id ? null : currentTab
                    )
                  }
                  onPointerMove={() => setHighlightedMobileTab(tab.id)}
                  onPointerUp={() => setHighlightedMobileTab(null)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ) : null}
        </nav>

        {isLoading ? (
          <p className="empty-state">Loading travel data from disk...</p>
        ) : null}

        {loadError ? <p className="empty-state">{loadError}</p> : null}

        {activeTab === 'trips' || activeTab === 'history' ? (
          <section className="grid gap-5 lg:grid-cols-[280px_1fr]">
            <aside className="panel">
              <div className="section-heading">
                <h2>{activeTab === 'history' ? 'History' : 'Trips'}</h2>
                {activeTab === 'trips' ? (
                  <button className="icon-button" type="button" onClick={addTrip}>
                    +
                  </button>
                ) : null}
              </div>
              {selectedTrip ? (
                <button
                  aria-expanded={isMobileItemSwitcherOpen}
                  aria-haspopup="dialog"
                  className="mobile-current-selection"
                  type="button"
                  onClick={() => setIsMobileItemSwitcherOpen(true)}
                >
                  <span className="mobile-current-selection-content">
                    <span className="font-semibold">{selectedTrip.name}</span>
                    <span className="text-sm text-app-muted">
                      {selectedTrip.location || 'No location yet'}
                    </span>
                    <span className="text-sm text-app-muted">
                      {formatTripDateRange(selectedTrip)}
                    </span>
                  </span>
                  <span className="mobile-selection-chevron" aria-hidden="true" />
                </button>
              ) : null}
              <div className="mobile-collapsible-list">
                {shownTrips.map((trip) => (
                  <button
                    className={
                      trip.id === selectedTrip?.id
                        ? 'list-row list-row-active'
                        : 'list-row'
                    }
                    key={trip.id}
                    type="button"
                    onClick={() => {
                      setAppState((current) => ({
                        ...current,
                        selectedTripId: trip.id
                      }));
                      setIsMobileItemSwitcherOpen(false);
                    }}
                  >
                    <span className="font-semibold">{trip.name}</span>
                    <span className="text-sm text-app-muted">
                      {trip.location || 'No location yet'}
                    </span>
                    <span className="text-sm text-app-muted">
                      {formatTripDateRange(trip)}
                    </span>
                  </button>
                ))}
              </div>
              {isMobileItemSwitcherOpen ? (
                <div
                  aria-label={`Choose ${activeTab === 'history' ? 'history item' : 'trip'}`}
                  aria-modal="true"
                  className="mobile-picker"
                  role="dialog"
                >
                  <button
                    aria-label="Close picker"
                    className="mobile-picker-backdrop"
                    type="button"
                    onClick={() => setIsMobileItemSwitcherOpen(false)}
                  />
                  <div className="mobile-picker-sheet">
                    <div className="mobile-picker-header">
                      <h3>{activeTab === 'history' ? 'Choose history item' : 'Choose trip'}</h3>
                      <button
                        aria-label="Close picker"
                        className="mobile-picker-close"
                        type="button"
                        onClick={() => setIsMobileItemSwitcherOpen(false)}
                      >
                        ×
                      </button>
                    </div>
                    <div className="mobile-picker-options">
                      {shownTrips.map((trip) => (
                        <button
                          className={
                            trip.id === selectedTrip?.id
                              ? 'list-row list-row-active'
                              : 'list-row'
                          }
                          key={trip.id}
                          type="button"
                          onClick={() => {
                            setAppState((current) => ({
                              ...current,
                              selectedTripId: trip.id
                            }));
                            setIsMobileItemSwitcherOpen(false);
                          }}
                        >
                          <span className="font-semibold">{trip.name}</span>
                          <span className="text-sm text-app-muted">
                            {trip.location || 'No location yet'}
                          </span>
                          <span className="text-sm text-app-muted">
                            {formatTripDateRange(trip)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </aside>

            <section className="panel">
              {selectedTrip ? (
                <div className="grid gap-6">
                  {selectedTripIsHistorical ? (
                    <p className="empty-state">
                      Historical trips are read-only.
                    </p>
                  ) : null}
                  <fieldset
                    className="trip-detail-fieldset"
                    disabled={selectedTripIsHistorical}
                  >
                  <div className="section-heading">
                    <h2>Trip details</h2>
                    <button
                      className="quiet-button"
                      type="button"
                      onClick={deleteSelectedTrip}
                    >
                      Delete
                    </button>
                  </div>

                  <div className="form-grid">
                    <label className="field">
                      <span>Trip name</span>
                      <input
                        value={selectedTrip.name}
                        onChange={(event) =>
                          updateSelectedTrip((trip) => ({
                            ...trip,
                            name: event.target.value
                          }))
                        }
                      />
                    </label>
                    <div className="field">
                      <span>Location</span>
                      <div className="location-picker">
                        <input
                          value={selectedTrip.location}
                          onBlur={() => {
                            commitTripLocation(selectedTrip.id);
                          }}
                          onChange={(event) => {
                            setTripLocationName(selectedTrip.id, event.target.value);
                            setIsLocationPickerOpen(true);
                          }}
                          onFocus={() => setIsLocationPickerOpen(true)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              setIsLocationPickerOpen(false);
                            }

                            if (event.key === 'Enter') {
                              event.currentTarget.blur();
                              setIsLocationPickerOpen(false);
                            }
                          }}
                          placeholder="Type or choose a location"
                        />
                        {isLocationPickerOpen && filteredTripLocations.length > 0 ? (
                          <div className="location-picker-menu">
                            {filteredTripLocations.map((location) => (
                              <button
                                className="location-picker-option"
                                key={location.id}
                                type="button"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  setTripLocationName(selectedTrip.id, location.name);
                                  setIsLocationPickerOpen(false);
                                }}
                              >
                                <span>{location.name}</span>
                                <small>{location.travelLegs.length} route options</small>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <label className="field">
                      <span>Start date/time</span>
                      <input
                        type="datetime-local"
                        value={selectedTrip.startAt}
                        onChange={(event) =>
                          updateSelectedTrip((trip) => ({
                            ...trip,
                            startAt: event.target.value
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span>End date/time</span>
                      <input
                        type="datetime-local"
                        value={selectedTrip.endAt}
                        onChange={(event) =>
                          updateSelectedTrip((trip) => ({
                            ...trip,
                            endAt: event.target.value
                          }))
                        }
                      />
                    </label>
                  </div>

                  <label className="field">
                    <span>Stay address</span>
                    <AddressAutocompleteInput
                      value={selectedTrip.stayAddress}
                      homeAddress={appState.settings.homeAddress}
                      placesAutocompleteEnabled={isServerBacked}
                      onChange={(value) =>
                        updateSelectedTrip((trip) => ({
                          ...trip,
                          stayAddress: value
                        }))
                      }
                      placeholder="Address or place"
                    />
                  </label>

                  <label className="field">
                    <span>Trip notes</span>
                    <PersistentNoteTextarea
                      rows={3}
                      storageKey={`trip:${selectedTrip.id}:notes`}
                      value={selectedTrip.notes}
                      onChange={(event) =>
                        updateSelectedTrip((trip) => ({
                          ...trip,
                          notes: event.target.value
                        }))
                      }
                    />
                  </label>

                  <div className="grid gap-4 border-t border-app-line pt-5">
                    <div className="section-heading">
                      <h2>Travel routes</h2>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={addTripTravelLeg}
                      >
                        + Add route
                      </button>
                    </div>

                    <div className="grid gap-3">
                      {selectedTrip.travelLegs.length === 0 ? (
                        <p className="empty-state">
                          Add route options here. They will be saved with this
                          trip and synced to its location.
                        </p>
                      ) : null}

                      {selectedTrip.travelLegs.map((leg) => (
                        <article className="travel-leg" key={leg.id}>
                          <RouteReturnToggle
                            value={leg.returnType}
                            onChange={(returnType) =>
                              updateTripTravelLeg(leg.id, (currentLeg) =>
                                updateTravelLegReturnType(returnType, currentLeg)
                              )
                            }
                          />
                          <div className="travel-leg-header">
                            <h3 className="subheading mb-0">
                              {leg.returnType === 'different'
                                ? 'Way there'
                                : 'Route'}
                            </h3>
                            <span>{formatDuration(leg.durationMinutes)}</span>
                          </div>
                          <div className="form-grid compact">
                            <label className="field">
                              <span>From</span>
                              <AddressAutocompleteInput
                                value={leg.from}
                                homeAddress={appState.settings.homeAddress}
                                placesAutocompleteEnabled={isServerBacked}
                                onChange={(value) =>
                                  updateTripTravelLeg(leg.id, (currentLeg) => ({
                                    ...currentLeg,
                                    from: value
                                  }))
                                }
                                placeholder="Start address or place"
                              />
                            </label>
                            <label className="field">
                              <span>To</span>
                              <AddressAutocompleteInput
                                value={leg.to}
                                homeAddress={appState.settings.homeAddress}
                                placesAutocompleteEnabled={isServerBacked}
                                onChange={(value) =>
                                  updateTripTravelLeg(leg.id, (currentLeg) => ({
                                    ...currentLeg,
                                    to: value
                                  }))
                                }
                                placeholder="Destination address or place"
                              />
                            </label>
                            <label className="field">
                              <span>Mode</span>
                              <TravelModeSelect
                                value={leg.mode}
                                onChange={(value) =>
                                  updateTripTravelLeg(leg.id, (currentLeg) => ({
                                    ...currentLeg,
                                    mode: value
                                  }))
                                }
                              />
                            </label>
                            <label className="field">
                              <span>Duration (minutes)</span>
                              <input
                                min="0"
                                type="number"
                                value={leg.durationMinutes ?? ''}
                                onChange={(event) =>
                                  updateTripTravelLeg(leg.id, (currentLeg) => ({
                                    ...currentLeg,
                                    durationMinutes: event.target.value
                                      ? Number(event.target.value)
                                      : null
                                  }))
                                }
                              />
                            </label>
                          </div>
                          <RouteMapPreview
                            currentDurationMinutes={leg.durationMinutes}
                            destination={leg.to}
                            mapsEnabled={isServerBacked}
                            mode={leg.mode}
                            origin={leg.from}
                            onDurationMinutesChange={(durationMinutes) =>
                              updateTripTravelLeg(leg.id, (currentLeg) => ({
                                ...currentLeg,
                                durationMinutes
                              }))
                            }
                          />
                          <label className="field">
                            <span>Notes</span>
                            <PersistentNoteTextarea
                              rows={2}
                              storageKey={`trip:${selectedTrip.id}:leg:${leg.id}:notes`}
                              value={leg.notes}
                              onChange={(event) =>
                                updateTripTravelLeg(leg.id, (currentLeg) => ({
                                  ...currentLeg,
                                  notes: event.target.value
                                }))
                              }
                            />
                          </label>
                          {leg.returnType === 'different' ? (
                            <div className="grid gap-3 border-t border-app-line pt-3">
                              <div className="travel-leg-header">
                                <h3 className="subheading mb-0">Way back</h3>
                                <span>
                                  {formatDuration(leg.returnLeg.durationMinutes)}
                                </span>
                              </div>
                              <div className="form-grid compact">
                                <label className="field">
                                  <span>From</span>
                                  <AddressAutocompleteInput
                                    value={leg.returnLeg.from}
                                    homeAddress={appState.settings.homeAddress}
                                    placesAutocompleteEnabled={isServerBacked}
                                    onChange={(value) =>
                                      updateTripTravelLeg(leg.id, (currentLeg) => ({
                                        ...currentLeg,
                                        returnLeg: {
                                          ...currentLeg.returnLeg,
                                          from: value
                                        }
                                      }))
                                    }
                                    placeholder="Return start address or place"
                                  />
                                </label>
                                <label className="field">
                                  <span>To</span>
                                  <AddressAutocompleteInput
                                    value={leg.returnLeg.to}
                                    homeAddress={appState.settings.homeAddress}
                                    placesAutocompleteEnabled={isServerBacked}
                                    onChange={(value) =>
                                      updateTripTravelLeg(leg.id, (currentLeg) => ({
                                        ...currentLeg,
                                        returnLeg: {
                                          ...currentLeg.returnLeg,
                                          to: value
                                        }
                                      }))
                                    }
                                    placeholder="Return destination address or place"
                                  />
                                </label>
                                <label className="field">
                                  <span>Mode</span>
                                  <TravelModeSelect
                                    value={leg.returnLeg.mode}
                                    onChange={(value) =>
                                      updateTripTravelLeg(leg.id, (currentLeg) => ({
                                        ...currentLeg,
                                        returnLeg: {
                                          ...currentLeg.returnLeg,
                                          mode: value
                                        }
                                      }))
                                    }
                                  />
                                </label>
                                <label className="field">
                                  <span>Duration (minutes)</span>
                                  <input
                                    min="0"
                                    type="number"
                                    value={leg.returnLeg.durationMinutes ?? ''}
                                    onChange={(event) =>
                                      updateTripTravelLeg(leg.id, (currentLeg) => ({
                                        ...currentLeg,
                                        returnLeg: {
                                          ...currentLeg.returnLeg,
                                          durationMinutes: event.target.value
                                            ? Number(event.target.value)
                                            : null
                                        }
                                      }))
                                    }
                                  />
                                </label>
                              </div>
                              <RouteMapPreview
                                currentDurationMinutes={
                                  leg.returnLeg.durationMinutes
                                }
                                destination={leg.returnLeg.to}
                                mapsEnabled={isServerBacked}
                                mode={leg.returnLeg.mode}
                                origin={leg.returnLeg.from}
                                onDurationMinutesChange={(durationMinutes) =>
                                  updateTripTravelLeg(leg.id, (currentLeg) => ({
                                    ...currentLeg,
                                    returnLeg: {
                                      ...currentLeg.returnLeg,
                                      durationMinutes
                                    }
                                  }))
                                }
                              />
                              <label className="field">
                                <span>Return notes</span>
                                <PersistentNoteTextarea
                                  rows={2}
                                  storageKey={`trip:${selectedTrip.id}:leg:${leg.id}:return-notes`}
                                  value={leg.returnLeg.notes}
                                  onChange={(event) =>
                                    updateTripTravelLeg(leg.id, (currentLeg) => ({
                                      ...currentLeg,
                                      returnLeg: {
                                        ...currentLeg.returnLeg,
                                        notes: event.target.value
                                      }
                                    }))
                                  }
                                />
                              </label>
                            </div>
                          ) : null}
                          <button
                            className="quiet-button self-start"
                            type="button"
                            onClick={() => removeTripTravelLeg(leg.id)}
                          >
                            Remove route
                          </button>
                        </article>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-4 border-t border-app-line pt-5">
                    <div className="section-heading">
                      <h2>Trip checklist</h2>
                    </div>

                    <form
                      className="inline-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        addChecklistItem();
                      }}
                    >
                      <label className="field grow">
                        <span>New checklist item</span>
                        <input
                          value={newChecklistItem}
                          onChange={(event) =>
                            setNewChecklistItem(event.target.value)
                          }
                          placeholder="Book reservation, confirm tickets..."
                        />
                      </label>
                      <button className="secondary-button" type="submit">
                        Add item
                      </button>
                    </form>

                    <div className="item-list">
                      {selectedTrip.checklistItems.length === 0 ? (
                        <p className="empty-state">
                          Add trip tasks and mark them done as you go.
                        </p>
                      ) : null}
                      {selectedTrip.checklistItems.map((item) => (
                        <div className="packing-item-row" key={item.id}>
                          <label className="check-row">
                            <input
                              type="checkbox"
                              checked={item.done}
                              onChange={() => toggleChecklistItem(item.id)}
                            />
                            <span>{item.label}</span>
                          </label>
                          <RemoveIconButton
                            label={`Remove ${item.label}`}
                            onClick={() => removeChecklistItem(item.id)}
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-4 border-t border-app-line pt-5">
                    <div className="section-heading">
                      <div>
                        <h2>Pack this trip</h2>
                        <p className="text-sm text-app-muted">
                          {packedCount} of {tripPackingItems.length} items packed
                        </p>
                      </div>
                    </div>

                    <div>
                      <h3 className="subheading">Attach packing lists</h3>
                      <div className="grid gap-3">
                        <div className="field">
                          <span>Search lists</span>
                          <div className="location-picker">
                            <input
                              value={packingListQuery}
                              onBlur={() => setIsPackingListPickerOpen(false)}
                              onChange={(event) => {
                                setPackingListQuery(event.target.value);
                                setIsPackingListPickerOpen(true);
                              }}
                              onFocus={() => setIsPackingListPickerOpen(true)}
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                  setIsPackingListPickerOpen(false);
                                }
                              }}
                              placeholder="Type or choose a packing list"
                            />
                            {isPackingListPickerOpen ? (
                              <div className="location-picker-menu">
                                {filteredPackingLists.length === 0 ? (
                                  <p className="picker-empty">
                                    No lists found.
                                  </p>
                                ) : null}
                                {filteredPackingLists.map((list) => {
                                  const isSelected =
                                    selectedTrip.packingListIds.includes(list.id);

                                  return (
                                    <button
                                      className={
                                        isSelected
                                          ? 'location-picker-option location-picker-option-selected'
                                          : 'location-picker-option'
                                      }
                                      key={list.id}
                                      type="button"
                                      onMouseDown={(event) => {
                                        event.preventDefault();

                                        if (isSelected) {
                                          removeTripPackingList(list.id);
                                        } else {
                                          attachTripPackingList(list.id);
                                        }
                                      }}
                                    >
                                      <span className="picker-option-content">
                                        <span>{list.name}</span>
                                        <small>{list.items.length} items</small>
                                      </span>
                                      {isSelected ? (
                                        <span className="selected-pill">
                                          Selected
                                        </span>
                                      ) : null}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>

                    <form
                      className="inline-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        addCustomTripItem();
                      }}
                    >
                      <label className="field grow">
                        <span>Custom trip item</span>
                        <input
                          value={newTripItem}
                          onChange={(event) => setNewTripItem(event.target.value)}
                          placeholder="Printed tickets, gifts, medication..."
                        />
                      </label>
                      <button className="secondary-button" type="submit">
                        Add to trip
                      </button>
                    </form>

                    <div className="item-list">
                      {tripPackingItems.length === 0 ? (
                        <p className="empty-state">
                          Attach a packing list or add trip-specific items.
                        </p>
                      ) : null}
                      {tripPackingItems.map((item) => (
                        <div
                          className="packing-item-row trip-packing-item-row"
                          key={item.key}
                        >
                          <div className="check-row">
                            <input
                              aria-label={`Pack ${item.label}`}
                              type="checkbox"
                              checked={item.packed}
                              onChange={() => togglePackingItem(item.key)}
                            />
                            {item.key.startsWith('custom:') ? (
                              <input
                                className="packing-item-name-input"
                                value={item.label}
                                onChange={(event) =>
                                  updateCustomTripItemLabel(
                                    item.key.replace('custom:', ''),
                                    event.target.value
                                  )
                                }
                              />
                            ) : (
                              <span>{item.label}</span>
                            )}
                          </div>
                          <div className="trip-packing-item-actions">
                            <span className="source-pill">{item.source}</span>
                            <RemoveIconButton
                              label={`Remove ${item.label}`}
                              onClick={() => removeTripPackingItem(item.key)}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  </fieldset>
                </div>
              ) : (
                <p className="empty-state">
                  {activeTab === 'history'
                    ? 'Trips will move here after their end date passes.'
                    : 'Create a trip to start planning.'}
                </p>
              )}
            </section>
          </section>
        ) : null}

        {activeTab === 'locations' ? (
          <section className="grid gap-5 lg:grid-cols-[280px_1fr]">
            <aside className="panel">
              <div className="section-heading">
                <h2>Locations</h2>
                <button className="icon-button" type="button" onClick={addLocation}>
                  +
                </button>
              </div>
              {selectedLocation ? (
                <button
                  aria-expanded={isMobileItemSwitcherOpen}
                  aria-haspopup="dialog"
                  className="mobile-current-selection"
                  type="button"
                  onClick={() => setIsMobileItemSwitcherOpen(true)}
                >
                  <span className="mobile-current-selection-content">
                    <span className="font-semibold">{selectedLocation.name}</span>
                    <span className="text-sm text-app-muted">
                      {selectedLocation.travelLegs.length} route options
                    </span>
                  </span>
                  <span className="mobile-selection-chevron" aria-hidden="true" />
                </button>
              ) : null}
              <div className="mobile-collapsible-list">
                {sortedLocations.map((location) => (
                  <button
                    className={
                      location.id === selectedLocation?.id
                        ? 'list-row list-row-active'
                        : 'list-row'
                    }
                    key={location.id}
                    type="button"
                    onClick={() => {
                      setAppState((current) => ({
                        ...current,
                        selectedLocationId: location.id
                      }));
                      setIsMobileItemSwitcherOpen(false);
                    }}
                  >
                    <span className="font-semibold">{location.name}</span>
                    <span className="text-sm text-app-muted">
                      {location.travelLegs.length} route options
                    </span>
                  </button>
                ))}
              </div>
              {isMobileItemSwitcherOpen ? (
                <div
                  aria-label="Choose location"
                  aria-modal="true"
                  className="mobile-picker"
                  role="dialog"
                >
                  <button
                    aria-label="Close picker"
                    className="mobile-picker-backdrop"
                    type="button"
                    onClick={() => setIsMobileItemSwitcherOpen(false)}
                  />
                  <div className="mobile-picker-sheet">
                    <div className="mobile-picker-header">
                      <h3>Choose location</h3>
                      <button
                        aria-label="Close picker"
                        className="mobile-picker-close"
                        type="button"
                        onClick={() => setIsMobileItemSwitcherOpen(false)}
                      >
                        ×
                      </button>
                    </div>
                    <div className="mobile-picker-options">
                      {sortedLocations.map((location) => (
                        <button
                          className={
                            location.id === selectedLocation?.id
                              ? 'list-row list-row-active'
                              : 'list-row'
                          }
                          key={location.id}
                          type="button"
                          onClick={() => {
                            setAppState((current) => ({
                              ...current,
                              selectedLocationId: location.id
                            }));
                            setIsMobileItemSwitcherOpen(false);
                          }}
                        >
                          <span className="font-semibold">{location.name}</span>
                          <span className="text-sm text-app-muted">
                            {location.travelLegs.length} route options
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </aside>

            <section className="panel">
              {selectedLocation ? (
                <div className="grid gap-5">
                  <div className="section-heading">
                    <h2>Location details</h2>
                    <button
                      className="quiet-button"
                      type="button"
                      onClick={deleteSelectedLocation}
                    >
                      Delete
                    </button>
                  </div>

                  <div className="grid gap-4">
                    <label className="field">
                      <span>Location name</span>
                      <input
                        value={selectedLocation.name}
                        onChange={(event) =>
                          updateSelectedLocation((location) => ({
                            ...location,
                            name: event.target.value
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Notes</span>
                      <PersistentNoteTextarea
                        rows={2}
                        storageKey={`location:${selectedLocation.id}:notes`}
                        value={selectedLocation.notes}
                        onChange={(event) =>
                          updateSelectedLocation((location) => ({
                            ...location,
                            notes: event.target.value
                          }))
                        }
                      />
                    </label>
                  </div>

                  <div className="section-heading">
                    <h2>Travel routes</h2>
                    <button className="secondary-button" type="button" onClick={addTravelLeg}>
                      + Add route
                    </button>
                  </div>

                  <div className="grid gap-3">
                    {selectedLocation.travelLegs.length === 0 ? (
                      <p className="empty-state">
                        Add route options with mode and expected duration.
                      </p>
                    ) : null}

                    {selectedLocation.travelLegs.map((leg) => (
                      <article className="travel-leg" key={leg.id}>
                        <RouteReturnToggle
                          value={leg.returnType}
                          onChange={(returnType) =>
                            updateTravelLeg(leg.id, (currentLeg) =>
                              updateTravelLegReturnType(returnType, currentLeg)
                            )
                          }
                        />
                        <div className="travel-leg-header">
                          <h3 className="subheading mb-0">
                            {leg.returnType === 'different'
                              ? 'Way there'
                              : 'Route'}
                          </h3>
                          <span>{formatDuration(leg.durationMinutes)}</span>
                        </div>
                        <div className="form-grid compact">
                          <label className="field">
                            <span>From</span>
                            <AddressAutocompleteInput
                              value={leg.from}
                              homeAddress={appState.settings.homeAddress}
                              placesAutocompleteEnabled={isServerBacked}
                              onChange={(value) =>
                                updateTravelLeg(leg.id, (currentLeg) => ({
                                  ...currentLeg,
                                  from: value
                                }))
                              }
                              placeholder="Start address or place"
                            />
                          </label>
                          <label className="field">
                            <span>To</span>
                            <AddressAutocompleteInput
                              value={leg.to}
                              homeAddress={appState.settings.homeAddress}
                              placesAutocompleteEnabled={isServerBacked}
                              onChange={(value) =>
                                updateTravelLeg(leg.id, (currentLeg) => ({
                                  ...currentLeg,
                                  to: value
                                }))
                              }
                              placeholder="Destination address or place"
                            />
                          </label>
                          <label className="field">
                            <span>Mode</span>
                            <TravelModeSelect
                              value={leg.mode}
                              onChange={(value) =>
                                updateTravelLeg(leg.id, (currentLeg) => ({
                                  ...currentLeg,
                                  mode: value
                                }))
                              }
                            />
                          </label>
                          <label className="field">
                            <span>Duration (minutes)</span>
                            <input
                              min="0"
                              type="number"
                              value={leg.durationMinutes ?? ''}
                              onChange={(event) =>
                                updateTravelLeg(leg.id, (currentLeg) => ({
                                  ...currentLeg,
                                  durationMinutes: event.target.value
                                    ? Number(event.target.value)
                                    : null
                                }))
                              }
                            />
                          </label>
                        </div>
                        <RouteMapPreview
                          currentDurationMinutes={leg.durationMinutes}
                          destination={leg.to}
                          mapsEnabled={isServerBacked}
                          mode={leg.mode}
                          origin={leg.from}
                          onDurationMinutesChange={(durationMinutes) =>
                            updateTravelLeg(leg.id, (currentLeg) => ({
                              ...currentLeg,
                              durationMinutes
                            }))
                          }
                        />
                        <label className="field">
                          <span>Notes</span>
                          <PersistentNoteTextarea
                            rows={2}
                            storageKey={`location:${selectedLocation.id}:leg:${leg.id}:notes`}
                            value={leg.notes}
                            onChange={(event) =>
                              updateTravelLeg(leg.id, (currentLeg) => ({
                                ...currentLeg,
                                notes: event.target.value
                              }))
                            }
                          />
                        </label>
                        {leg.returnType === 'different' ? (
                          <div className="grid gap-3 border-t border-app-line pt-3">
                            <div className="travel-leg-header">
                              <h3 className="subheading mb-0">Way back</h3>
                              <span>
                                {formatDuration(leg.returnLeg.durationMinutes)}
                              </span>
                            </div>
                            <div className="form-grid compact">
                              <label className="field">
                                <span>From</span>
                                <AddressAutocompleteInput
                                  value={leg.returnLeg.from}
                                  homeAddress={appState.settings.homeAddress}
                                  placesAutocompleteEnabled={isServerBacked}
                                  onChange={(value) =>
                                    updateTravelLeg(leg.id, (currentLeg) => ({
                                      ...currentLeg,
                                      returnLeg: {
                                        ...currentLeg.returnLeg,
                                        from: value
                                      }
                                    }))
                                  }
                                  placeholder="Return start address or place"
                                />
                              </label>
                              <label className="field">
                                <span>To</span>
                                <AddressAutocompleteInput
                                  value={leg.returnLeg.to}
                                  homeAddress={appState.settings.homeAddress}
                                  placesAutocompleteEnabled={isServerBacked}
                                  onChange={(value) =>
                                    updateTravelLeg(leg.id, (currentLeg) => ({
                                      ...currentLeg,
                                      returnLeg: {
                                        ...currentLeg.returnLeg,
                                        to: value
                                      }
                                    }))
                                  }
                                  placeholder="Return destination address or place"
                                />
                              </label>
                              <label className="field">
                                <span>Mode</span>
                                <TravelModeSelect
                                  value={leg.returnLeg.mode}
                                  onChange={(value) =>
                                    updateTravelLeg(leg.id, (currentLeg) => ({
                                      ...currentLeg,
                                      returnLeg: {
                                        ...currentLeg.returnLeg,
                                        mode: value
                                      }
                                    }))
                                  }
                                />
                              </label>
                              <label className="field">
                                <span>Duration (minutes)</span>
                                <input
                                  min="0"
                                  type="number"
                                  value={leg.returnLeg.durationMinutes ?? ''}
                                  onChange={(event) =>
                                    updateTravelLeg(leg.id, (currentLeg) => ({
                                      ...currentLeg,
                                      returnLeg: {
                                        ...currentLeg.returnLeg,
                                        durationMinutes: event.target.value
                                          ? Number(event.target.value)
                                          : null
                                      }
                                    }))
                                  }
                                />
                              </label>
                            </div>
                            <RouteMapPreview
                              currentDurationMinutes={
                                leg.returnLeg.durationMinutes
                              }
                              destination={leg.returnLeg.to}
                              mapsEnabled={isServerBacked}
                              mode={leg.returnLeg.mode}
                              origin={leg.returnLeg.from}
                              onDurationMinutesChange={(durationMinutes) =>
                                updateTravelLeg(leg.id, (currentLeg) => ({
                                  ...currentLeg,
                                  returnLeg: {
                                    ...currentLeg.returnLeg,
                                    durationMinutes
                                  }
                                }))
                              }
                            />
                            <label className="field">
                              <span>Return notes</span>
                              <PersistentNoteTextarea
                                rows={2}
                                storageKey={`location:${selectedLocation.id}:leg:${leg.id}:return-notes`}
                                value={leg.returnLeg.notes}
                                onChange={(event) =>
                                  updateTravelLeg(leg.id, (currentLeg) => ({
                                    ...currentLeg,
                                    returnLeg: {
                                      ...currentLeg.returnLeg,
                                      notes: event.target.value
                                    }
                                  }))
                                }
                              />
                            </label>
                          </div>
                        ) : null}
                        <button
                          className="quiet-button self-start"
                          type="button"
                          onClick={() => removeTravelLeg(leg.id)}
                        >
                          Remove route
                        </button>
                      </article>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="empty-state">Add a location to plan route options.</p>
              )}
            </section>
          </section>
        ) : null}

        {activeTab === 'lists' ? (
          <section className="grid gap-5 lg:grid-cols-[280px_1fr]">
            <aside className="panel">
              <div className="section-heading">
                <h2>Reusable lists</h2>
                <button className="icon-button" type="button" onClick={addPackingList}>
                  +
                </button>
              </div>
              {selectedPackingList ? (
                <button
                  aria-expanded={isMobileItemSwitcherOpen}
                  aria-haspopup="dialog"
                  className="mobile-current-selection"
                  type="button"
                  onClick={() => setIsMobileItemSwitcherOpen(true)}
                >
                  <span className="mobile-current-selection-content">
                    <span className="font-semibold">{selectedPackingList.name}</span>
                    <span className="text-sm text-app-muted">
                      {selectedPackingList.items.length} items
                    </span>
                  </span>
                  <span className="mobile-selection-chevron" aria-hidden="true" />
                </button>
              ) : null}
              <div className="mobile-collapsible-list">
                {appState.packingLists.map((list) => (
                  <button
                    className={
                      list.id === selectedPackingList?.id
                        ? 'list-row list-row-active'
                        : 'list-row'
                    }
                    key={list.id}
                    type="button"
                    onClick={() => {
                      setSelectedPackingListId(list.id);
                      setIsMobileItemSwitcherOpen(false);
                    }}
                  >
                    <span className="font-semibold">{list.name}</span>
                    <span className="text-sm text-app-muted">
                      {list.items.length} items
                    </span>
                  </button>
                ))}
              </div>
              {isMobileItemSwitcherOpen ? (
                <div
                  aria-label="Choose packing list"
                  aria-modal="true"
                  className="mobile-picker"
                  role="dialog"
                >
                  <button
                    aria-label="Close picker"
                    className="mobile-picker-backdrop"
                    type="button"
                    onClick={() => setIsMobileItemSwitcherOpen(false)}
                  />
                  <div className="mobile-picker-sheet">
                    <div className="mobile-picker-header">
                      <h3>Choose packing list</h3>
                      <button
                        aria-label="Close picker"
                        className="mobile-picker-close"
                        type="button"
                        onClick={() => setIsMobileItemSwitcherOpen(false)}
                      >
                        ×
                      </button>
                    </div>
                    <div className="mobile-picker-options">
                      {appState.packingLists.map((list) => (
                        <button
                          className={
                            list.id === selectedPackingList?.id
                              ? 'list-row list-row-active'
                              : 'list-row'
                          }
                          key={list.id}
                          type="button"
                          onClick={() => {
                            setSelectedPackingListId(list.id);
                            setIsMobileItemSwitcherOpen(false);
                          }}
                        >
                          <span className="font-semibold">{list.name}</span>
                          <span className="text-sm text-app-muted">
                            {list.items.length} items
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </aside>

            <section className="panel">
              {selectedPackingList ? (
                <div className="grid gap-5">
                  <div className="section-heading">
                    <h2>Edit list</h2>
                    <button
                      className="quiet-button"
                      type="button"
                      onClick={() => deletePackingList(selectedPackingList.id)}
                    >
                      Delete
                    </button>
                  </div>

                  <label className="field">
                    <span>List name</span>
                    <input
                      value={selectedPackingList.name}
                      onChange={(event) =>
                        updatePackingList(selectedPackingList.id, (list) => ({
                          ...list,
                          name: event.target.value
                        }))
                      }
                    />
                  </label>

                  <form
                    className="inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      addItemToPackingList();
                    }}
                  >
                    <label className="field grow">
                      <span>New item</span>
                      <input
                        value={newListItem}
                        onChange={(event) => setNewListItem(event.target.value)}
                        placeholder="Passport, charger, rain jacket..."
                      />
                    </label>
                    <button className="secondary-button" type="submit">
                      Add item
                    </button>
                  </form>

                  <div className="item-list">
                    {selectedPackingList.items.length === 0 ? (
                      <p className="empty-state">Add custom items to this list.</p>
                    ) : null}
                    {previewPackingListItems.map((item) => (
                      <div
                        className={
                          item.id === draggedPackingItemId
                            ? 'packing-item-row packing-item-row-dragging'
                            : 'packing-item-row'
                        }
                        key={item.id}
                        onDragOver={(event) =>
                          handlePackingItemDragOver(event, item.id)
                        }
                        onDrop={(event) =>
                          handlePackingItemDrop(event, item.id)
                        }
                      >
                        <span
                          className="drag-handle"
                          draggable
                          title="Reorder item"
                          onDragEnd={clearPackingItemDrag}
                          onDragStart={(event) =>
                            handlePackingItemDragStart(event, item.id)
                          }
                        >
                          <span aria-hidden="true" className="drag-handle-dots">
                            <span />
                            <span />
                            <span />
                            <span />
                            <span />
                            <span />
                          </span>
                        </span>
                        <label className="packing-item-label field">
                          <span className="sr-only">Item name</span>
                          <input
                            value={item.label}
                            onChange={(event) =>
                              updatePackingListItemLabel(
                                selectedPackingList.id,
                                item.id,
                                event.target.value
                              )
                            }
                          />
                        </label>
                        <RemoveIconButton
                          label={`Remove ${item.label}`}
                          onClick={() =>
                            removeItemFromPackingList(
                              selectedPackingList.id,
                              item.id
                            )
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="empty-state">Create a reusable packing list.</p>
              )}
            </section>
          </section>
        ) : null}

        {activeTab === 'settings' ? (
          <section className="grid gap-5">
            <section className="panel">
              <div className="grid gap-5">
                <div>
                  <h2 className="text-xl font-semibold text-app-ink">Settings</h2>
                  <p className="mt-1 text-sm text-app-muted">
                    Save defaults that make trip planning faster.
                  </p>
                </div>

                <label className="field">
                  <span>Home address</span>
                  <AddressAutocompleteInput
                    value={appState.settings.homeAddress}
                    homeAddress=""
                    placesAutocompleteEnabled={isServerBacked}
                    onChange={updateHomeAddress}
                    placeholder="Type your home address"
                  />
                </label>
              </div>
            </section>

            {isServerBacked ? (
              <CloudSyncPanel />
            ) : (
              <section className="panel">
                <p className="empty-state">
                  Cloud sync is available when the app is running with the local
                  travel data API.
                </p>
              </section>
            )}
          </section>
        ) : null}
      </div>
    </main>
  );
}

export default App;
