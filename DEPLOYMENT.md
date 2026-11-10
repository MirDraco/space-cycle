# Docker 배포 · Space Cycle

## 운영 구성

- 저장소: `MirDraco/space-cycle`, 브랜치 `main`.
- 서버: `nori@nori-dev`, `/home/nori/services/space-cycle`. SSH 접속 때 호스트·사용자를 확인합니다.
- Compose 프로젝트/서비스 `space-cycle`, 앱4500 → **`127.0.0.1:4500`만 게시**.
- 공개 HTTPS: `https://spacecycle.space` → 호스트 Cloudflare Tunnel → loopback4500.
- Node 24, non-root `node`, read-only root filesystem, CPU1개·메모리256MiB·PID100 제한.
- 진행·완료 DB: named volume `space-cycle_visits-data`, `/app/data/visits.sqlite`, 파일 권한600.
- **`docker compose down -v`, volume prune/삭제 금지.** 관련 없는 컨테이너나 Tunnel/DNS를 바꾸지 않습니다.

## 로컬 실행

```bash
npm ci
npm test
npm start
```

자동 검사는 격리 DB/합성 계정·센서를 사용합니다. 실제 Google 개인 로그인·물리 GPS·카메라를 대신하지 않습니다. 개발용 `data/`는 Git/이미지/정적 파일 경로에서 제외합니다.

## 시작·종료 모델 운영

1. 시작 위치·정확도를 서버에서 확인하고 계정·공간별 진행을 SQLite에 저장합니다.
2. 서버 공간 설정의 필요 시간이 경과할 때까지 대기합니다. **대기 중 주기적 GPS·HTTP polling·사용자별 서버 타이머가 없습니다.**
3. 사용자가 마지막 확인 버튼을 누르면 새 위치와 서버 시간을 확인합니다.
4. 고유 완료 기록과 진행 완료 상태를 하나의 트랜잭션으로 저장합니다.

- **중간에 계속 현장에 있었음을 검증하지 않습니다.** QR/GPS 조작을 완전히 막는 출석·보상 인증이 아닙니다.
- 마지막 위치·통신·저장 실패는 기다린 시간을 지우지 않습니다. 최종 확인 재시도 가능, 완료/카운트는 서버 저장 성공 후만 표시합니다.
- 새로고침·잠금·백그라운드·오프라인 후 같은 계정으로 복구합니다. 복구는 위치 권한을 요청하지 않습니다. 명시적 취소·시작 후2시간 만료만 진행을 종료합니다.
- 위치는 1회 최대15초, 작업 전체30초 예산이며 timestamp·정확도 조건은 유지합니다. `watchPosition`으로 바꾼 것이 아닙니다.
- **이전25초 위치 연속성 기한은 없습니다.** Compose의 `SPACE_CYCLE_LOCATION_TIMEOUT_MS`, `SPACE_CYCLE_MAX_GAP_MS`, `SPACE_CYCLE_NETWORK_RESERVE_MS` 설정은 제거했습니다. 연속성 store/policy 유틸리티가 남더라도 공개 API에서는 연결하지 않습니다.
- 시작 시각·필요 시간·준비 시각·만료 시각은 서버에서만 결정합니다. 재시작 복구를 위해 영구 서버 시각을 사용하므로 호스트 NTP/시각 변경을 관리합니다.
- 미완료(active) 진행은 계정·공간별 하나·최대10,000개이며 완료 상태 진행은 한도에서 제외하고 유효기간 만료 시 정리합니다. 계정별 stays API분당60회 제한. 제한기는 프로세스 내 상태이므로 재시작 시 초기화되며 복수 replica의 전역 제한은 아닙니다. 단일 프로세스/SQLite 구성을 유지합니다. 수용 인원은 부하 시험 범위 밖으로 보장하지 않습니다.
- 원본 GPS·토큰·이메일은 DB/앱 로그에 저장하지 않습니다. API 요청 본문·Authorization을 프록시 디버그 로그로 추가 기록하지 않습니다. 백업에는 계정 식별자가 포함되므로 개인정보로 보호합니다.
- 시작마다 브라우저가 보안 난수48자리 `attemptId`를 생성합니다. 미확인 시작의 취소는 `/api/stays/abandon`에서 취소 의도를 먼저 영구 저장한 뒤204로 승인합니다. 지연된 원래 시작은409 `start_cancelled`이며, idle 복구가 시작을 추월했다고 취소 성공으로 표시하지 않습니다. 이 표는 UID·시도ID·장소·진행ID매핑·취소여부·만료시각만 저장하고 최대10,000행·2시간 유효기간으로 제한합니다. 기존 취소 의도는 capacity 때문에 조기 축출하지 않습니다. `attemptId` 없는4필드 시작은 호환용이며 현재 브라우저는 사용하지 않습니다.

## 배포 전

1. 로컬/원격 main SHA·작업 트리·remote 확인. 대상 외 변경이 있으면 덮어쓰지 않습니다.
2. 전체 테스트·프로덕션 의존성 audit·정적 보안 검사·독립 리뷰 통과.
3. 서버 디스크·현재 컨테이너·이웃 서비스 상태·named volume 확인.
4. **SQLite backup API로 일관된 배포 전 백업**을 만듭니다. 실행 중 `.sqlite` 파일 하나만 복사하면 WAL을 놓칠 수 있습니다.
5. 기존 완료 행을 보존하는 추가 테이블 마이그레이션인지, 격리 DB로 구버전→신버전·재시작·중복 방지를 검증합니다.
6. 운영 DB에 합성 완료 기록을 삽입하지 않습니다. 컨테이너/볼륨 검증은 별도 probe DB 파일만 사용합니다.

## 업데이트

```bash
cd ~/services/space-cycle
hostname
id -un
git status --short
# 예상 호스트·사용자이고 작업 트리가 깨끗할 때만 진행
git pull --ff-only origin main
export IMAGE_TAG=$(git rev-parse --short=12 HEAD)
docker compose config --quiet
docker compose build --pull
docker compose up -d --no-build --wait --wait-timeout 120 space-cycle
curl --fail http://127.0.0.1:4500/healthz
docker compose ps
```

이미지 태그는 정확한 커밋의12자리입니다. pull만으로 실행 앱은 바뀌지 않습니다. **빌드 전에 기존 앱을 down하지 않습니다.** 빌드·검증 실패 시 기존 컨테이너를 유지합니다. Docker context는 allowlist, 기본 이미지는 digest고정, npm production clean install, 새로운 server파일도 패키징해야 합니다.

## 배포 후 검증

- 로컬·GitHub·서버 HEAD/추적 파일, 실행 이미지 runtime 파일, 공개 응답을 각각 비교합니다.
- 컨테이너 healthy·non-root·read-only·loopback4500·동일 named volume·DB권한600을 확인합니다. 다른 서비스의 ID/시작 시각/상태가 바뀌면 조사합니다.
- 기존 `visits` 행과 최초 완료 시각이 모두 보존됐는지 확인합니다. 새 진행 표와 인덱스만 추가합니다. DB quick_check 확인.
- `/`, `/spaces`, `/qr`, `/visit?space=indoor-01`, `/badges`, `/login`, `/healthz`와 자산이 정상이어야 합니다.
- `/.env`, `/.git/config`, `/server/*`, `/data/visits.sqlite`, WAL/SHM, `/compose.yaml`은 공개되지 않아야 합니다.
- `/api/me/spaces`와 stays 시작/복구/완료는 인증 없이401. 본문·Origin·계정 소유권 검사 유지. 구 `/sample`은 방문을 승인할 수 없어야 합니다.
- 인쇄 QR `/s/in01`은 같은 위치 화면으로302. 다른9곳은 준비 중 정보 화면입니다. 인쇄물을 다시 만들 필요는 없습니다.
- 공개 하단 버전과 `X-SpaceCycle-Release`·`?v=` 해시를 확인합니다. 구버전 페이지를 열어둔 사용자는 새로고침해야 합니다.
- `/healthz`는 프로세스 확인일 뿐, Firebase·휴대폰GPS·최종 완료까지 보장하지 않습니다.

## 롤백

```bash
cd ~/services/space-cycle
# docker image ls space-cycle로 남아 있는 정상 태그를 먼저 확인
IMAGE_TAG=<알려진-정상-태그> docker compose up -d --no-build --wait --wait-timeout 120 space-cycle
```

이번 스키마는 기존 `visits`를 지우지 않고 진행 표를 추가합니다. 구버전은 추가 표를 사용하지 않으므로 완료 기록은 보존되지만 **구버전 연속 GPS 흐름은 새 진행을 복구하지 않습니다.** 롤백 후 미완료 진행 처리 정책은 별도 안내해야 합니다. 운영 중 생성된 기록을 잃을 수 있으므로 오래된 DB 백업을 무조건 덮어쓰지 않습니다. 필요한 복구는 앱 정지·현재 DB보존·차이 검토 후 별도로 수행합니다. `docker system prune`은 사용하지 않습니다.

## 인증·캐시·통신

- Firebase Authentication Authorized domains에 `spacecycle.space`, Google 제공자 활성화. 기존 `space-cycle-1b705.firebaseapp.com` authDomain을 유지합니다.
- Firebase 공개 웹 설정은 관리자 비밀키가 아닙니다. 서비스계정/비밀키·Tunnel토큰은 Git/이미지/채팅에 넣지 않습니다.
- Google securetoken 공개 JWKS 접근이 필요합니다. 토큰 서명·만료는 매 요청 검증하지만 계정 강제 철회 조회는 별도입니다.
- 같은 사이트 보안 쿠키는 `credentials: same-origin`, 인증은 Bearer입니다. 명시적 JSON401만 토큰 갱신1회. 불명확한 네트워크 실패 때 임의 POST를 무조건 반복하지 말고 복구로 상태를 조회합니다.
- CSS는 고정 allowlist 파일을 HTML에 포함하고 JS는 내용 해시 버전, HTML/JS/CSS는no-store. Cloudflare Analytics의 실제 관측된 삽입 스크립트만 검증 비교 시 정규화합니다.
- 오류는 로그인·보안 HTML응답·GPS·통신·저장·요청제한으로 구분합니다. 사용자에게 토큰·정확한 위치 기록을 요구하지 않습니다.

## Cloudflare Tunnel 유지

기존 호스트 cloudflared → `127.0.0.1:4500` 경로를 유지하며 공개4500이나 공유기 포트포워딩은 열지 않습니다. Docker bridge의 `127.0.0.1`은 컨테이너 자신이므로, 추후 컨테이너형 Tunnel로 바꾸려면 같은 네트워크의 `http://space-cycle:4500` 등 별도 설계가 필요합니다. 이번 릴리스에는 Tunnel/DNS/인증 도메인 변경이 없습니다.

## 현장 확인 범위

물리 Android Chrome/iOS Safari에서 위치 허용·거부, 실내 정확도 부족, 시작 후 화면 잠금·다른 화면·새로고침 복구, 지정 시간 경과, 마지막 위치 실패 후 재시도, 완료 후 중복 없는 개수를 확인해야 합니다. 합성 센서 브라우저와 실제 대기/API/서명/SQLite 검사는 **위치 공급원의 실제 신뢰성 시험이 아닙니다.** 시작·종료 모델이 GPS불량 자체를 고친다고 설명하지 않습니다.
