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
