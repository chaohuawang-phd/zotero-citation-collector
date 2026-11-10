"""Build the Zotero extension from its JavaScript modules, using only Python's standard library."""

from pathlib import Path
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist" / "Citation-Collector-Zotero10.xpi"


def javascript(*names):
    return b"\n\n".join((ROOT / "src" / f"{name}.js").read_bytes() for name in names)


def main():
    runtime = javascript("precision", "reader", "review", "resolve", "fulltext")
    interface = javascript("picker", "controller")
    script = runtime + b"\n\n\n\n" + interface
    files = {"manifest.json": (ROOT / "manifest.json").read_bytes(), "bootstrap.js": script}
    OUTPUT.parent.mkdir(exist_ok=True)
    with NamedTemporaryFile(dir=OUTPUT.parent, suffix=".tmp", delete=False) as handle:
        staged = Path(handle.name)
    try:
        with ZipFile(staged, "w") as archive:
            for name, data in files.items():
                info = ZipInfo(name, (2026, 11, 10, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data, compress_type=ZIP_DEFLATED)
        with ZipFile(staged) as archive:
            if archive.testzip() is not None:
                raise ValueError("XPI integrity check failed")
        staged.chmod(0o644)
        staged.replace(OUTPUT)
    finally:
        if staged.exists():
            staged.unlink()
    print(OUTPUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
