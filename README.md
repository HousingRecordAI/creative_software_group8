# House Record

입주/퇴실 사진을 기록하고 로컬 Ollama 비전 모델로 하자와 변경점을 분석하는 Vite 앱입니다.

## 로컬 실행

```bash
bun install
bun run dev
```

기본 개발 서버는 로컬 Ollama API(`http://localhost:11434`)로 프록시합니다. Podman 같은 컨테이너 안에서 Vite를 실행해야 한다면 `.env`를 만들고 호스트만 바꾸면 됩니다.

```bash
cp .env.example .env
```

예시:

```env
VITE_OLLAMA_HOST=http://host.containers.internal:11434
VITE_OLLAMA_MODEL=gemma4:e4b
```

## Ollama 준비

앱의 기본 모델은 `gemma4:e4b`입니다. 다른 비전 모델을 쓰려면 `.env`의 `VITE_OLLAMA_MODEL`을 바꾸세요.

```bash
ollama list
ollama pull gemma4:e4b
```

## 데모 흐름

1. 공간별 첫 단계에서 전체 샷을 촬영합니다.
2. Ollama가 전체 샷을 보고 세면대 하부, 배수구, 창틀처럼 빠지기 쉬운 추가 촬영 목록을 생성합니다.
3. 사용자는 AI가 만든 촬영 목록을 따라 사진을 찍습니다.
4. 각 사진은 증거 사진으로 충분한지 AI 검수를 받습니다.
5. 입주 촬영을 끝내면 사진 원본이 아니라 사진 해시와 메타데이터로 만든 evidence root를 로컬 블록체인에 고정합니다.
6. 보고서 화면에서 현재 사진 세트로 root를 다시 계산해 로컬 체인의 앵커와 일치하는지 검증합니다.

로컬 블록체인은 발표 안정성을 위한 브라우저 내 데모 체인입니다. 각 블록은 이전 블록 해시를 포함하고, 사진 하나나 메타데이터가 바뀌면 evidence root가 달라져 검증이 실패합니다.
