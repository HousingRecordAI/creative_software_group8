import localforage from 'localforage';

const STORAGE_KEY = 'deposit-defender-data-v2';
const PHASE_KEY = 'deposit-defender-phase';

// Configure localforage
localforage.config({
  name: 'Deposit Defender',
  storeName: 'photos_v2',
  description: 'Persistent storage for room photos and inspection data'
});

export type InspectionPhase = 'move-in' | 'move-out';

// Phase -> RoomId -> StepId -> Photos[]
export type PhotoData = Record<string, Record<string, string[]>>;
export type PersistentData = {
  photos: Record<InspectionPhase, PhotoData>;
  currentPhase: InspectionPhase;
  roomConfig?: Record<string, number>;
  blockchainProof?: {
    hash: string;
    txId: string;
    timestamp: number;
  };
};

const INITIAL_DATA: PersistentData = {
  photos: {
    'move-in': {},
    'move-out': {}
  },
  currentPhase: 'move-in'
};

/**
 * Loads the application data from IndexedDB.
 */
export async function loadAppData(): Promise<PersistentData> {
  try {
    const data = await localforage.getItem<PersistentData>(STORAGE_KEY);
    return data || INITIAL_DATA;
  } catch (error) {
    console.error('Failed to load data from localforage:', error);
    return INITIAL_DATA;
  }
}

/**
 * Saves the application data to IndexedDB.
 */
export async function saveAppData(data: PersistentData): Promise<void> {
  try {
    await localforage.setItem(STORAGE_KEY, data);
  } catch (error) {
    console.error('Failed to save data to localforage:', error);
  }
}

/**
 * Clears all stored data.
 */
export async function clearAppData(): Promise<void> {
  try {
    await localforage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear data from localforage:', error);
  }
}
