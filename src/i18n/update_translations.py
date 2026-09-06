import json
from pathlib import Path

LOCALES_DIR = Path("./locales")

TRANSLATIONS = {
    "ca": {
        "export": {
            "sections": {
                "destination": "Destinació"
            },
            "destination": {
                "customFolder": "Carpeta personalitzada",
                "originalFolder": "Carpeta de la imatge original",
                "subfolder": "Subcarpeta",
                "subfolderPlaceholder": "p. ex. final, WebP"
            }
        }
    },
    "de": {
        "export": {
            "sections": {
                "destination": "Zielort"
            },
            "destination": {
                "customFolder": "Benutzerdefinierter Ordner",
                "originalFolder": "Ursprungsordner des Bildes",
                "subfolder": "Unterordner",
                "subfolderPlaceholder": "z. B. final, WebP"
            }
        }
    },
    "en": {
        "export": {
            "sections": {
                "destination": "Destination"
            },
            "destination": {
                "customFolder": "Custom folder",
                "originalFolder": "Original image folder",
                "subfolder": "Subfolder",
                "subfolderPlaceholder": "e.g. final, WebP"
            }
        }
    },
    "es": {
        "export": {
            "sections": {
                "destination": "Destino"
            },
            "destination": {
                "customFolder": "Carpeta personalizada",
                "originalFolder": "Carpeta de la imagen original",
                "subfolder": "Subcarpeta",
                "subfolderPlaceholder": "p. ej. final, WebP"
            }
        }
    },
    "fr": {
        "export": {
            "sections": {
                "destination": "Destination"
            },
            "destination": {
                "customFolder": "Dossier personnalisé",
                "originalFolder": "Dossier de l'image d'origine",
                "subfolder": "Sous-dossier",
                "subfolderPlaceholder": "ex. final, WebP"
            }
        }
    },
    "it": {
        "export": {
            "sections": {
                "destination": "Destinazione"
            },
            "destination": {
                "customFolder": "Cartella personalizzata",
                "originalFolder": "Cartella dell'immagine originale",
                "subfolder": "Sottocartella",
                "subfolderPlaceholder": "es. final, WebP"
            }
        }
    },
    "ja": {
        "export": {
            "sections": {
                "destination": "保存先"
            },
            "destination": {
                "customFolder": "カスタムフォルダー",
                "originalFolder": "元の画像フォルダー",
                "subfolder": "サブフォルダー",
                "subfolderPlaceholder": "例：final, WebP"
            }
        }
    },
    "ko": {
        "export": {
            "sections": {
                "destination": "대상"
            },
            "destination": {
                "customFolder": "사용자 지정 폴더",
                "originalFolder": "원본 이미지 폴더",
                "subfolder": "하위 폴더",
                "subfolderPlaceholder": "예: final, WebP"
            }
        }
    },
    "pl": {
        "export": {
            "sections": {
                "destination": "Miejsce docelowe"
            },
            "destination": {
                "customFolder": "Folder niestandardowy",
                "originalFolder": "Folder oryginalnego obrazu",
                "subfolder": "Podfolder",
                "subfolderPlaceholder": "np. final, WebP"
            }
        }
    },
    "pt": {
        "export": {
            "sections": {
                "destination": "Destino"
            },
            "destination": {
                "customFolder": "Pasta personalizada",
                "originalFolder": "Pasta da imagem original",
                "subfolder": "Subpasta",
                "subfolderPlaceholder": "ex. final, WebP"
            }
        }
    },
    "ru": {
        "export": {
            "sections": {
                "destination": "Место назначения"
            },
            "destination": {
                "customFolder": "Пользовательская папка",
                "originalFolder": "Папка исходного изображения",
                "subfolder": "Вложенная папка",
                "subfolderPlaceholder": "напр. final, WebP"
            }
        }
    },
    "zh-CN": {
        "export": {
            "sections": {
                "destination": "目标位置"
            },
            "destination": {
                "customFolder": "自定义文件夹",
                "originalFolder": "原始图像文件夹",
                "subfolder": "子文件夹",
                "subfolderPlaceholder": "例如：final, WebP"
            }
        }
    },
    "zh-TW": {
        "export": {
            "sections": {
                "destination": "目標位置"
            },
            "destination": {
                "customFolder": "自訂資料夾",
                "originalFolder": "原始影像資料夾",
                "subfolder": "子資料夾",
                "subfolderPlaceholder": "例如：final, WebP"
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

    # 1. Merge new translations
    deep_merge(data, trans)

    # 2. Sort alphabetically to maintain formatting consistency
    sorted_data = sort_dict_recursively(data)

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(sorted_data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Updated and Sorted: {file_path.name}")

def main():
    if not LOCALES_DIR.exists():
        print(f"Error: Locales directory '{LOCALES_DIR}' does not exist.")
        return

    print("Starting translation updates for export destination settings...")
    for lang, trans in TRANSLATIONS.items():
        file_path = LOCALES_DIR / f"{lang}.json"
        update_json_file(file_path, trans)
    print("Done!")

if __name__ == "__main__":
    main()
