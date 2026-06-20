import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "de": "Schnellfilter",
    "en": "Quick Filter",
    "es": "Filtro rápido",
    "fr": "Filtre rapide",
    "it": "Filtro rapido",
    "ja": "クイックフィルター",
    "ko": "빠른 필터",
    "pl": "Szybki filtr",
    "pt": "Filtro rápido",
    "ru": "Быстрый фильтр",
    "zh-CN": "快速筛选",
    "zh-TW": "快速篩選"
}

def sort_dict_recursively(item):
    """Recursively sorts dictionary keys alphabetically."""
    if isinstance(item, dict):
        return {k: sort_dict_recursively(v) for k, v in sorted(item.items())}
    elif isinstance(item, list):
        return [sort_dict_recursively(x) for x in item]
    return item

def update_json_file(file_path: Path, value: str):
    if not file_path.exists():
        print(f"Skipping: {file_path.name} (File not found)")
        return

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError:
        print(f"Error parsing JSON in {file_path.name}. Skipping.")
        return

    if "ui" not in data or not isinstance(data["ui"], dict):
        data["ui"] = {}
    if "bottomBar" not in data["ui"] or not isinstance(data["ui"]["bottomBar"], dict):
        data["ui"]["bottomBar"] = {}
    if "tooltips" not in data["ui"]["bottomBar"] or not isinstance(data["ui"]["bottomBar"]["tooltips"], dict):
        data["ui"]["bottomBar"]["tooltips"] = {}

    data["ui"]["bottomBar"]["tooltips"]["quickFilter"] = value

    sorted_data = sort_dict_recursively(data)

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(sorted_data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Updated and Sorted: {file_path.name}")

def main():
    if not LOCALES_DIR.exists():
        print(f"Error: Locales directory '{LOCALES_DIR}' does not exist.")
        return

    print("Starting sorted translation updates...")
    for lang, translation in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, translation)
    print("Done!")

if __name__ == "__main__":
    main()
