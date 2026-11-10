# Docker 배포 · Space Cycle

## 배포 구성

- 서버: `nori-dev`, 배포 디렉터리: `/home/nori/services/space-cycle`
- Compose 프로젝트/서비스: `space-cycle`
- 앱 내부 포트: `4500`
- 서버 게시 주소: **`http://127.0.0.1:4500`** (서버 내부에서만 접근)
- 외부 접속 계획: **`https://spacecycle.space` → Cloudflare Tunnel → 서버 127.0.0.1:4500**
- Google 로그인은 기존 Firebase Authentication 사용. 고유 완료 기록은 **SQLite named volume `space-cycle_visits-data`**에 보존하며 `/app/data/visits.sqlite`를 사용.

`127.0.0.1` 바인딩은 의도적인 설정이다. 서버의 LAN/Tailscale IP에 `:4500`을 붙여도 직접 접속되지 않는다. 공유기 포트포워딩이나 방화벽의 공개 4500 허용은 필요하지 않다. Tunnel 설정 전에는 외부 HTTPS 사이트가 동작한다고 간주하지 않는다.

## 로컬 개발과 테스트

Node.js 24.19 이상과 npm이 필요하다. 서버 이미지에는 Node 24의 `node:sqlite`가 포함된다.

```bash
npm ci
npm test
npm start
```

`npm test`는 프로세스/페이지 HTTP, QR 정책/카메라 수명, GPS 반경·연속 체류, 서명 토큰 검증, 계정 분리·중복 방지·SQLite 재시작 보존 및 배포 구성 검사를 수행한다. 테스트용 서명키/가상 계정을 사용하며 실제 Google 계정 로그인·물리 카메라·현장 GPS를 대신하지 않는다. 개발용 기록은 Git에서 제외한 `data/`에 저장하고 테스트는 별도 임시 DB를 사용한다.

## 최초 서버 배포

아래 경로가 이미 존재하면 먼저 저장소 remote와 작업 상태를 확인한다. 다른 파일을 덮어쓰지 않는다.

```bash
mkdir -p ~/services
git clone https://github.com/MirDraco/space-cycle.git ~/services/space-cycle
cd ~/services/space-cycle
git pull --ff-only origin main
export IMAGE_TAG=$(git rev-parse --short=12 HEAD)
docker compose config --quiet
docker compose build --pull
docker compose up -d --wait --wait-timeout 120
```

## 정상 동작 확인

```bash
cd ~/services/space-cycle
export IMAGE_TAG=$(git rev-parse --short=12 HEAD)
docker compose ps
curl --fail http://127.0.0.1:4500/healthz
curl --fail -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4500/
curl --fail -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4500/spaces
docker compose logs --tail=50
```

`/healthz`는 `{ "status": "ok" }`를 반환하는 프로세스 건강 확인이다. Firebase·외부 서비스까지 정상이라는 뜻은 아니다.

## 이후 업데이트

로컬에서 변경 검증 후 commit/push하고 서버에서 아래를 실행한다.

```bash
cd ~/services/space-cycle
git status --short
# 위 결과가 비어 있을 때만 이어서 진행한다.
git pull --ff-only origin main
export IMAGE_TAG=$(git rev-parse --short=12 HEAD)
docker compose build --pull
docker compose up -d --wait --wait-timeout 120
curl --fail http://127.0.0.1:4500/healthz
docker compose ps
```

소스 파일이 이미지에 포함되므로 `git pull`만으로 실행 중인 앱은 바뀌지 않는다. 이미지 재빌드와 서비스 교체가 필요하다. 빌드 실패 시 기존 컨테이너는 계속 실행되므로 `down`부터 실행하지 않는다. 다른 Compose 프로젝트의 컨테이너·네트워크는 변경하지 않는다.

## 되돌리기

각 이미지는 Git 커밋의 12자리 값으로 태그된다. 기존 이미지가 남아 있으면 알려진 정상 태그를 지정해서 서비스만 교체할 수 있다.

```bash
cd ~/services/space-cycle
# <정상 커밋 태그>를 실제 남아 있는 이미지 태그로 바꾼다.
IMAGE_TAG=<정상 커밋 태그> docker compose up -d --no-build --wait --wait-timeout 120
```

이미지가 존재하는지 먼저 `docker image ls space-cycle`로 확인한다. `docker system prune` 등 다른 프로젝트에 영향을 주는 정리는 하지 않는다.

## Cloudflare Tunnel 연결 — 사용자가 진행할 부분

이 배포에는 `cloudflared` 설치나 Tunnel/DNS 변경을 포함하지 않는다.

1. Cloudflare 대시보드의 **Networking → Tunnels**에서 Tunnel을 생성한다. 화면에 따라 Cloudflare One의 Networks/Connectors 메뉴에 있을 수 있다.
2. 커넥터는 **같은 nori-dev 호스트에 실행하는 Linux 서비스 방식**을 선택한다. 대시보드가 표시하는 공식 설치·실행 명령을 서버에 입력한다. 자동 시작 서비스로 설치하고 Connected/Healthy 상태를 확인한다.
3. Published application route / Public hostname을 아래와 같이 추가한다.

   | 항목 | 값 |
   |---|---|
   | Subdomain | 비워 둠 (루트 도메인) |
   | Domain | `spacecycle.space` |
   | Path | 비워 둠 |
   | Type | `HTTP` |
   | URL | `127.0.0.1:4500` |

4. 같은 이름의 기존 DNS 레코드가 있다면 충돌을 먼저 확인한다. 관련 없는 DNS 레코드를 삭제하지 않는다. 앱 포트로 A 레코드/공유기 포트포워딩을 별도로 만들지 않는다.
5. 브라우저의 `https://spacecycle.space`, `/spaces`, `/healthz`를 확인하고 휴대폰 LTE/5G로 재확인한다. 외부는 HTTPS, 같은 서버의 Tunnel→앱 구간은 HTTP다.
6. Firebase Authentication 설정의 **Authorized domains**에 `spacecycle.space`를 추가한 뒤 실제 휴대폰 Google 로그인/로그아웃을 확인한다. 이 작업만으로 기존 `authDomain`을 새 도메인으로 바꾸지 않는다.

### Tunnel 커넥터를 Docker로 만들고 싶다면

기본 브리지 네트워크 컨테이너에서 `127.0.0.1`은 호스트가 아니라 **그 컨테이너 자신**이다. 따라서 위의 호스트 서비스용 주소를 그대로 쓰면 연결되지 않는다. 대신 Linux 호스트 네트워크 방식으로 커넥터를 실행하거나, 앱과 같은 Compose 네트워크에 붙여 **`http://space-cycle:4500`**으로 연결하는 별도 구성이 필요하다. 현재 안내는 혼동을 줄이기 위해 **호스트 서비스 방식**을 기준으로 한다.

### 비밀정보와 운영 주의

- Tunnel 토큰·비밀번호·Firebase 서비스 계정 JSON은 채팅/Git/이미지에 넣지 않는다. 필요하면 서버 전용 보호 파일로 관리한다.
- 브라우저용 Firebase 설정은 이미 공개 클라이언트 코드이며 서버 관리자 자격증명과 다르다. 데이터 보호는 적절한 Firebase Security Rules로 검증해야 한다.
- 앱은 non-root 사용자, 읽기 전용 root filesystem, 최소 권한으로 실행한다. 로그 용량과 메모리/CPU에 제한을 둔다.
- Docker 기본 이미지는 digest로 고정했다. 보안 업데이트 때 확인한 새 digest로 갱신·테스트·재배포한다.
- TLS 연결 성공과 Google 인증 성공, QR/GPS/체류/보상 기능 구현은 별개다. 내부 공간 01(향설생활관2)의 QR·100m·1분 체류 완료를 로그인 계정별 SQLite 기록으로 저장하며 같은 공간은 한 번만 센다. 뱃지/스티커 보상·Firestore 저장은 미구현이다. 모바일 카메라·위치 권한은 HTTPS에서 확인한다. 개발용 localhost는 예외다.
- Docker 이미지에 `server/`, `public/js/space-data.js`, `views/visit.html` 및 위치 화면 스크립트가 모두 포함되어야 한다. 짧은 QR `/s/in01`은 `/visit?space=indoor-01`로 302 이동한다. `/s/in02`~`in05`, `/s/out01`~`out05`는 등록 예정 공간 정보로 이동한다. 새 소스가 자동으로 운영에 반영되는 것은 아니다.
- 진행 중 체류 API는 **단일 Node 프로세스 메모리**를 사용한다. 세션 최대 500개, 생성 후 10분 만료, 진행 중 시간은 재시작 시 초기화된다. 완료 기록은 named volume으로 보존한다. 다중 replica/worker에는 공유 세션·저장 설계가 필요하다. 실제 보상/행사 운영 전 요청 제한·백업·계정 탈퇴·강제 철회 검증을 추가한다. 위치 요청 본문/Authorization 헤더를 프록시·디버그 로그에 저장하지 않는다.
- 배포 후 `/s/in01` 연결과 iOS Safari/Android Chrome에서 위치 허용·거부, 반경 이탈, 정확도 부족, 화면 잠금·백그라운드, 오프라인, 새로고침, 1분 완료를 확인한다. 실내 위치 정확도 부족은 완료되지 않아야 하며 반경을 자동으로 넓히지 않는다.

## 로그인과 완료 기록 운영

- Firebase Authentication → Settings → Authorized domains에서 `spacecycle.space`가 있는지 확인한다. Google 제공자도 활성화되어 있어야 한다. `auth/unauthorized-domain`은 누락된 도메인, `auth/popup-blocked`는 팝업 차단이다. `authDomain`을 임의로 운영 도메인으로 바꾸면 안 된다.
- 서버는 Google securetoken 공개 JWKS에 HTTPS 접근해야 한다. 별도 서비스 계정·개인키·Firebase 관리자 토큰을 Git이나 이미지에 넣지 않는다. Google ID 토큰은 매 요청 검증하고 uid는 검증 결과만 사용한다.
- Compose volume `visits-data:/app/data`, `SPACE_CYCLE_DB=/app/data/visits.sqlite`, container user `node`를 유지한다. 루트 파일시스템은 읽기 전용이고 DB 디렉터리만 쓰기 가능하다. 이미지가 만든 node 소유 디렉터리는 새 named volume에 복사된다. 기존 볼륨 권한 오류가 있으면 원인을 확인하고 DB를 삭제해 해결하지 않는다.
- **`docker compose down -v`, 볼륨 prune/삭제 금지.** 재빌드/up/일반 restart는 기록을 유지한다. 백업은 SQLite backup API로 일관된 사본을 만든 뒤 별도 보관하며, 실행 중 DB 파일 하나만 복사하면 WAL 기록을 놓칠 수 있다. 백업·탈퇴 삭제 요청은 계정 ID가 포함된 개인정보로 취급한다.
- 홈 숫자는 기존 Firestore `foundSpaceCount`가 아닌 서버의 검증된 고유 완료 행을 읽는다. 과거 테스트는 저장 기능이 없었으므로 소급 집계하지 않는다. Google 로그인 후 향설생활관2를 한 번 완료하면 1, 다시 완료해도 1이어야 한다.

## 공식 문서

- https://docs.docker.com/guides/nodejs/containerize/
- https://docs.docker.com/compose/compose-file/05-services/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/
- https://firebase.google.com/docs/auth/web/redirect-best-practices
