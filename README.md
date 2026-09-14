# Space Cycle

캠퍼스의 잘 안 쓰이는 공간을 활성화하기 위한 위치 기반 체크인 웹앱 프로토타입.

학생이 공간에 가서 QR코드를 스캔하고 정해진 시간 이상 머무르면 스탬프를 얻습니다.

---

## 1. 준비물

- **Node.js 24 이상** — https://nodejs.org 에서 LTS 버전 설치
  (24 미만이면 `node:sqlite` 모듈이 없어서 실행되지 않습니다)

터미널에서 확인:

```bash
node -v
```

---

## 2. 로컬에서 실행하기

프로젝트 폴더에서 아래 두 줄을 차례로 실행합니다.

```bash
npm install
npm start
```

브라우저에서 http://localhost:3000 을 엽니다.

끌 때는 터미널에서 `Ctrl + C` 를 누릅니다.

### 포트가 이미 쓰이고 있다는 에러가 날 때

```
Error: listen EADDRINUSE: address already in use :::3000
```

이전에 켠 서버가 아직 살아있는 것입니다. 아래 명령으로 정리합니다.

```bash
lsof -ti tcp:3000 | xargs kill
```

다른 포트로 켜도 됩니다.

```bash
PORT=3001 npm start
```

---

## 3. Docker로 실행하기

Docker Desktop이 설치되어 있어야 합니다.

```bash
docker compose up -d
```

- `-d` 는 백그라운드 실행을 뜻합니다.
- `restart: unless-stopped` 설정이 있어서 서버가 껐다 켜져도 자동으로 다시 뜹니다.

| 하고 싶은 일 | 명령어 |
|---|---|
| 로그 보기 | `docker compose logs -f` |
| 끄기 | `docker compose down` |
| 코드 고친 뒤 다시 올리기 | `docker compose up -d --build` |

DB 파일은 `data/` 폴더에 저장되므로 컨테이너를 지워도 기록은 남습니다.

---

## 4. 공간 추가·수정하기

공간 정보는 **`spaces.json`** 파일 하나에만 있습니다. 이 파일만 고치면 됩니다.

```json
{
  "id": "A07",
  "name": "도서관 앞 광장",
  "requiredMinutes": 5,
  "lat": 36.7678,
  "lng": 126.9334,
  "radius": 100
}
```

| 항목 | 뜻 |
|---|---|
| `id` | 공간 번호. QR코드에 담기는 값이라 겹치면 안 됩니다 |
| `name` | 화면에 보이는 이름 |
| `requiredMinutes` | 스탬프를 받기 위해 머물러야 하는 시간(분) |
| `lat` | 위도 |
| `lng` | 경도 |
| `radius` | 이 좌표에서 몇 미터 안에 있어야 체크인이 되는지 |

### 좌표(lat, lng) 구하는 법

구글 지도에서 원하는 위치를 **우클릭**(휴대폰은 길게 누르기)하면 맨 위에
`36.7678, 126.9334` 같은 숫자가 뜹니다. 앞이 `lat`, 뒤가 `lng` 입니다.

### radius는 얼마로 할까?

GPS는 오차가 있습니다. 야외는 50m, 실내는 100m 정도가 무난합니다.
테스트했는데 자꾸 "범위 밖"이라고 나오면 숫자를 늘려보세요.

### 고친 뒤에는 반드시 서버를 다시 켜야 합니다

`spaces.json`은 서버가 켜질 때 한 번만 읽습니다.

- 로컬: `Ctrl + C` 로 끄고 `npm start`
- Docker: `docker compose restart`

### JSON 문법 주의

- 숫자에는 따옴표를 붙이지 않습니다 → `"lat": 36.7678` (O) / `"lat": "36.7678"` (X)
- 항목 사이에는 쉼표를 넣되, 마지막 항목 뒤에는 넣지 않습니다

---

## 5. QR코드 만들기 / 인쇄하기

서버를 켠 뒤 http://localhost:3000/qr.html 을 엽니다.

`spaces.json`에 있는 공간의 QR코드가 모두 자동으로 만들어집니다.
"인쇄하기" 버튼을 누르면 바로 출력하거나 PDF로 저장할 수 있습니다.

QR코드 안에는 공간 id 문자열만 들어 있습니다 (예: `A01`).

---

## 6. 휴대폰에서 테스트하기

카메라와 GPS는 보안 때문에 **HTTPS 또는 localhost 에서만** 동작합니다.
휴대폰에서 `http://192.168.x.x:3000` 처럼 접속하면 카메라가 켜지지 않습니다.

방법 두 가지:

1. **도메인 + HTTPS** — 서버를 배포하고 Caddy나 Nginx 같은 도구로 HTTPS를 붙입니다.
2. **ngrok** — 개발 중 임시로 외부 주소를 만들어 줍니다.

```bash
ngrok http 3000
```

출력된 `https://...` 주소로 휴대폰에서 접속하면 됩니다.

---

## 7. 데이터 확인하기

기록은 `data/spacecycle.db` 파일 하나에 저장됩니다.

```bash
# 전체 기록 보기
sqlite3 -header -column data/spacecycle.db "SELECT * FROM checkins;"

# 시각을 사람이 읽을 수 있게 보기
sqlite3 -header -column data/spacecycle.db \
  "SELECT id, student_id, space_id,
          datetime(started_at/1000,'unixepoch','localtime') AS 시작,
          success
   FROM checkins;"
```

화면으로 보고 싶다면 [DB Browser for SQLite](https://sqlitebrowser.org) 를 설치해
`data/spacecycle.db` 파일을 열면 됩니다.

### 테이블 구조

| 칸 | 뜻 |
|---|---|
| `id` | 자동으로 붙는 번호 |
| `student_id` | 학번 |
| `space_id` | 공간 id |
| `started_at` | 체크인한 시각 (서버 기준) |
| `completed_at` | 완료한 시각 (완료 안 했으면 비어 있음) |
| `success` | 성공이면 1, 아니면 0 |

**실패한 기록도 지우지 마세요.** 나중에 "몇 명이 체크인했다가 중간에 포기했는지"를
보려면 필요한 데이터입니다.

### 테스트할 때 시간 기다리기 귀찮다면

시작 시각을 과거로 당기면 바로 완료할 수 있습니다.

```bash
# id가 1인 기록의 시작 시각을 10분 전으로 당기기
sqlite3 data/spacecycle.db \
  "UPDATE checkins SET started_at = started_at - 600000 WHERE id = 1;"
```

`600000`은 10분을 밀리초로 바꾼 값입니다 (10 × 60 × 1000).

---

## 8. 백업

DB는 파일 하나이므로 그 파일만 복사하면 백업이 끝납니다.

```bash
cp data/spacecycle.db data/backup-$(date +%Y%m%d).db
```

---

## 파일 구조

```
spacecycle/
├─ server.js            서버 (Express + SQLite)
├─ spaces.json          공간 목록 ← 주로 고칠 파일
├─ public/
│  ├─ index.html        화면 4개
│  ├─ style.css         디자인
│  ├─ app.js            화면 동작
│  └─ qr.html           QR 인쇄용 페이지
├─ data/spacecycle.db   기록 (자동 생성)
├─ Dockerfile
└─ docker-compose.yml
```

---

## 동작 방식 메모

- **시간 판정은 서버가 합니다.** 화면의 타이머 숫자는 보여주기용일 뿐입니다.
  완료 버튼을 누르면 서버가 `현재 시각 - 저장된 시작 시각` 을 계산해서 판정합니다.
  그래서 화면을 꺼도, 앱을 껐다 켜도 시간은 그대로 흘러갑니다.
- **위치 확인은 브라우저가 합니다.** GPS로 받은 좌표와 공간 좌표 사이의 거리를 재서
  `radius` 안에 있을 때만 서버에 체크인을 요청합니다.
