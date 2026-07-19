# push-and-pull-office

## 스토리 상태 에디터

YAML을 빌드한 뒤 수치에 따른 표정, 대사, 선택지와 분기를 브라우저에서 확인합니다.

```bash
make story-editor
```

브라우저가 자동으로 열리지 않으면 `http://127.0.0.1:8765/editor/`에 접속합니다.

## Tauri 제작 에디터

루트·장면·노드를 탐색하고, 이중 대사와 조건·효과를 GUI로 수정한 뒤 전체 검증을 통과한 YAML만 안전하게 저장합니다.

```bash
make editor-setup
make tauri-dev
```

첫 설정은 프로젝트 내부 `.tooling/`에 Rust를 설치하고 `.venv/`와 npm 패키지를 준비합니다. 시스템의 다른 Rust·Python 프로젝트 설정은 바꾸지 않습니다.

주요 기능:

- 6종 노드의 구조화된 편집
- `인물 / 수치 / 비교 / 값` 형태의 조건 빌더
- 선택지 효과와 상태 계약 자동 계산
- 본편·실제 원문 라이브 미리보기
- Undo/Redo와 미저장 초안 복구
- 외부 파일 변경 충돌 감지
- 주석과 키 순서를 보존하는 원자적 YAML 저장

macOS 앱 빌드:

```bash
make tauri-build
```

완성된 앱은 `src-tauri/target/release/bundle/macos/밀당 오피스 스토리 에디터.app`에 생성됩니다.

Tauri 기반 제작 에디터의 화면, 편집 흐름, 저장·검증 구조와 구현 단계는
[`docs/tauri-story-editor-design.md`](docs/tauri-story-editor-design.md)에 정리되어 있습니다.
