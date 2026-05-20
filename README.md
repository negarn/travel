# Travel Plans

A small Vite, React, TypeScript, and Tailwind app for planning trips and packing lists.

## Scripts

- `npm run dev` starts the local Vite server.
- `npm run dev:demo` starts a demo server with sample travel data on port `5174`.
- `npm run demo:seed` writes demo data to `.travel-demo/travel-data.json`.
- `npm run build` type-checks and builds the app.
- `npm run test:run` runs the Vitest suite once.
- `npm run preview` serves the production build.
- `npm run storybook` opens Storybook with populated and empty app states.

App data is stored locally as JSON in `~/.travel/travel-data.json` by default.
Set `TRAVEL_DATA_DIR` to use another directory.

Cloud sync can be enabled with OAuth credentials:

- Google Drive: `TRAVEL_GOOGLE_DRIVE_CLIENT_ID` and `TRAVEL_GOOGLE_DRIVE_CLIENT_SECRET`
- Dropbox: `TRAVEL_DROPBOX_CLIENT_ID` and `TRAVEL_DROPBOX_CLIENT_SECRET`

## Docker

Build and run the production preview server:

```sh
docker build -t travel-plans .
docker run --rm -p 4173:4173 travel-plans
```
