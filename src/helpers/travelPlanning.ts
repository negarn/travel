import type { PackingList, Trip, TripPackingSummaryItem } from '../types/travel';

function getPackingListItemKey(listId: string, itemId: string): string {
  return `list:${listId}:${itemId}`;
}

export function formatDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) {
    return 'Add duration';
  }

  const roundedMinutes = Math.round(minutes);
  const hours = Math.floor(roundedMinutes / 60);
  const remainingMinutes = roundedMinutes % 60;

  if (hours === 0) {
    return `${remainingMinutes} min`;
  }

  if (remainingMinutes === 0) {
    return `${hours} hr`;
  }

  return `${hours} hr ${remainingMinutes} min`;
}

export function deriveTripPackingItems(
  trip: Trip,
  packingLists: PackingList[]
): TripPackingSummaryItem[] {
  const selectedLists = packingLists.filter((list) =>
    trip.packingListIds.includes(list.id)
  );

  const listItems = selectedLists.flatMap((list) =>
    list.items
      .map((item) => {
        const key = getPackingListItemKey(list.id, item.id);

        return {
          key,
          item
        };
      })
      .filter(({ key }) => !trip.excludedPackingItemKeys.includes(key))
      .map(({ key, item }) => ({
        key,
        label: item.label,
        source: list.name,
        packed: trip.packedItemKeys.includes(key)
      }))
  );

  const customItems = trip.customPackingItems.map((item) => ({
    key: `custom:${item.id}`,
    label: item.label,
    source: 'Trip items',
    packed: item.packed
  }));

  return sortPackedItemsLast([...listItems, ...customItems]);
}

export function countPackedItems(items: TripPackingSummaryItem[]): number {
  return items.filter((item) => item.packed).length;
}

export function sortPackedItemsLast(
  items: TripPackingSummaryItem[]
): TripPackingSummaryItem[] {
  return [...items].sort((firstItem, secondItem) => {
    if (firstItem.packed === secondItem.packed) {
      return 0;
    }

    return firstItem.packed ? 1 : -1;
  });
}
