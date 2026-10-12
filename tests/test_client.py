import pytest
import responses

from toss_autotrade.client import BASE_URL, TossApiError, TossClient


@pytest.fixture
def client():
    return TossClient(client_id="id", client_secret="secret")


def _token(rsps):
    rsps.add(
        responses.POST,
        f"{BASE_URL}/oauth2/token",
        json={"access_token": "tok", "token_type": "Bearer", "expires_in": 86400},
    )


@responses.activate
def test_prices_uses_bearer_token(client):
    _token(responses)
    responses.add(
        responses.GET,
        f"{BASE_URL}/api/v1/prices",
        json={"result": [{"symbol": "005930", "lastPrice": "72000", "currency": "KRW"}]},
    )
    result = client.get_prices(["005930"])
    assert result[0]["lastPrice"] == "72000"
    assert responses.calls[1].request.headers["Authorization"] == "Bearer tok"
    assert "symbols=005930" in responses.calls[1].request.url


@responses.activate
def test_token_is_reused(client):
    _token(responses)
    responses.add(responses.GET, f"{BASE_URL}/api/v1/accounts", json={"result": []})
    client.get_accounts()
    client.get_accounts()
    assert sum(c.request.url.endswith("/oauth2/token") for c in responses.calls) == 1


@responses.activate
def test_account_header(client):
    client.account_seq = 3
    _token(responses)
    responses.add(responses.GET, f"{BASE_URL}/api/v1/holdings", json={"result": {"items": []}})
    client.get_holdings()
    assert responses.calls[1].request.headers["X-Tossinvest-Account"] == "3"


def test_account_api_requires_account_seq(client, monkeypatch):
    monkeypatch.setattr(client, "_access_token", lambda: "tok")
    with pytest.raises(ValueError):
        client.get_holdings()


@responses.activate
def test_error_envelope(client):
    _token(responses)
    responses.add(
        responses.GET,
        f"{BASE_URL}/api/v1/prices",
        status=403,
        json={"error": {"requestId": "r1", "code": "ip-not-allowed", "message": "허용되지 않은 IP"}},
    )
    with pytest.raises(TossApiError) as e:
        client.get_prices(["005930"])
    assert e.value.code == "ip-not-allowed"
    assert e.value.request_id == "r1"


@responses.activate
def test_token_error(client):
    responses.add(
        responses.POST,
        f"{BASE_URL}/oauth2/token",
        status=401,
        json={"error": "invalid_client", "error_description": "Client authentication failed: client_secret"},
    )
    with pytest.raises(TossApiError) as e:
        client.issue_token()
    assert e.value.code == "invalid_client"


@responses.activate
def test_retries_on_429(client, monkeypatch):
    monkeypatch.setattr("toss_autotrade.client.time.sleep", lambda s: None)
    _token(responses)
    responses.add(
        responses.GET, f"{BASE_URL}/api/v1/accounts", status=429, headers={"Retry-After": "1"}, json={}
    )
    responses.add(responses.GET, f"{BASE_URL}/api/v1/accounts", json={"result": [{"accountSeq": 1}]})
    assert client.get_accounts() == [{"accountSeq": 1}]
