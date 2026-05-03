# House Record

입주/퇴실 사진을 기록하고 Claude 비전 모델로 촬영 계획과 사진 충분성을 검수하는 Vite 앱입니다.

## 로컬 실행

```bash
bun install
bun run dev
```

Claude API 키는 브라우저에 노출하지 않습니다. 배포 환경에서는 Cloudflare Pages의 프로젝트 환경변수에 `ANTHROPIC_API_KEY`를 등록하세요. 로컬에서 `bun run dev`로 AI 기능까지 테스트하려면 `.env`를 만들고 서버 전용 키를 넣습니다.

```bash
cp .env.example .env
```

예시:

```env
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-6
```

## Claude 준비

Cloudflare Pages에 배포된 앱은 같은 도메인의 `/api/ai/generate` Pages Function을 통해 Claude에 요청합니다. 로컬 개발 서버에서도 동일 경로가 Vite dev middleware로 동작합니다.

AI 응답은 Claude tool schema로 구조화됩니다. 브라우저는 자유 텍스트 JSON을 직접 파싱하지 않고, 서버가 반환하는 `{ ok, data, error }` 표준 응답만 처리합니다.

## 데모 흐름

1. 공간별 첫 단계에서 전체 샷을 촬영합니다.
2. Claude가 전체 샷을 보고 세면대 하부, 배수구, 창틀처럼 빠지기 쉬운 추가 촬영 목록을 생성합니다.
3. 사용자는 AI가 만든 촬영 목록을 따라 사진을 찍습니다.
4. 각 사진은 증거 사진으로 충분한지 AI 검수를 받습니다.
5. 입주 촬영을 끝내면 원본 사진은 로컬에 보관하고, 사진 해시와 메타데이터로 만든 evidence root를 로컬 블록체인에 고정합니다.
6. 보고서 화면에서 현재 사진 세트로 root를 다시 계산해 로컬 체인의 앵커와 일치하는지 검증합니다.

로컬 블록체인은 발표 안정성을 위한 브라우저 내 데모 체인입니다. 각 블록은 이전 블록 해시를 포함하고, 사진 하나나 메타데이터가 바뀌면 evidence root가 달라져 검증이 실패합니다.
