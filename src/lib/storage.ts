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

export interface GuidedCaptureStep {
  id: string;
  label: string;
  guide: string;
  target?: string;
  angle?: 'wide' | 'detail' | 'low';
  minPhotos?: number;
  coverageCriteria?: string[];
}

export interface CapturePlan {
  summary: string;
  tasks: GuidedCaptureStep[];
  source: 'ai' | 'fallback';
  generatedAt: number;
  elapsedMs?: number;
}

export interface CaptureReview {
  status: 'pass' | 'retry' | 'saved';
  message: string;
  hint?: string;
  source: 'ai' | 'fallback';
  reviewedAt: number;
  elapsedMs?: number;
  photoIndex?: number;
}

export interface BlockchainProof {
  hash: string;
  txId: string;
  timestamp: number;
  rootHash?: string;
  blockHash?: string;
  blockHeight?: number;
  previousBlockHash?: string;
  recordCount?: number;
  inspectionId?: string;
  phase?: InspectionPhase;
  chainName?: string;
}

// Phase -> RoomId -> StepId -> Photos[]
export type PhotoData = Record<string, Record<string, string[]>>;
export type PersistentData = {
  photos: Record<InspectionPhase, PhotoData>;
  currentPhase: InspectionPhase;
  roomConfig?: Record<string, number>;
  capturePlans?: Partial<Record<InspectionPhase, Record<string, CapturePlan>>>;
  captureReviews?: Partial<Record<InspectionPhase, Record<string, Record<string, CaptureReview | CaptureReview[]>>>>;
  blockchainProof?: BlockchainProof;
  aiMode?: 'claude' | 'ollama';
};

const INITIAL_DATA: PersistentData = {
  photos: {
    'move-in': {},
    'move-out': {}
  },
  currentPhase: 'move-in',
  aiMode: 'claude'
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
