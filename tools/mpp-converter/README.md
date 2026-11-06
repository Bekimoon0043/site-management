# MS Project (.mpp) converter

Browsers can't read binary MS Project files. This small local service converts `.mpp` (and other formats
[MPXJ](https://www.mpxj.org)'s `UniversalProjectReader` understands: `.mpt`, `.mpx`, Primavera `.xer`, Asta `.pp`,
ProjectLibre `.pod`, GanttProject `.gan`, …) to MS Project XML (MSPDI). The web console's schedule import wizard
posts the file here and parses the returned XML exactly like an uploaded `.xml`.

Run it on the office PC (the machine that serves the console on the LAN, or any PC reachable from the browsers).

## Endpoints

| Method | Path | |
|---|---|---|
| GET | `/health` | `{ok, mpxj_version, java, max_mb}` — no auth |
| POST | `/convert` | raw file body (`Content-Type: application/octet-stream`, `X-Filename: <name>`, `Authorization: Bearer <Supabase access token>`) → `application/xml` (MSPDI). 400 `{error}` unreadable file, 401 bad/expired token, 413 over 60 MB, 502 Supabase unreachable |

## Setup from scratch (Windows)

1. Java 11+ (e.g. Temurin 17). The start scripts use `%USERPROFILE%\android-toolchain\jdk17` when `JAVA_HOME` is not set.
2. Python 3.10+:

   ```
   cd tools\mpp-converter
   python -m venv .venv
   .venv\Scripts\pip install -r requirements.txt      (= mpxj==16.10.0 JPype1)
   ```
3. Start: `start-converter.cmd` (Windows) or `./start-converter.sh` (Git Bash / Linux / macOS).
   They read `SUPABASE_URL` / `SUPABASE_ANON_KEY` from `web/.env` (`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`)
   unless already set in the environment. The JVM starts once (warm); a 3 MB .mpp converts in a few seconds.
4. Windows Firewall: allow inbound TCP 8787 on the Private network, e.g. (admin prompt)
   `netsh advfirewall firewall add rule name="MPP converter" dir=in action=allow protocol=TCP localport=8787 profile=private`
5. Web: by default the console calls `http(s)://<same host as the page>:8787`. Override with
   `VITE_MPP_CONVERTER_URL` in `web/.env`. The Upload step shows "MS Project (.mpp) converter: online/offline".

One-off CLI: `.venv\Scripts\python mpp_convert.py "Master Schedule.mpp" out.xml`.

## Environment

`MPP_PORT` (8787), `MPP_HOST` (0.0.0.0), `MPP_MAX_MB` (60), `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`MPP_ALLOWED_ORIGINS` (comma-separated, default `*`).

## Security notes

- Every `/convert` needs a valid Supabase session: the token is checked against `${SUPABASE_URL}/auth/v1/user`
  (valid tokens cached 60 s, by SHA-256 hash). Without `SUPABASE_URL` all conversions are refused.
- Conversion runs in memory (Java byte streams); uploads are not written to disk by the server, and neither file
  contents nor tokens are logged (only sizes, timings and status codes).
- Conversions are serialised (one JVM). Uploads above 60 MB are rejected before the body is read.
- Plain HTTP: keep it on the office LAN. Set `MPP_ALLOWED_ORIGINS` to the console origin(s) outside dev.
  A console served over https (hosted) can't call an http converter (mixed content) — put it behind https
  or use File → Save As → XML in MS Project.
- MPXJ parses untrusted files; keep `mpxj` / Java updated.
