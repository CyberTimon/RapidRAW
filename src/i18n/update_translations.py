import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "de": {
        "settings": {
            "keybinds": {
                "actions": {
                    "toggle_folder_tree": "Ordnerstruktur-Panel ein-/ausblenden"
                }
            }
        }
    },
    "en": {
        "settings": {
            "keybinds": {
                "actions": {
                    "toggle_folder_tree": "Toggle Folder Tree panel"
                }
            }
        }
    },
    "es": {
        "settings": {
            "keybinds": {
                "actions": {
                    "toggle_folder_tree": "Alternar panel de árbol de carpetas"
                }
            }
        }
    },
    "fr": {
        "settings": {
            "keybinds": {
                "actions": {
                    "toggle_folder_tree": "Afficher/Masquer le panneau d'arborescence des dossiers"
                }
            }
        }
    },
    "it": {
        "settings": {
            "keybinds": {
                "actions": {
                    "toggle_folder_tree": "Mostra/Nascondi pannello albero delle cartelle"
                }
            }
        }
    },
    "ja": {
        "settings": {
            "keybinds": {
                "actions": {
                    "toggle_folder_tree": "フォルダーツリーパネルの切り替え"
                }
            }
        }
    },
    "ko": {
        "settings": {
            "keybinds": {
                "actions": {
                    "toggle_folder_tree": "폴더 트리 패널 토글"
                }
            }
        }
    },
    "pl": {
        "settings": {
            "keybinds": {
                "actions": {
                    "toggle_folder_tree": "Przełącz panel drzewa folderów"
                }
            }
        }
    },
    "pt": {
        "settings": {
            "keybinds": {
                "actions": {
                    "toggle_folder_tree": "Alternar painel da árvore de pastas"
                }
            }
        }
    },
    "ru": {
        "settings": {
            "keybinds": {
                "actions": {
                    "toggle_folder_tree": "Показать/скрыть панель дерева папок"
                }
            }
        }
    },
    "zh-CN": {
        "settings": {
            "keybinds": {
                "actions": {
                    "toggle_folder_tree": "切换文件夹树面板"
                }
            }
        }
    },
    "zh-TW": {
        "settings": {
            "keybinds": {
                "actions": {
                    "toggle_folder_tree": "切換資料夾樹面板"
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

    print("Starting Folder Tree keybind translation updates...")
    for lang, trans in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, trans)
    print("Done!")

if __name__ == "__main__":
    main()
