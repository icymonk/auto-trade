"""Read-only connectivity check against the Toss Securities Open API. Never places orders."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

from toss_autotrade.client import TossApiError, TossClient

load_dotenv()


def step(name, fn):
    try:
        result = fn()
        print(f"[OK]   {name}")
        print("       " + json.dumps(result, ensure_ascii=False)[:500])
        return result
    except TossApiError as e:
        print(f"[FAIL] {name}: {e}")
    except Exception as e:
        print(f"[FAIL] {name}: {type(e).__name__}: {e}")
    return None


def main() -> int:
    client = TossClient()

    token = step("토큰 발급", lambda: {"token_type": "Bearer", "valid": client.issue_token().is_valid()})
    if token is None:
        return 1

    step("종목 정보 (005930, AAPL)", lambda: client.get_stocks(["005930", "AAPL"]))
    step("현재가 (005930, AAPL)", lambda: client.get_prices(["005930", "AAPL"]))
    step("환율 USD/KRW", client.get_exchange_rate)
    step("국내 장 운영 정보", client.get_market_calendar)

    accounts = step("계좌 목록", client.get_accounts)
    if client.account_seq is None and accounts:
        client.account_seq = accounts[0]["accountSeq"]
        print(f"       -> accountSeq={client.account_seq} 사용")
    if client.account_seq is not None:
        step("보유 주식", client.get_holdings)
        step("매수 가능 금액 (KRW)", client.get_buying_power)
    return 0


if __name__ == "__main__":
    sys.exit(main())
