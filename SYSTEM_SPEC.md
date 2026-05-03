# House Record 시스템 기능 명세서

작성일: 2026-05-02

## 1. 문서 목적

본 문서는 House Record의 현재 구현 기준 시스템 기능을 정리한 명세서이다.

House Record는 임차인이 입주 및 퇴실 시점의 주거 공간 상태를 구조적으로 촬영하고, AI 촬영 감독과 해시 기반 로컬 블록체인 증거 고정을 통해 보증금 분쟁에 대비할 수 있도록 돕는 웹 애플리케이션이다.

본 문서는 다음 범위를 포함한다.

- 공간 구성 및 입주/퇴실 촬영 플로우
- AI 기반 동적 촬영 체크포인트 생성
- 체크포인트별 다중 사진 촬영 및 AI 검수
- 사진 커버리지 완료 판단
- 로컬 블록체인 증거 앵커링 및 검증
- 모바일 카메라 및 Cloudflare Tunnel 기반 테스트 운영

## 2. 시스템 개요

### 2.1 서비스 목적

사용자가 주거 공간을 점검할 때 놓치기 쉬운 증거 사진을 줄이고, 촬영된 사진 세트가 이후 변경되지 않았음을 검증 가능한 형태로 고정한다.

### 2.2 핵심 개념

House Record는 사진 개수를 고정하지 않는다. 각 공간의 첫 사진인 `전체 샷`을 AI가 분석한 뒤, 해당 공간에 맞는 촬영 체크포인트를 동적으로 생성한다.

예를 들어 "방"이라도 전경에 책상, 창문, 가구, 벽면, 콘센트가 보이는지에 따라 촬영 계획이 달라진다. AI는 각 체크포인트마다 필요한 통과 사진 수와 반드시 포함되어야 할 시야 요소를 함께 제안한다.

### 2.3 핵심 가치

- 사용자는 어떤 위치를 찍어야 하는지 직접 추측하지 않아도 된다.
- AI는 공간 전경을 보고 분쟁 증거로 필요한 촬영 체크포인트를 생성한다.
- 각 체크포인트는 1장 이상의 사진을 요구할 수 있다.
- 각 사진은 "하자 있음/없음"이 아니라 "증거 사진으로 충분한가" 기준으로 검수된다.
- 시스템은 체크포인트별 통과 사진 수를 기준으로 공간 촬영 완료 여부를 판단한다.
- 사진 원본은 사용자가 직접 확인할 수 있도록 브라우저 로컬 저장소에 보관된다.
- 사진 세트는 해시와 메타데이터 기반 evidence root로 로컬 체인에 고정된다.
- 퇴실 단계에서는 입주 기준 사진을 참고하여 동일 체크포인트를 다시 촬영하고, 별도 evidence root를 로컬 체인에 고정한다.

## 3. 주요 사용자

| 사용자 | 설명 |
| --- | --- |
| 임차인 | 입주 전/퇴실 전 공간 상태를 기록하고 보증금 분쟁에 대비하려는 사용자 |
| 자취 초년생/유학생 | 어떤 부분을 촬영해야 하는지 잘 모르는 사용자 |
| 데모/심사자 | AI guided capture와 tamper-evident proof 흐름을 확인하는 사용자 |

## 4. 시스템 구성

### 4.1 프론트엔드

- React 18
- TypeScript
- Vite
- PWA 지원
- 모바일 카메라 기반 촬영 UI

### 4.2 Claude AI

- Anthropic Claude API 사용
- 기본 모델: `claude-sonnet-4-6`
- API 경로: `/api/ai/generate`
- Cloudflare Pages 환경변수 `ANTHROPIC_API_KEY` 사용
- 선택 환경변수 `CLAUDE_MODEL` 또는 `ANTHROPIC_MODEL`로 모델명 변경 가능
- Claude tool use를 강제하여 모델 응답을 서버에서 구조화한다.
- 환경 변수:
  - `ANTHROPIC_API_KEY`
  - `CLAUDE_MODEL`
  - `ANTHROPIC_MODEL`

### 4.3 API Key 보호

브라우저는 Claude API를 직접 호출하지 않는다. 모든 AI 요청은 같은 도메인의 `/api/ai/generate` 서버 엔드포인트를 통해 처리한다.

배포 환경에서는 Cloudflare Pages Function이 `ANTHROPIC_API_KEY`를 읽어 Claude에 요청한다. 로컬 `bun run dev` 환경에서는 Vite dev middleware가 동일한 `/api/ai/generate` 경로를 제공한다.

`/api/ai/generate`는 Claude의 자유 텍스트를 그대로 반환하지 않는다. 요청별 `task`에 맞는 tool schema를 강제하고, tool input을 검증한 뒤 아래 표준 envelope로 반환한다.

```json
{ "ok": true, "data": {}, "model": "claude-sonnet-4-6", "usage": {} }
```

```json
{ "ok": false, "error": { "code": "not_room_or_low_quality", "message": "재촬영 안내", "retryable": true } }
```

### 4.4 데이터 저장

- IndexedDB 기반 `localforage` 사용
- 사진 원본은 브라우저 로컬 저장소에 저장
- 촬영 계획, 사진별 AI 검수 결과, 로컬 블록체인 증거 정보를 함께 저장

### 4.5 로컬 블록체인

- 브라우저 내 로컬 데모 체인
- 사진 원본은 체인에 저장하지 않음
- 사진 data URL과 메타데이터를 해시하여 record hash 생성
- record hash들을 순차 연결하여 evidence root 생성
- evidence root를 로컬 블록에 앵커링
- 각 블록은 이전 블록 해시를 포함하여 tamper-evident chain을 구성

## 5. 주요 화면 및 상태

| 상태 | 설명 |
| --- | --- |
| `setup` | 촬영할 공간 종류와 개수를 설정 |
| `hub` | 입주/퇴실 단계별 공간 목록과 완료율 표시 |
| `wizard` | 카메라 촬영, AI 체크포인트, 사진별 검수, 기준 사진 오버레이 |
| `processing` | 로컬 체인 앵커링 처리 중 |
| `report` | 로컬 체인 증거와 검증 상태 표시 |

## 6. 기능 명세

### F-001 공간 구성 설정

사용자는 최초 실행 시 촬영할 공간 종류와 개수를 설정할 수 있다.

#### 입력

- 방 개수
- 화장실 개수
- 부엌 개수
- 거실 개수

#### 처리

- 개수가 0인 공간은 촬영 대상에서 제외한다.
- 동일 공간이 여러 개이면 `방 1`, `방 2`처럼 이름을 구분한다.
- 설정값은 IndexedDB에 저장한다.

#### 출력

- 설정 완료 후 홈 화면으로 이동한다.

### F-002 입주/퇴실 단계 관리

시스템은 `move-in`과 `move-out` 두 촬영 단계를 관리한다.

#### 입주 단계

- 사용자는 각 공간의 전체 샷을 촬영한다.
- AI가 전체 샷 기반 촬영 체크포인트를 생성한다.
- 사용자는 체크포인트별 필요 통과 사진 수를 채운다.
- 모든 공간의 체크포인트가 완료되면 evidence root를 로컬 체인에 앵커링한다.
- 앵커링 후 현재 단계는 퇴실 단계로 전환된다.

#### 퇴실 단계

- 입주 단계에서 생성된 촬영 체크포인트를 기준으로 동일 위치를 다시 촬영한다.
- 입주 기준 사진을 반투명 오버레이로 확인할 수 있다.
- 퇴실 촬영 완료 후 퇴실 사진 세트의 evidence root를 로컬 체인에 앵커링한다.

### F-003 카메라 촬영 위저드

사용자는 각 공간별 촬영 위저드를 통해 체크포인트 단위로 사진을 촬영한다.

#### 주요 UI

- 후면 카메라 프리뷰
- 상단 공간명
- 단계 진행 점 표시
- 실시간 품질 상태 칩
- 촬영 가이드 프레임
- 촬영 지시문
- AI 체크포인트 가로 목록
- 현재 체크포인트 커버리지 상태
- 반드시 포함되어야 할 시야 요소
- 현재 체크포인트에 촬영된 사진 썸네일 목록
- 셔터 버튼
- 마지막 사진 삭제 버튼
- 다음 체크포인트 이동 버튼

#### 촬영 처리

- 카메라 프레임을 canvas에 그린다.
- JPEG data URL로 변환한다.
- 현재 `phase`, `roomId`, `stepId` 기준 사진 배열에 추가 저장한다.
- overview가 아닌 체크포인트 사진은 AI 검수를 요청한다.
- 사진별 AI 검수 결과는 배열로 누적 저장한다.

### F-004 실시간 품질 체크

카메라 프레임을 주기적으로 샘플링하여 촬영 품질을 평가한다.

#### 평가 기준

- 카메라 준비 상태
- 화면 밝기 부족
- 과도한 밝기
- 초점/선명도 부족

#### 출력 메시지 예시

- `카메라 준비 중`
- `조명이 어두워요`
- `빛이 너무 강해요`
- `초점을 맞춰주세요`
- `촬영 준비 완료`

### F-005 AI 동적 촬영 체크포인트 생성

각 공간의 첫 단계는 `전체 샷`이다. 사용자가 전체 샷을 촬영하면 시스템은 Claude에 이미지를 전송하여 공간별 촬영 체크포인트를 생성한다.

#### 입력

- 공간명
- 공간 타입
- 전체 샷 이미지

#### AI 지시 원칙

- 하자 있음/없음을 단정하지 않는다.
- 분쟁 증거로 확인해야 하는 위치를 제안한다.
- 세면대, 싱크대, 변기, 배수구처럼 하부가 중요한 설비는 낮은 각도 촬영을 제안한다.
- 책상 아래, 가구 아래, 창틀 하단처럼 전경에서 보이는 가려진 영역을 반영한다.
- 한 장으로 부족한 설비나 가려진 영역은 `minPhotos`를 2 또는 3으로 올린다.
- `coverageCriteria`에는 사용자가 빠뜨리면 안 되는 시야 요소를 2개에서 4개까지 넣는다.
- 최소 3개, 최대 8개의 체크포인트를 반환한다.

#### Claude 요청 옵션

- `temperature: 0.2`
- `maxTokens: 1800`

#### 서버 표준 출력 형식

```json
{
  "ok": true,
  "data": {
    "summary": "전체 샷에서 확인한 공간 요약",
    "tasks": [
      {
        "id": "desk-under-floor",
        "label": "책상 아래 바닥",
        "guide": "카메라를 낮춰 책상 아래 바닥과 벽 모서리가 함께 보이도록 찍어주세요.",
        "target": "책상 아래",
        "angle": "low",
        "minPhotos": 2,
        "coverageCriteria": ["책상 아래 바닥", "벽과 바닥 경계", "어두운 모서리"]
      }
    ]
  }
}
```

#### 실패 처리

Claude 호출 실패, HTTP 응답 파싱 실패, tool output 누락, 항목 부족, 전체 샷 판별 불가 시 기본 촬영 목록으로 대체하지 않는다.

- 사용자에게 실패 메시지와 소요시간을 표시한다.
- AI 촬영 목록이 생성되지 않으면 다음 단계로 진행할 수 없다.
- 에러 메시지는 서버 표준 envelope의 `error.message`를 우선 표시한다.
- 실내 전체 샷으로 보기 어렵거나 테스트용 무관한 사진이면 재촬영 가능한 오류로 표시한다.
- 사용자는 Cloudflare Pages 환경변수 또는 로컬 `.env`의 `ANTHROPIC_API_KEY` 설정을 확인한 뒤 전체 샷을 다시 촬영해 재시도한다.

### F-006 체크포인트 커버리지 판단

시스템은 사진 개수가 아니라 체크포인트별 커버리지를 기준으로 완료 여부를 판단한다.

#### 입력

- 현재 체크포인트
- 현재 체크포인트에 촬영된 사진 배열
- 사진별 AI 검수 결과 배열
- AI 촬영 계획 존재 여부

#### 상태

| 상태 | 의미 |
| --- | --- |
| `needs-photo` | 아직 촬영된 사진이 없음 |
| `needs-ai` | 전체 샷은 있으나 AI 촬영 계획이 없음 |
| `waiting` | 사진은 있으나 필요 통과 수를 채우지 못함 |
| `retry` | 최근 AI 검수 결과가 재촬영 필요 |
| `complete` | 필요 통과 사진 수를 충족함 |

#### 완료 조건

- `overview`: 전체 샷이 있고 AI 촬영 계획이 생성되어야 완료
- 일반 체크포인트: AI 검수 `pass` 사진 수가 `minPhotos` 이상이어야 완료
- 방 전체: 모든 체크포인트가 `complete` 상태여야 완료
- 전체 점검: 모든 방이 완료되어야 로컬 체인 앵커링 가능

### F-007 AI 증거 사진 검수

사용자가 체크포인트 사진을 촬영하면 시스템은 해당 사진이 증거 사진으로 충분한지 AI에 검수 요청을 보낸다.

#### 입력

- 공간명
- 체크포인트명
- 촬영 지시문
- 필요 통과 사진 수
- coverage criteria
- 촬영 이미지

#### Claude 요청 옵션

- `temperature: 0.1`
- `maxTokens: 500`

#### 검수 기준

- 촬영 대상이 프레임 안에 있는가
- 대상이 너무 가려지지 않았는가
- 위치 맥락이 충분한가
- coverage criteria가 사진에 드러나는가
- 사진이 너무 어둡거나 가까워 증거로 쓰기 어려운가

#### 서버 표준 출력 형식

```json
{
  "ok": true,
  "data": {
    "status": "pass",
    "message": "증거 사진으로 충분합니다.",
    "hint": "필요 시 더 낮은 각도에서 한 장 추가로 촬영하세요."
  }
}
```

#### 처리

- `status`는 `pass` 또는 `retry`만 허용한다.
- 검수 결과는 사진별로 배열에 누적 저장한다.
- 각 검수 결과에는 `photoIndex`를 저장하여 촬영 사진과 매칭한다.
- AI 검수 실패 시 기본 검수 메시지로 대체하지 않고 에러를 표시한다.

### F-008 사진 목록 및 삭제

각 체크포인트는 여러 장의 사진을 가질 수 있다.

#### UI 표시

- 현재 체크포인트에 촬영된 사진을 가로 썸네일 목록으로 표시한다.
- pass 사진은 초록색 테두리로 표시한다.
- retry 사진은 노란색 테두리로 표시한다.
- 아직 검수 결과가 없거나 저장만 된 사진은 회색 계열로 표시한다.

#### 마지막 사진 삭제

- 사용자가 마지막 사진 삭제 버튼을 누르면 현재 체크포인트의 마지막 사진을 제거한다.
- 해당 사진에 대응하는 마지막 AI 검수 결과도 함께 제거한다.
- overview 사진을 삭제하면 해당 공간의 AI 촬영 계획도 삭제한다.

### F-009 입주 기준 사진 오버레이

퇴실 단계에서는 동일 `roomId`와 `stepId`의 입주 사진이 존재할 경우 반투명 오버레이로 표시할 수 있다.

#### 목적

- 입주 당시와 같은 위치, 같은 각도로 촬영하도록 보조한다.
- 원본 사진을 사람이 직접 비교 확인할 수 있게 돕는다.

#### UI

- 기준 사진 보기 버튼
- 오버레이 on/off 토글

### F-010 증거 root 생성

입주 또는 퇴실 촬영 완료 후 시스템은 해당 phase의 사진 세트와 메타데이터를 기반으로 evidence root를 생성한다.

#### 입력

- 입주 사진 데이터
- phase
- roomId
- stepId
- photoIndex
- timestamp
- room metadata

#### 처리

- 각 사진 data URL을 SHA-256으로 해시한다.
- 사진 해시, roomId, stepId, photoIndex, phase, timestamp를 포함한 record hash를 생성한다.
- record hash는 이전 record hash를 포함하여 순차 연결한다.
- 마지막 record hash를 evidence root로 사용한다.

#### 출력

- `rootHash`
- `recordCount`
- `inspectionId`
- `phase`

### F-011 로컬 블록체인 앵커링

시스템은 evidence root를 브라우저 로컬 체인에 앵커링한다.

#### 블록 필드

- `height`
- `timestamp`
- `rootHash`
- `recordCount`
- `inspectionId`
- `phase`
- `previousBlockHash`
- `blockHash`
- `txId`

#### 처리

- 기존 로컬 체인의 마지막 블록 해시를 조회한다.
- 새 블록에 evidence root와 이전 블록 해시를 포함한다.
- 블록 해시와 txId를 생성한다.
- IndexedDB에 블록을 저장한다.

### F-012 증거 검증

보고서 화면에서는 proof의 phase에 해당하는 현재 사진 세트가 기존 evidence root와 일치하는지 검증한다.

#### 검증 항목

- 현재 사진 세트로 evidence root를 재계산한다.
- 저장된 rootHash와 비교한다.
- 로컬 체인의 블록 해시 연결성을 검증한다.
- 앵커링된 blockHash와 proof의 blockHash가 일치하는지 확인한다.

#### 결과

- 검증 성공 시 `검증 완료` 메시지를 표시한다.
- 검증 실패 시 실패 원인을 표시한다.

## 7. 데이터 모델

### 7.1 GuidedCaptureStep

```ts
interface GuidedCaptureStep {
  id: string;
  label: string;
  guide: string;
  target?: string;
  angle?: "wide" | "detail" | "low";
  minPhotos?: number;
  coverageCriteria?: string[];
}
```

### 7.2 CapturePlan

```ts
interface CapturePlan {
  summary: string;
  tasks: GuidedCaptureStep[];
  source: "ai" | "fallback";
  generatedAt: number;
  elapsedMs?: number;
}
```

현재 구현에서는 AI 촬영 계획 실패 시 fallback 계획을 사용하지 않는다. `source: "fallback"`은 기존 저장 데이터와 타입 호환을 위한 값이다.

### 7.3 CaptureReview

```ts
interface CaptureReview {
  status: "pass" | "retry" | "saved";
  message: string;
  hint?: string;
  source: "ai" | "fallback";
  reviewedAt: number;
  elapsedMs?: number;
  photoIndex?: number;
}
```

현재 구현에서는 체크포인트별 리뷰를 `CaptureReview[]`로 저장한다. 기존 단일 `CaptureReview` 데이터도 읽을 수 있도록 정규화한다.

### 7.4 PhotoData

```ts
type PhotoData = Record<string, Record<string, string[]>>;
```

구조:

```text
phase -> roomId -> stepId -> photoDataUrl[]
```

### 7.5 PersistentData

```ts
type PersistentData = {
  photos: Record<InspectionPhase, PhotoData>;
  currentPhase: InspectionPhase;
  roomConfig?: Record<string, number>;
  capturePlans?: Partial<Record<InspectionPhase, Record<string, CapturePlan>>>;
  captureReviews?: Partial<Record<InspectionPhase, Record<string, Record<string, CaptureReview | CaptureReview[]>>>>;
  blockchainProof?: BlockchainProof;
};
```

### 7.6 BlockchainProof

```ts
interface BlockchainProof {
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
```

## 8. 외부 및 로컬 의존성

| 항목 | 용도 |
| --- | --- |
| Bun | 패키지 설치 및 개발 서버 실행 |
| Vite | React 개발 서버 및 proxy |
| React | UI 구현 |
| TypeScript | 정적 타입 검사 |
| localforage | IndexedDB 저장소 |
| Claude API | 비전 모델 추론 |
| claude-sonnet-4-6 | 기본 AI 모델 |
| Cloudflare Tunnel | 모바일 HTTPS 접속 및 카메라 권한 테스트 |
| Web Camera API | 모바일/브라우저 카메라 촬영 |

## 9. 실행 및 테스트

### 9.1 설치

```bash
bun install
```

### 9.2 Claude 준비

```bash
cp .env.example .env
```

로컬에서 AI 기능을 테스트하려면 `.env`에 `ANTHROPIC_API_KEY`를 넣는다. 배포 환경에서는 Cloudflare Pages 프로젝트 환경변수에 같은 키를 등록한다.

### 9.3 개발 서버 실행

```bash
bun run dev -- --host 0.0.0.0 --port 5173
```

로컬 브라우저:

```text
http://localhost:5173
```

### 9.4 모바일 카메라 테스트

HTTP 로컬 IP 접속에서는 모바일 카메라 권한이 제한될 수 있다. 휴대폰 테스트는 HTTPS가 제공되는 Cloudflare Tunnel을 사용한다.

```bash
cloudflared tunnel --url http://localhost:5173
```

터미널에 표시되는 `https://...trycloudflare.com` 주소를 휴대폰에서 접속한다.

### 9.5 정적 검증

```bash
bun run type-check
bun run test -- --run
bun run build
```

## 10. 비기능 요구사항

### 10.1 개인정보

- 사진 원본은 브라우저 로컬 저장소에 저장한다.
- 로컬 블록체인에는 사진 원본을 저장하지 않는다.
- 체인에는 evidence root와 사진 해시 기반 기록만 저장한다.

### 10.2 안정성

- AI 촬영 계획 실패 시 기본 목록으로 자동 대체하지 않는다.
- AI 검수 실패 시 기본 검수 메시지로 자동 대체하지 않는다.
- 실패 원인을 UI에 표시하고 사용자가 재시도할 수 있게 한다.
- Claude 응답은 tool schema 기반 표준 envelope로 변환하여 클라이언트의 raw JSON 파싱 실패를 방지한다.

### 10.3 모바일 접근성

- 모바일 후면 카메라 사용을 기본으로 한다.
- HTTPS 접속이 필요한 환경에서는 Cloudflare Tunnel을 사용한다.
- 촬영 화면은 엄지 조작 가능한 하단 셔터 구조를 사용한다.

### 10.4 성능

- 촬영 품질 검사는 낮은 해상도 canvas 샘플링으로 수행한다.
- AI 요청은 촬영 시점에만 발생한다.
- 촬영 계획 생성은 긴 JSON 출력을 위해 `maxTokens: 1800`을 사용한다.
- 사진 검수는 짧은 JSON 출력을 위해 `maxTokens: 500`을 사용한다.

## 11. 현재 한계

- 로컬 블록체인은 데모 체인이며 public chain에 앵커링하지 않는다.
- AI는 공간 전체를 완전히 이해한다고 보장할 수 없다.
- 시스템의 "완료"는 AI가 생성한 체크포인트 기준 커버리지 완료를 의미한다.
- 가구 뒤, 문 뒤, 카메라 밖 영역처럼 전경에 드러나지 않는 위치는 AI가 누락할 수 있다.
- AI 검수는 법적 보증이 아니라 촬영 충분성에 대한 보조 판단이다.
- 브라우저 로컬 저장소를 삭제하면 사진 및 로컬 체인 데이터도 삭제될 수 있다.

## 12. 데모 시나리오

1. `bun run dev -- --host 0.0.0.0 --port 5173`으로 앱 실행
2. `cloudflared tunnel --url http://localhost:5173`으로 HTTPS 주소 생성
3. 휴대폰에서 Cloudflare Tunnel 주소 접속
4. 공간 구성에서 방/화장실/부엌/거실 개수 설정
5. 입주 단계에서 특정 공간 진입
6. 전체 샷 촬영
7. AI가 공간 전경 기반 체크포인트 생성
8. 체크포인트별 `minPhotos`와 `coverageCriteria` 확인
9. 각 체크포인트에서 사진 촬영
10. AI 검수 결과 pass/retry 확인
11. 필요한 pass 수를 채울 때까지 추가 촬영
12. 모든 방 완료 후 evidence root를 로컬 체인에 앵커링
13. 보고서에서 root hash, txId, block hash, 검증 상태 확인
14. 퇴실 단계에서 입주 기준 사진 오버레이를 참고해 동일 체크포인트 재촬영
15. 퇴실 사진 세트의 evidence root를 로컬 체인에 앵커링

## 13. 향후 확장

- 방 종료 전 전체 샷과 촬영 사진 목록을 다시 검토하는 "누락 가능 영역 감사" 기능
- 사용자가 직접 체크포인트 추가
- 체크포인트별 `해당 없음`, `가려져서 촬영 불가`, `다른 사진에 포함됨` 상태 기록
- 촬영 불가 사유도 evidence root 메타데이터에 포함
- public testnet 또는 timestamping service 앵커링
- 입주/퇴실 원본 사진을 나란히 검토하는 수동 비교 UI
- AI 응답 원문과 파싱 결과를 개발자 모드에서 확인하는 디버그 패널
