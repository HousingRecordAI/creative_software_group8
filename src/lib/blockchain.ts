import localforage from 'localforage';
import { computeHash } from './hash';
import type { BlockchainProof, InspectionPhase, PhotoData } from './storage';

const CHAIN_KEY = 'deposit-defender-local-chain-v1';
const CHAIN_NAME = 'House Record Local Chain';
const GENESIS_HASH = '0x' + '0'.repeat(64);

export interface EvidenceRecord {
  sequence: number;
  phase: InspectionPhase;
  roomId: string;
  stepId: string;
  photoIndex: number;
  photoHash: string;
  previousRecordHash: string;
  recordHash: string;
}

interface LocalBlockCore {
  height: number;
  timestamp: number;
  inspectionId: string;
  phase: InspectionPhase;
  rootHash: string;
  recordCount: number;
  previousBlockHash: string;
  metadata: unknown;
}

export interface LocalBlock extends LocalBlockCore {
  blockHash: string;
  txId: string;
}

export interface VerificationResult {
  isValid: boolean;
  title: string;
  detail: string;
  recomputedRootHash?: string;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortObject((value as Record<string, unknown>)[key]);
      return acc;
    }, {});
}

function stableStringify(value: unknown) {
  return JSON.stringify(sortObject(value));
}

async function hashValue(value: unknown) {
  return '0x' + await computeHash(stableStringify(value));
}

async function loadChain(): Promise<LocalBlock[]> {
  return (await localforage.getItem<LocalBlock[]>(CHAIN_KEY)) || [];
}

async function saveChain(chain: LocalBlock[]) {
  await localforage.setItem(CHAIN_KEY, chain);
}

async function verifyStoredChain(chain: LocalBlock[]) {
  for (let i = 0; i < chain.length; i += 1) {
    const block = chain[i];
    const { blockHash, txId, ...core } = block;
    const expectedHash = await hashValue(core);
    const expectedPrevious = i === 0 ? GENESIS_HASH : chain[i - 1].blockHash;
    if (blockHash !== expectedHash || core.previousBlockHash !== expectedPrevious || !txId) {
      return false;
    }
  }
  return true;
}

export async function buildEvidenceChain(photos: PhotoData, phase: InspectionPhase) {
  const records: EvidenceRecord[] = [];
  let previousRecordHash = GENESIS_HASH;
  let sequence = 0;

  for (const roomId of Object.keys(photos).sort()) {
    const roomPhotos = photos[roomId] || {};
    for (const stepId of Object.keys(roomPhotos).sort()) {
      const stepPhotos = roomPhotos[stepId] || [];
      for (let photoIndex = 0; photoIndex < stepPhotos.length; photoIndex += 1) {
        const photoHash = '0x' + await computeHash(stepPhotos[photoIndex]);
        const core = {
          sequence,
          phase,
          roomId,
          stepId,
          photoIndex,
          photoHash,
          previousRecordHash
        };
        const recordHash = await hashValue(core);
        records.push({ ...core, recordHash });
        previousRecordHash = recordHash;
        sequence += 1;
      }
    }
  }

  const rootHash = records.length > 0
    ? records[records.length - 1].recordHash
    : await hashValue({ phase, empty: true });

  return { rootHash, records };
}

export async function anchorInspectionEvidence(params: {
  phase: InspectionPhase;
  photos: PhotoData;
  metadata: unknown;
}): Promise<BlockchainProof> {
  const chain = await loadChain();
  const chainOk = await verifyStoredChain(chain);
  if (!chainOk) throw new Error('Local blockchain data is corrupted.');

  const evidence = await buildEvidenceChain(params.photos, params.phase);
  const timestamp = Date.now();
  const inspectionId = `inspection-${timestamp.toString(36)}`;
  const previousBlockHash = chain.length > 0 ? chain[chain.length - 1].blockHash : GENESIS_HASH;

  const core: LocalBlockCore = {
    height: chain.length,
    timestamp,
    inspectionId,
    phase: params.phase,
    rootHash: evidence.rootHash,
    recordCount: evidence.records.length,
    previousBlockHash,
    metadata: params.metadata
  };
  const blockHash = await hashValue(core);
  const txId = await hashValue({ type: 'tx', blockHash, timestamp, height: core.height });
  const block: LocalBlock = { ...core, blockHash, txId };

  await saveChain([...chain, block]);

  return {
    hash: evidence.rootHash,
    rootHash: evidence.rootHash,
    txId,
    timestamp,
    blockHash,
    blockHeight: core.height,
    previousBlockHash,
    recordCount: evidence.records.length,
    inspectionId,
    phase: params.phase,
    chainName: CHAIN_NAME
  };
}

export async function verifyInspectionEvidence(
  proof: BlockchainProof | undefined,
  photos: PhotoData
): Promise<VerificationResult> {
  if (!proof?.rootHash || !proof.phase) {
    return {
      isValid: false,
      title: '검증할 앵커 없음',
      detail: '증거 root가 아직 로컬 체인에 기록되지 않았습니다.'
    };
  }

  const chain = await loadChain();
  const chainOk = await verifyStoredChain(chain);
  if (!chainOk) {
    return {
      isValid: false,
      title: '체인 무결성 실패',
      detail: '로컬 블록의 이전 해시 연결이 깨졌습니다.'
    };
  }

  const block = chain.find(item => item.blockHash === proof.blockHash && item.txId === proof.txId);
  if (!block) {
    return {
      isValid: false,
      title: '앵커 블록 없음',
      detail: '저장된 로컬 체인에서 해당 트랜잭션을 찾을 수 없습니다.'
    };
  }

  const evidence = await buildEvidenceChain(photos, proof.phase);
  if (evidence.rootHash !== proof.rootHash) {
    return {
      isValid: false,
      title: '사진 세트 불일치',
      detail: '현재 사진으로 다시 계산한 root가 블록체인에 고정된 root와 다릅니다.',
      recomputedRootHash: evidence.rootHash
    };
  }

  return {
    isValid: true,
    title: '증거 검증 완료',
    detail: `${block.recordCount}장의 사진 해시가 로컬 블록 #${block.height}의 root와 일치합니다.`,
    recomputedRootHash: evidence.rootHash
  };
}
