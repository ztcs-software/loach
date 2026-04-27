import sys
from pypdf import PdfReader

sys.stdout.reconfigure(encoding="utf-8")
r = PdfReader(r"C:\Users\Andrzej\Desktop\Loach\Loach-UX-Enhancements.pdf")
print(f"Pages: {len(r.pages)}")
for i, p in enumerate(r.pages):
    print(f"\n=== Page {i + 1} ===")
    text = p.extract_text() or ""
    print(text[:350])
