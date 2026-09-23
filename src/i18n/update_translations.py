import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "ca": {
        "editor": {
            "ai": {
                "settings": {
                    "cancelGeneration": "Cancel·lar generació"
                }
            }
        }
    },
    "de": {
        "editor": {
            "ai": {
                "settings": {
                    "cancelGeneration": "Generierung abbrechen"
                }
            }
        }
    },
    "en": {
        "editor": {
            "ai": {
                "settings": {
                    "cancelGeneration": "Cancel Generation"
                }
            }
        }
    },
    "es": {
        "editor": {
            "ai": {
                "settings": {
                    "cancelGeneration": "Cancelar generación"
                }
            }
        }
    },
    "fr": {
        "editor": {
            "ai": {
                "settings": {
                    "cancelGeneration": "Annuler la génération"
                }
            }
        }
    },
    "it": {
        "editor": {
            "ai": {
                "settings": {
                    "cancelGeneration": "Annulla generazione"
                }
            }
        }
    },
    "ja": {
        "editor": {
            "ai": {
                "settings": {
                    "cancelGeneration": "生成をキャンセル"
                }
            }
        }
    },
    "ko": {
        "editor": {
            "ai": {
                "settings": {
                    "cancelGeneration": "생성 취소"
                }
            }
        }
    },
    "pl": {
        "editor": {
            "ai": {
                "settings": {
                    "cancelGeneration": "Anuluj generowanie"
                }
            }
        }
    },
    "pt": {
        "editor": {
            "ai": {
                "settings": {
                    "cancelGeneration": "Cancelar geração"
                }
            }
        }
    },
    "ru": {
        "editor": {
            "ai": {
                "settings": {
                    "cancelGeneration": "Отменить генерацию"
                }
            }
        }
    },
    "zh-CN": {
        "editor": {
            "ai": {
                "settings": {
                    "cancelGeneration": "取消生成"
                }
            }
        }
    },
    "zh-TW": {
        "editor": {
            "ai": {
                "settings": {
                    "cancelGeneration": "取消生成"
                }
            }
        }
    }
}

def deep_merge(target: dict, source: dict):
    """Recursively merges source dict into target dict."""
    for key, value in source.items():
        if isinstance(value, dict):
            node = target.setdefault(key, {})
            if isinstance(node, dict):
                deep_merge(node, value)
        else:
            target[key] = value

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

    deep_merge(data, trans)

    sorted_data = sort_dict_recursively(data)

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(sorted_data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Updated and Sorted: {file_path.name}")

def main():
    if not LOCALES_DIR.exists():
        print(f"Error: Locales directory '{LOCALES_DIR}' does not exist.")
        return

    print("Starting translation updates for Cancel Generation...")
    for lang, trans in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, trans)
    print("Done!")

if __name__ == "__main__":
    main()
