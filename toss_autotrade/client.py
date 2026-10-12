import os
import time
from dataclasses import dataclass

import requests

BASE_URL = "https://openapi.tossinvest.com"


class TossApiError(Exception):
    def __init__(self, status: int, code: str, message: str, request_id: str | None = None):
        super().__init__(f"[{status}] {code}: {message} (requestId={request_id})")
        self.status = status
        self.code = code
        self.message = message
        self.request_id = request_id


@dataclass
class Token:
    access_token: str
    expires_at: float

    def is_valid(self, margin: float = 60) -> bool:
        return time.time() < self.expires_at - margin


class TossClient:
    def __init__(
        self,
        client_id: str | None = None,
        client_secret: str | None = None,
        account_seq: int | None = None,
        base_url: str = BASE_URL,
        session: requests.Session | None = None,
        timeout: float = 10,
    ):
        self.client_id = client_id or os.environ["TOSS_CLIENT_ID"]
        self.client_secret = client_secret or os.environ["TOSS_CLIENT_SECRET"]
        env_seq = os.environ.get("TOSS_ACCOUNT_SEQ")
        self.account_seq = account_seq if account_seq is not None else (int(env_seq) if env_seq else None)
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()
        self.timeout = timeout
        self._token: Token | None = None

    def issue_token(self) -> Token:
        resp = self.session.post(
            f"{self.base_url}/oauth2/token",
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            },
            timeout=self.timeout,
        )
        body = _json(resp)
        if resp.status_code != 200:
            raise TossApiError(
                resp.status_code,
                body.get("error", "unknown"),
                body.get("error_description", resp.text),
                resp.headers.get("X-Request-Id"),
            )
        self._token = Token(body["access_token"], time.time() + int(body["expires_in"]))
        return self._token

    def _access_token(self) -> str:
        if self._token is None or not self._token.is_valid():
            self.issue_token()
        return self._token.access_token

    def request(self, method: str, path: str, *, account: bool = False, max_retries: int = 3, **kwargs):
        headers = kwargs.pop("headers", {})
        headers["Authorization"] = f"Bearer {self._access_token()}"
        if account:
            if self.account_seq is None:
                raise ValueError("account_seq is required for account/order APIs")
            headers["X-Tossinvest-Account"] = str(self.account_seq)

        for attempt in range(max_retries + 1):
            resp = self.session.request(
                method, f"{self.base_url}{path}", headers=headers, timeout=self.timeout, **kwargs
            )
            if resp.status_code == 429 and attempt < max_retries:
                time.sleep(float(resp.headers.get("Retry-After", 2**attempt)))
                continue
            break

        body = _json(resp)
        if not resp.ok:
            err = body.get("error") or {}
            if not isinstance(err, dict):
                err = {"code": str(err), "message": body.get("error_description", resp.text)}
            raise TossApiError(
                resp.status_code,
                err.get("code", "unknown"),
                err.get("message", resp.text),
                err.get("requestId") or resp.headers.get("X-Request-Id"),
            )
        return body.get("result", body)

    # Market data / info (token only)
    def get_stocks(self, symbols: list[str]):
        return self.request("GET", "/api/v1/stocks", params={"symbols": ",".join(symbols)})

    def get_prices(self, symbols: list[str]):
        return self.request("GET", "/api/v1/prices", params={"symbols": ",".join(symbols)})

    def get_market_calendar(self, market: str = "KR"):
        return self.request("GET", f"/api/v1/market-calendar/{market}")

    def get_exchange_rate(self, base: str = "USD", quote: str = "KRW"):
        return self.request(
            "GET", "/api/v1/exchange-rate", params={"baseCurrency": base, "quoteCurrency": quote}
        )

    # Account / asset (token + account header)
    def get_accounts(self):
        return self.request("GET", "/api/v1/accounts")

    def get_holdings(self, symbol: str | None = None):
        params = {"symbol": symbol} if symbol else None
        return self.request("GET", "/api/v1/holdings", account=True, params=params)

    def get_buying_power(self, currency: str = "KRW"):
        return self.request("GET", "/api/v1/buying-power", account=True, params={"currency": currency})


def _json(resp: requests.Response) -> dict:
    try:
        data = resp.json()
        return data if isinstance(data, dict) else {"result": data}
    except ValueError:
        return {}
