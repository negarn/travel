import type { Meta, StoryObj } from '@storybook/react';
import App from '../App';
import { demoTravelState } from '../demo/travelDemoState';
import type { TravelAppState } from '../types/travel';

function AppStoryHarness({
  initialState
}: {
  initialState: TravelAppState;
}) {
  return <App initialState={initialState} />;
}

const emptyTravelState: TravelAppState = {
  selectedTripId: '',
  selectedLocationId: '',
  settings: {
    homeAddress: ''
  },
  trips: [],
  locations: [],
  packingLists: []
};

const meta = {
  title: 'App/States',
  parameters: {
    docs: {
      description: {
        component:
          'Full app stories. Default shows demo travel planning data while Empty exercises the zero-state flow.'
      }
    }
  }
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <AppStoryHarness initialState={demoTravelState} />
  )
};

export const Empty: Story = {
  render: () => (
    <AppStoryHarness initialState={emptyTravelState} />
  )
};
