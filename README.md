# auto-trade

증권사 Open API 기반 자동매매 프로젝트 (TypeScript, pnpm 모노레포).
`BROKER` 로 증권사를 고릅니다. 기본값은 [메리츠증권](https://openapi.imeritz.com)이고, [토스증권](https://developers.tossinvest.com)은 조회 전용 클라이언트만 있습니다(추가 개발 예정).

> 현재는 **dry-run 전용**입니다. 주문은 증권사로 보내지 않고 로컬 SQLite 에 가상 체결로만 기록합니다.
> `DRY_RUN=false` 로 실행하면 봇이 시작을 거부합니다.

## 구성

| 경로 | 역할 |
| --- | --- |
| `packages/core` | 메리츠·토스 API 클라이언트, 전략, 리스크 관리, SQLite 기록(ledger), dry-run 브로커 |
| `apps/bot` | 상시 실행 워커 (`main.ts`), 조회 전용 연동 테스트 (`check-connection.ts`) |
| `apps/web` | Nuxt + shadcn-vue 대시보드: 포지션, 체결 내역, 손익, kill switch |

봇과 대시보드는 별도 프로세스이고 `data/` 의 SQLite 파일과 kill switch 파일을 같이 봅니다. 대시보드를 재시작해도 매매는 끊기지 않습니다.

## 준비

**메리츠증권 (`BROKER=meritz`, 기본값)**

1. 메리츠증권 계좌 개설
2. [Open API 포털](https://openapi.imeritz.com) 로그인 > API 신청 > 계좌 선택 후 약정
3. 신청현황에서 App Key / App Secret 발급 → `MERITZ_APP_KEY` / `MERITZ_APP_SECRET`
4. 모든 요청에 `mac_address` 헤더(12자리)가 필요합니다. `MERITZ_MAC_ADDRESS` 가 비어 있으면 PC 의 네트워크 MAC 을 자동으로 씁니다.

종목은 국내 `005930`, 미국 `AAPL.OQ` 처럼 거래소 코드를 붙입니다 (OQ 나스닥, NY 뉴욕, AX 아멕스).

시세는 기본으로 WebSocket 실시간 체결가를 씁니다(`MERITZ_FEED=ws`). 최근 60초 동안 체결이 없거나 연결이 끊긴 종목은 REST 현재가로 대신 조회하고, 끊기면 자동으로 다시 연결합니다. `MERITZ_FEED=rest` 면 REST 만 씁니다.

**토스증권 (`BROKER=toss`)**

1. 토스증권 WTS > 설정 > Open API 에서 `client_id` / `client_secret` 발급 → `TOSS_CLIENT_ID` / `TOSS_CLIENT_SECRET`
2. 같은 화면의 **허용 IP 관리**에 봇을 돌릴 PC 의 공인 IP 등록 (미등록 시 403)

**설정** (Node 22.13+, pnpm)

```bash
pnpm install
cp .env.example .env   # 값 채우기
```

## 실행

```bash
pnpm check:connection          # 선택한 증권사 조회 전용 연동 테스트 (주문 없음)
pnpm bot:simulate              # API 키 없이 가상 시세로 dry-run
pnpm bot                       # 실제 시세로 dry-run (정규장 시간에만 동작)
pnpm bot --ignore-market-hours # 장 시간과 무관하게 실제 시세로 dry-run
pnpm dev:web                   # 대시보드 개발 서버 (http://localhost:3000)
```

`--steps N`, `--poll-seconds S` 로 반복 횟수와 주기를 바꿀 수 있습니다.

## 백테스트 (과거 일봉)

```bash
pnpm backtest --symbols 005930,000660,AAPL.OQ --from 2020-01-01 --to 2025-12-31 --budget 10000000 --max-order 10000000
```

- 실제 봇과 같은 전략·리스크 한도·가상 체결 코드로 과거 종가를 하루씩 넘기며 돌립니다. 신호가 난 날 종가로 체결합니다.
- 메리츠 일봉(수정주가)을 씁니다. 국내는 1995년, 미국은 2016년부터 있습니다. 받은 일봉은 `BACKTEST_DB_PATH`(기본 `data/backtest.sqlite3`)에 저장해 다시 받지 않습니다.
- 옵션을 안 주면 `.env` 값(`STRATEGY`, `SMA_*`, `ORDER_BUDGET_KRW`, `MAX_*`, `FEE_RATE`, `KR_SELL_TAX_RATE`)을 씁니다. 미국 종목은 실행 시점 환율 하나로 계산합니다(`--fx` 로 지정 가능).
- 결과는 대시보드 `/backtests` 에서 종목별 수익률, 그냥 보유했을 때 수익률, 최대 낙폭, 승률, 손익 추이, 거래 내역으로 봅니다.
- Docker: `docker compose run --rm backtest --symbols 005930 --from 2020-01-01`
- 주의: 지금 상장된 종목만 조회되므로 상장폐지 종목이 빠져 결과가 좋게 나올 수 있습니다(생존 편향). 슬리피지는 넣지 않았습니다.

분봉은 메리츠 API에서 최근 40개만 받을 수 있어 과거 분봉 백테스트는 안 됩니다. 대신 봇이 WebSocket 체결로 1분봉을 만들어 `DB_PATH`의 `minute_bars` 테이블에 쌓습니다(`RECORD_MINUTE_BARS=true`, 기본값). 대시보드 첫 화면에서 저장 현황을 볼 수 있습니다.

## 안전장치

| 설정 | 기본값 | 동작 |
| --- | --- | --- |
| `ORDER_BUDGET_KRW` | 100000 | 매수 1회 예산 (USD 종목은 실시간 환율로 환산) |
| `MAX_ORDER_KRW` | 200000 | 이 금액을 넘는 매수 차단 |
| `MAX_DAILY_LOSS_KRW` | 50000 | 오늘 실현+평가 손익이 이 이하로 떨어지면 매수 차단 (매도는 허용) |
| `MAX_ORDERS_PER_DAY` | 10 | 하루 매수 횟수 제한 (매도는 허용) |
| `KILL_SWITCH_PATH` | `data/KILL` | 파일이 있으면 모든 매매 중지. 대시보드 토글 또는 `touch data/KILL` |

주문마다 고유 `clientOrderId` 를 만들고 같은 ID 의 중복 체결은 거부합니다.

## 집 PC / 미니PC 에서 상시 운영 (Docker)

```bash
cp .env.example .env   # 값 채우기
docker compose up -d --build     # bot + web
docker compose logs -f bot
docker compose run --rm check    # 조회 전용 연동 테스트
```

- 대시보드: http://localhost:3000 . 같은 공유기의 다른 기기에서 보려면 `.env` 에 `DASHBOARD_BIND=0.0.0.0` 과 `DASHBOARD_PASSWORD` 를 설정하세요 (Basic 인증, 사용자명은 아무거나).
- 데이터는 `./data` 에 남습니다.
- 같은 키로 봇을 여러 개 띄우지 마세요 (토스는 재발급 시 이전 토큰이 무효화됩니다).

## 테스트

```bash
pnpm test        # Vitest
pnpm typecheck
pnpm build       # 대시보드 빌드
```

GitHub Actions(`.github/workflows/ci.yml`)가 PR/`main` push 마다 위 3개, 가상 시세 dry-run, `docker build` 를 실행합니다.
Actions 에서는 실제 증권사 API 를 호출하지 않습니다.
