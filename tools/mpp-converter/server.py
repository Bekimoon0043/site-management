"""Local MS Project (.mpp) -> MS Project XML (MSPDI) converter for the web console's schedule import wizard.

stdlib-only HTTP server around mpp_convert.convert_bytes (MPXJ via JPype, one warm JVM).

    GET  /health   -> {"ok": true, "mpxj_version": "...", "java": "..."}           (no auth)
    POST /convert  -> MSPDI XML (application/xml)
                      body: raw file bytes, header X-Filename: <original name>,
                      Authorization: Bearer <Supabase access token>

Environment:
    MPP_PORT               port (default 8787), bound on MPP_HOST (default 0.0.0.0)
    SUPABASE_URL           Supabase project URL used to validate access tokens (/auth/v1/user)
    SUPABASE_ANON_KEY      anon key sent as `apikey` with the validation call
    MPP_ALLOWED_ORIGINS    comma-separated CORS origins, or * (default *, fine for LAN dev)
    MPP_MAX_MB             max upload size in MB (default 60)

Uploads are converted in memory (Java byte-array streams) and never written to disk by this server.
File contents and tokens are never logged.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mpp_convert  # noqa: E402

PORT = int(os.environ.get("MPP_PORT", "8787"))
HOST = os.environ.get("MPP_HOST", "0.0.0.0")
MAX_BYTES = int(float(os.environ.get("MPP_MAX_MB", "60")) * 1024 * 1024)
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
ALLOWED_ORIGINS = [o.strip().rstrip("/") for o in os.environ.get("MPP_ALLOWED_ORIGINS", "*").split(",") if o.strip()]
TOKEN_TTL = 60.0

# Extensions MPXJ's UniversalProjectReader understands (it sniffs content; the suffix is only a hint).
READABLE = {
    "mpp", "mpt", "mpx", "xml", "xer", "pmxml", "pp", "pod", "gan", "planner", "sdef", "fts", "cdpx", "cdpz",
    "cdp", "mpd", "prx", "stx", "pep", "ppx", "zip", "gnt", "json", "mdb", "db", "sp", "spx", "schedule",
}

_convert_lock = threading.Lock()  # one JVM, one conversion at a time
_token_cache: dict[str, float] = {}  # sha256(token) -> expiry (monotonic)
_token_lock = threading.Lock()
_info: dict[str, str] = {}


def _log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def token_valid(token: str) -> bool:
    """True when Supabase accepts the access token (cached for TOKEN_TTL seconds)."""
    if not token or not SUPABASE_URL:
        return False
    key = hashlib.sha256(token.encode()).hexdigest()
    now = time.monotonic()
    with _token_lock:
        exp = _token_cache.get(key)
        if exp and exp > now:
            return True
        for k in [k for k, e in _token_cache.items() if e <= now]:
            del _token_cache[k]
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={"Authorization": f"Bearer {token}", "apikey": SUPABASE_ANON_KEY or token},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            body = json.loads(r.read() or b"{}")
            ok = r.status == 200 and bool(body.get("id"))
    except urllib.error.HTTPError:
        ok = False
    except (urllib.error.URLError, OSError, ValueError) as e:
        _log(f"auth check failed: {type(e).__name__}")
        raise ConnectionError("Could not reach Supabase to check the sign-in") from e
    if ok:
        with _token_lock:
            _token_cache[key] = now + TOKEN_TTL
    return ok


def _suffix(name: str) -> str:
    ext = os.path.splitext(name)[1].lower().lstrip(".")
    return "." + ext if re.fullmatch(r"[a-z0-9]{1,8}", ext or "") else ".mpp"


class Handler(BaseHTTPRequestHandler):
    server_version = "mpp-converter/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # request line only (no bodies / headers)
        _log(f"{self.address_string()} {fmt % args}")

    # --- helpers -------------------------------------------------------------------------------------------
    def _cors(self) -> None:
        origin = (self.headers.get("Origin") or "").rstrip("/")
        if "*" in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin or "*")
        elif origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")

    def _send(self, status: int, body: bytes, ctype: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, obj: dict, close: bool = False) -> None:
        if close:
            self.close_connection = True
        self._send(status, json.dumps(obj).encode(), "application/json", {"Connection": "close"} if close else None)

    def _drain(self, length: int) -> None:
        while length > 0:
            chunk = self.rfile.read(min(length, 1 << 20))
            if not chunk:
                break
            length -= len(chunk)

    def _origin_ok(self) -> bool:
        origin = (self.headers.get("Origin") or "").rstrip("/")
        return not origin or "*" in ALLOWED_ORIGINS or origin in ALLOWED_ORIGINS

    # --- routes --------------------------------------------------------------------------------------------
    def do_OPTIONS(self) -> None:
        self.send_response(204 if self._origin_ok() else 403)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, X-Filename, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        if self.headers.get("Access-Control-Request-Private-Network"):
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in ("/health", "/"):
            self._json(200, {"ok": True, **_info, "max_mb": MAX_BYTES // (1024 * 1024)})
        else:
            self._json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/convert":
            return self._json(404, {"error": "Not found"}, close=True)
        if not self._origin_ok():
            return self._json(403, {"error": "Origin not allowed"}, close=True)
        try:
            length = int(self.headers.get("Content-Length") or "-1")
        except ValueError:
            length = -1
        if length < 0:
            return self._json(411, {"error": "Content-Length required"}, close=True)
        if length > MAX_BYTES:
            return self._json(413, {"error": f"File is larger than {MAX_BYTES // (1024 * 1024)} MB"}, close=True)

        auth = self.headers.get("Authorization") or ""
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        try:
            if not token_valid(token):
                self._drain(length)  # read (and discard) the upload so the browser sees the 401, not a reset
                return self._json(401, {"error": "Not signed in or the session has expired. Sign in again."}, close=True)
        except ConnectionError as e:
            self._drain(length)
            return self._json(502, {"error": str(e)}, close=True)

        name = self.headers.get("X-Filename") or "upload.mpp"
        if length == 0:
            return self._json(400, {"error": "Empty file"})
        data = self.rfile.read(length)
        if len(data) != length:
            return self._json(400, {"error": "Upload was cut short"}, close=True)

        t0 = time.monotonic()
        try:
            with _convert_lock:
                xml = mpp_convert.convert_bytes(data, _suffix(name))
        except Exception as e:  # MPXJ / Java exceptions for unreadable or unsupported files
            msg = str(e).strip().splitlines()[0][:200] if str(e).strip() else type(e).__name__
            _log(f"convert failed ({len(data):,} bytes): {type(e).__name__}")
            return self._json(400, {"error": f"Could not read this file as a project schedule ({msg})."})
        finally:
            del data
        _log(f"converted {len(xml):,} bytes of XML in {time.monotonic() - t0:.1f}s")
        self._send(200, xml, "application/xml; charset=utf-8")


def main() -> int:
    if not SUPABASE_URL:
        print("SUPABASE_URL is not set — every /convert request will be rejected (401).", file=sys.stderr)
    t0 = time.monotonic()
    mpp_convert.start()
    try:
        from importlib.metadata import version

        _info["mpxj_version"] = version("mpxj")
    except Exception:
        _info["mpxj_version"] = "unknown"
    _info["java"] = mpp_convert.java_version()
    _log(f"JVM ready in {time.monotonic() - t0:.1f}s · MPXJ {_info['mpxj_version']} · Java {_info['java']}")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    _log(f"listening on http://{HOST}:{PORT}  (auth: {SUPABASE_URL or 'NOT CONFIGURED'}, origins: {','.join(ALLOWED_ORIGINS)})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
