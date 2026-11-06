"""Convert Microsoft Project .mpp (and other formats MPXJ reads) to MS Project XML (MSPDI).

The web console's schedule importer already understands MSPDI XML, so converting is all we need.
Uses MPXJ (https://www.mpxj.org) through JPype; needs a Java 11+ runtime (JAVA_HOME).

    python mpp_convert.py "Master Schedule.mpp" out.xml
"""
from __future__ import annotations

import os
import sys
import threading

_lock = threading.Lock()
_started = False


def _start_jvm() -> None:
    global _started
    with _lock:
        if _started:
            return
        import jpype
        import mpxj  # noqa: F401 — puts the bundled MPXJ jars on the JVM classpath

        if not jpype.isJVMStarted():
            jpype.startJVM(
                "-Djava.awt.headless=true",
                "-Xmx1g",
                # MPXJ bundles log4j-api without a provider; use the built-in simple logger, errors only,
                # so the "could not find a logging provider" banner is not printed.
                "-Dlog4j2.loggerContextFactory=org.apache.logging.log4j.simple.SimpleLoggerContextFactory",
                "-Dorg.apache.logging.log4j.simplelog.StatusLogger.level=OFF",
                "-Dorg.apache.logging.log4j.level=OFF",
            )
        _started = True


def start() -> None:
    """Start the JVM now (so the first conversion is not slowed by JVM start-up)."""
    _start_jvm()
    from org.mpxj.reader import UniversalProjectReader  # type: ignore  # noqa: F401 — load classes


def java_version() -> str:
    _start_jvm()
    from java.lang import System  # type: ignore

    return f"{System.getProperty('java.version')} ({System.getProperty('java.vendor')})"


def convert_bytes(data: bytes, suffix: str = ".mpp") -> bytes:
    """Return MSPDI XML for a schedule file given as bytes.

    Works in memory (Java byte-array streams), so a failed read can't leave a locked copy of the upload on
    disk. MPXJ itself only spills to its own temp files (deleted after use) for database-style formats.
    Raises ValueError for files MPXJ doesn't recognise as a schedule.
    """
    _start_jvm()
    import jpype
    from java.io import ByteArrayInputStream, ByteArrayOutputStream  # type: ignore
    from org.mpxj.reader import UniversalProjectReader  # type: ignore
    from org.mpxj.mspdi import MSPDIWriter  # type: ignore

    stream = ByteArrayInputStream(jpype.JArray(jpype.JByte)(data))
    try:
        project = UniversalProjectReader().read(stream)
    except jpype.JException as e:
        raise ValueError(str(e.getMessage() or e.getClass().getSimpleName())) from None
    finally:
        stream.close()
    if project is None:
        raise ValueError("not a recognised schedule format")
    out = ByteArrayOutputStream()
    MSPDIWriter().write(project, out)
    return bytes(out.toByteArray())


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    with open(argv[1], "rb") as f:
        xml = convert_bytes(f.read(), os.path.splitext(argv[1])[1] or ".mpp")
    with open(argv[2], "wb") as f:
        f.write(xml)
    print(f"wrote {argv[2]} ({len(xml):,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
