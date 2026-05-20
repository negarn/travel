import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig } from 'vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: [
    '@storybook/addon-essentials',
    '@storybook/addon-interactions',
    '@storybook/addon-a11y'
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {}
  },
  docs: {
    autodocs: 'tag'
  },
  viteFinal: async (config) =>
    mergeConfig(config, {
      build: {
        target: 'esnext'
      },
      optimizeDeps: {
        esbuildOptions: {
          target: 'esnext'
        }
      }
    })
};

export default config;
