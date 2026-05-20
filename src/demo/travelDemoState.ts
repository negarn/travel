import type { TravelAppState } from '../types/travel';

export const demoTravelState: TravelAppState = {
  selectedTripId: 'trip-montreal',
  selectedLocationId: 'location-montreal',
  trips: [
    {
      id: 'trip-montreal',
      name: 'Montreal long weekend',
      locationId: 'location-montreal',
      location: 'Montreal, QC',
      startAt: '2026-06-12T09:00',
      endAt: '2026-06-15T18:00',
      stayName: 'Hotel Monville',
      stayAddress: '1041 Rue de Bleury, Montreal, QC',
      notes: 'Try to keep Friday light and leave Monday evening open.',
      travelLegs: [
        {
          id: 'leg-train',
          from: 'Toronto Union',
          to: 'Montreal Central',
          mode: 'Train',
          durationMinutes: 315,
          notes: 'Book seats near the quiet car if available.',
          returnType: 'roundtrip',
          returnLeg: {
            from: '',
            to: '',
            mode: '',
            durationMinutes: null,
            notes: ''
          }
        }
      ],
      checklistItems: [
        { id: 'check-dinner', label: 'Confirm dinner reservation', done: false },
        { id: 'check-tickets', label: 'Download train tickets', done: true }
      ],
      packingListIds: ['list-weekend', 'list-tech'],
      customPackingItems: [
        { id: 'custom-pass', label: 'Museum tickets', packed: false }
      ],
      packedItemKeys: ['list:list-tech:item-charger'],
      excludedPackingItemKeys: [],
      packingSnapshotItems: null
    }
  ],
  locations: [
    {
      id: 'location-montreal',
      name: 'Montreal, QC',
      notes: 'Food weekend, old port walks, and a museum afternoon.',
      travelLegs: [
        {
          id: 'leg-train',
          from: 'Toronto Union',
          to: 'Montreal Central',
          mode: 'Train',
          durationMinutes: 315,
          notes: 'Book seats near the quiet car if available.',
          returnType: 'roundtrip',
          returnLeg: {
            from: '',
            to: '',
            mode: '',
            durationMinutes: null,
            notes: ''
          }
        },
        {
          id: 'leg-drive',
          from: 'Toronto',
          to: 'Montreal',
          mode: 'Car',
          durationMinutes: 360,
          notes: 'Leave early to avoid the afternoon traffic around Kingston.',
          returnType: 'different',
          returnLeg: {
            from: 'Montreal',
            to: 'Toronto',
            mode: 'Train',
            durationMinutes: 315,
            notes: 'Return by train if the drive looks heavy.'
          }
        }
      ]
    },
    {
      id: 'location-halifax',
      name: 'Halifax, NS',
      notes: 'Potential summer trip with ocean walks and day trips.',
      travelLegs: [
        {
          id: 'leg-flight',
          from: 'Toronto Pearson',
          to: 'Halifax Stanfield',
          mode: 'Flight',
          durationMinutes: 125,
          notes: 'Check carry-on rules before booking basic fare.',
          returnType: 'roundtrip',
          returnLeg: {
            from: '',
            to: '',
            mode: '',
            durationMinutes: null,
            notes: ''
          }
        }
      ]
    }
  ],
  packingLists: [
    {
      id: 'list-weekend',
      name: 'Weekend basics',
      items: [
        { id: 'item-shirts', label: '2 shirts' },
        { id: 'item-socks', label: 'Socks' },
        { id: 'item-toiletries', label: 'Toiletries' }
      ]
    },
    {
      id: 'list-tech',
      name: 'Tech pouch',
      items: [
        { id: 'item-charger', label: 'Phone charger' },
        { id: 'item-headphones', label: 'Headphones' }
      ]
    }
  ]
};
