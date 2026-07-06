import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "de": {
        "done": "Fertig",
        "exporting": "Exportieren…",
        "savesTo": "Externe Bearbeitung — speichert in"
    },
    "en": {
        "done": "Done",
        "exporting": "Exporting…",
        "savesTo": "External edit — saves to"
    },
    "es": {
        "done": "Listo",
        "exporting": "Exportando…",
        "savesTo": "Edición externa: se guarda en"
    },
    "fr": {
        "done": "Terminé",
        "exporting": "Exportation…",
        "savesTo": "Modification externe — s'enregistre dans"
    },
    "it": {
        "done": "Fatto",
        "exporting": "Esportazione…",
        "savesTo": "Modifica esterna — salva in"
    },
    "ja": {
        "done": "完了",
        "exporting": "書き出し中…",
        "savesTo": "外部編集 — 保存先"
    },
    "ko": {
        "done": "완료",
        "exporting": "내보내는 중…",
        "savesTo": "외부 편집 — 저장 위치:"
    },
    "pl": {
        "done": "Gotowe",
        "exporting": "Eksportowanie…",
        "savesTo": "Zewnętrzna edycja — zapisuje do"
    },
    "pt": {
        "done": "Concluído",
        "exporting": "Exportando…",
        "savesTo": "Edição externa — salva em"
    },
    "ru": {
        "done": "Готово",
        "exporting": "Экспорт…",
        "savesTo": "Внешнее редактирование — сохраняется в"
    },
    "zh-CN": {
        "done": "完成",
        "exporting": "正在导出…",
        "savesTo": "外部编辑 — 保存至"
    },
    "zh-TW": {
        "done": "完成",
        "exporting": "正在匯出…",
        "savesTo": "外部編輯 — 儲存至"
    }
}

def sort_dict_recursively(item):
    """Recursively sorts dictionary keys alphabetically."""
    if isinstance(item, dict):
        return {k: sort_dict_recursively(v) for k, v in sorted(item.items())}
    elif isinstance(item, list):
        return [sort_dict_recursively(x) for x in item]
    return item

def update_json_file(file_path: Path, trans: dict):
    if not file_path.exists():
        print(f"Skipping: {file_path.name} (File not found)")
        return

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError:
        print(f"Error parsing JSON in {file_path.name}. Skipping.")
        return

    # Ensure the path data -> editor -> externalEdit exists
    if "editor" not in data or not isinstance(data["editor"], dict):
        data["editor"] = {}
    if "externalEdit" not in data["editor"] or not isinstance(data["editor"]["externalEdit"], dict):
        data["editor"]["externalEdit"] = {}

    ext_node = data["editor"]["externalEdit"]
    ext_node["done"] = trans["done"]
    ext_node["exporting"] = trans["exporting"]
    ext_node["savesTo"] = trans["savesTo"]

    # Sort keys alphabetically and write out
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
    for lang, trans in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, trans)
    print("Done!")

if __name__ == "__main__":
    main()
