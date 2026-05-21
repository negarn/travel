export const demoDataDirName = '.travel-demo';

export const demoTravelData = {
  selectedTripId: 'trip-montreal',
  selectedLocationId: 'location-montreal',
  settings: {
    homeAddress: 'Toronto, ON'
  },
  trips: [
    {
      id: 'trip-montreal',
      name: 'Montreal long weekend',
      locationId: 'location-montreal',
      location: 'Montreal, QC',
      startAt: '2026-06-12T09:00',
      endAt: '2026-06-15T18:00',
      notes: 'Try to keep Friday light and leave Monday evening open.',
      travelLegs: [
        {
          id: 'leg-train',
          from: 'Toronto Union',
          to: 'Montreal Central',
          mode: 'DRIVE',
          durationMinutes: 315,
          notes: 'Book seats near the quiet car if available.',
          returnType: 'roundtrip',
          returnLeg: {
            from: '',
            to: '',
            mode: 'DRIVE',
            durationMinutes: null,
            notes: ''
          }
        }
      ],
      packingListIds: ['list-weekend', 'list-tech'],
      customPackingItems: [
        { id: 'custom-pass', label: 'Museum tickets', packed: false }
      ],
      packedItemKeys: ['list:list-tech:item-charger']
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
          mode: 'DRIVE',
          durationMinutes: 315,
          notes: 'Book seats near the quiet car if available.',
          returnType: 'roundtrip',
          returnLeg: {
            from: '',
            to: '',
            mode: 'DRIVE',
            durationMinutes: null,
            notes: ''
          }
        },
        {
          id: 'leg-drive',
          from: 'Toronto',
          to: 'Montreal',
          mode: 'DRIVE',
          durationMinutes: 360,
          notes: 'Leave early to avoid the afternoon traffic around Kingston.',
          returnType: 'different',
          returnLeg: {
            from: 'Montreal',
            to: 'Toronto',
            mode: 'DRIVE',
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
          mode: 'FLIGHT',
          durationMinutes: 125,
          notes: 'Check carry-on rules before booking basic fare.',
          returnType: 'roundtrip',
          returnLeg: {
            from: '',
            to: '',
            mode: 'DRIVE',
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
