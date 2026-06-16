/// <reference lib="dom" />

function getLocalStorage() {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage;
}

function runWithLocalStorage<T>(
  action: (localStorage: Storage) => T,
  fallbackValue: T
) {
  const localStorage = getLocalStorage();

  if (!localStorage) {
    return fallbackValue;
  }

  try {
    return action(localStorage);
  } catch (error) {
    console.error(error);
    return fallbackValue;
  }
}

export function readJsonStorageValue(storageKey: string) {
  return runWithLocalStorage((localStorage) => {
    const storedValue = localStorage.getItem(storageKey);
    return storedValue ? (JSON.parse(storedValue) as unknown) : null;
  }, null);
}

export function writeJsonStorageValue(storageKey: string, value: unknown) {
  runWithLocalStorage((localStorage) => {
    localStorage.setItem(storageKey, JSON.stringify(value));
  }, undefined);
}
