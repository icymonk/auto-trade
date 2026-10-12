# toss-autotrade

[토스증권 Open API](https://developers.tossinvest.com) 기반 자동매매 프로젝트.

## 준비

1. 토스증권 WTS > 설정 > Open API 에서 `client_id` / `client_secret` 발급
2. 같은 화면의 **허용 IP 관리**에 API를 호출할 서버의 공인 IP 등록 (미등록 시 403)
3. 설정

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env   # 값 채우기
```

## 연동 테스트 (조회 전용, 주문 없음)

```bash
python scripts/check_connection.py
```

토큰 발급 → 종목 정보/현재가/환율/장 운영 정보 → 계좌 목록 → 보유 주식/매수 가능 금액 순으로 호출합니다.

## 단위 테스트

```bash
pytest
```
