"""Import the bundled example without overwriting local edits."""
from pathlib import Path
import os
import shutil

root = Path(__file__).resolve().parents[1]
source = root / "examples" / "sanxingdui"
data = Path(os.environ.get("HISTORY_DATA_DIR", str(root / "data"))).expanduser().resolve()
target = data / "projects" / "sanxingdui"
if (target / "project.json").exists():
    print("三星堆样例已存在，保留编辑结果。")
else:
    shutil.copytree(source, target, dirs_exist_ok=True)
    print("三星堆样例已导入：", target)
