import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "de": {
        "masks": {
            "clone": "Klonen",
            "heal": "Reparieren"
        },
        "ai": {
            "manualCleanupTitle": "Manuelle Bereinigung",
            "generativeEditTitle": "Generative Bearbeitung",
            "patches_clone": "Klonen {{count}}",
            "patches_heal": "Reparieren {{count}}"
        }
    },
    "en": {
        "masks": {
            "clone": "Clone",
            "heal": "Heal"
        },
        "ai": {
            "manualCleanupTitle": "Manual Cleanup",
            "generativeEditTitle": "Generative Edit",
            "patches_clone": "Clone {{count}}",
            "patches_heal": "Heal {{count}}"
        }
    },
    "es": {
        "masks": {
            "clone": "Clonar",
            "heal": "Curar"
        },
        "ai": {
            "manualCleanupTitle": "Limpieza manual",
            "generativeEditTitle": "Edición generativa",
            "patches_clone": "Clonar {{count}}",
            "patches_heal": "Curar {{count}}"
        }
    },
    "fr": {
        "masks": {
            "clone": "Cloner",
            "heal": "Corriger"
        },
        "ai": {
            "manualCleanupTitle": "Nettoyage manuel",
            "generativeEditTitle": "Édition générative",
            "patches_clone": "Cloner {{count}}",
            "patches_heal": "Corriger {{count}}"
        }
    },
    "it": {
        "masks": {
            "clone": "Clona",
            "heal": "Ripara"
        },
        "ai": {
            "manualCleanupTitle": "Pulizia manuale",
            "generativeEditTitle": "Modifica generativa",
            "patches_clone": "Clona {{count}}",
            "patches_heal": "Ripara {{count}}"
        }
    },
    "ja": {
        "masks": {
            "clone": "クローン",
            "heal": "修復"
        },
        "ai": {
            "manualCleanupTitle": "手動クリーンアップ",
            "generativeEditTitle": "生成編集",
            "patches_clone": "クローン {{count}}",
            "patches_heal": "修復 {{count}}"
        }
    },
    "ko": {
        "masks": {
            "clone": "복제",
            "heal": "복구"
        },
        "ai": {
            "manualCleanupTitle": "수동 정리",
            "generativeEditTitle": "생성형 편집",
            "patches_clone": "복제 {{count}}",
            "patches_heal": "복구 {{count}}"
        }
    },
    "pl": {
        "masks": {
            "clone": "Klonowanie",
            "heal": "Naprawianie"
        },
        "ai": {
            "manualCleanupTitle": "Ręczne czyszczenie",
            "generativeEditTitle": "Edycja generatywna",
            "patches_clone": "Klonowanie {{count}}",
            "patches_heal": "Naprawianie {{count}}"
        }
    },
    "pt": {
        "masks": {
            "clone": "Clonar",
            "heal": "Restaurar"
        },
        "ai": {
            "manualCleanupTitle": "Limpeza Manual",
            "generativeEditTitle": "Edição Generativa",
            "patches_clone": "Clonar {{count}}",
            "patches_heal": "Restaurar {{count}}"
        }
    },
    "ru": {
        "masks": {
            "clone": "Штамп",
            "heal": "Восстановление"
        },
        "ai": {
            "manualCleanupTitle": "Ручная очистка",
            "generativeEditTitle": "Генеративное редактирование",
            "patches_clone": "Штамп {{count}}",
            "patches_heal": "Восстановление {{count}}"
        }
    },
    "zh-CN": {
        "masks": {
            "clone": "克隆",
            "heal": "修复"
        },
        "ai": {
            "manualCleanupTitle": "手动清理",
            "generativeEditTitle": "生成式编辑",
            "patches_clone": "克隆 {{count}}",
            "patches_heal": "修复 {{count}}"
        }
    },
    "zh-TW": {
        "masks": {
            "clone": "仿製",
            "heal": "修復"
        },
        "ai": {
            "manualCleanupTitle": "手動清理",
            "generativeEditTitle": "生成式編輯",
            "patches_clone": "仿製 {{count}}",
            "patches_heal": "修復 {{count}}"
        }
    }
}

def sort_dict_recursively(item):
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

    # masks -> types -> clone / heal
    masks_node = data.setdefault("masks", {})
    types_node = masks_node.setdefault("types", {})
    types_node["clone"] = trans["masks"]["clone"]
    types_node["heal"] = trans["masks"]["heal"]

    # editor -> ai -> title translations
    editor_node = data.setdefault("editor", {})
    ai_node = editor_node.setdefault("ai", {})
    ai_node["manualCleanupTitle"] = trans["ai"]["manualCleanupTitle"]
    ai_node["generativeEditTitle"] = trans["ai"]["generativeEditTitle"]

    # editor -> ai -> patches -> clone / heal
    patches_node = ai_node.setdefault("patches", {})
    patches_node["clone"] = trans["ai"]["patches_clone"]
    patches_node["heal"] = trans["ai"]["patches_heal"]

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
